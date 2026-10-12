/**
 * Durable ownership registry for targets in the project-shared broker-owned
 * Chromium (`omp.browser.headless`/`omp.browser.headed`).
 *
 * The shared browser outlives any single omp process, but tab ownership is
 * otherwise tracked only in that process's memory (`tab-supervisor`'s `tabs`
 * map). When a session ends abnormally (crash, SIGKILL, cleanup timeout) its
 * in-process map dies with it and the pages it opened stay open in the shared
 * Chromium forever, accumulating into multi-GB orphan targets (issue #10022).
 *
 * This module records, on disk under the broker runtime dir, which OS process
 * created each shared-browser page target. Any live omp process can then reap
 * targets whose owning process is gone. It only ever touches OMP-owned
 * shared-browser targets — user-owned connected/relay/spawned browsers have no
 * registry and are never scanned.
 *
 * Ownership is authoritative in the safe direction: a target is reaped only
 * when its owner is definitively dead — its PID reports `ESRCH`, or the PID is
 * now held by a process whose start time differs from the one recorded in the
 * owner file (PID reuse). Owner files written before start times were recorded
 * fall back to the PID probe alone. A live owner is never reaped, and an
 * unreadable start time counts as alive, so a live session's tabs cannot be
 * yanked out from under it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { Browser } from "puppeteer-core";
import { daemonRuntimeDir } from "../../launch/paths";
import { processStartTime } from "./launch-ledger";

/** Identifies one shared-browser daemon's target registry. */
export interface SharedTargetScope {
	/** Canonical project directory owning the broker (as stamped on the handle). */
	projectDir: string;
	/** Broker daemon name, e.g. `omp.browser.headless`. */
	daemonName: string;
}

/** On-disk ownership record: one file per owning omp process. */
interface OwnershipFile {
	pid: number;
	/** `ps -o lstart=` of `pid` when written; absent in files from older versions (pid-only liveness). */
	startTime?: string;
	updatedAt: number;
	targets: string[];
}

/**
 * Reap only records whose owner has been dead AND untouched for this long.
 * The PID probe is already authoritative; the grace window is a conservative
 * guard against clock skew and PID reuse races, and keeps a just-crashed
 * process's very fresh records around briefly in case it is being restarted.
 */
const DEFAULT_GRACE_MS = 15_000;

/** In-process set of shared-browser targets this process created, keyed by registry dir. */
const ownedByDir = new Map<string, Set<string>>();
/** Per-registry-dir write serialization so concurrent record/forget can't tear the file. */
const writeChains = new Map<string, Promise<void>>();

function registryDir(scope: SharedTargetScope): string {
	return path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`);
}

/** Serialize a write against others for the same registry dir. */
function chain(dir: string, task: () => Promise<void>): Promise<void> {
	const prev = writeChains.get(dir) ?? Promise.resolve();
	const next = prev.then(task, task);
	writeChains.set(
		dir,
		next.catch(() => undefined),
	);
	return next;
}

let selfStartTime: Promise<string | undefined> | undefined;

/** This process's start time, resolved once; undefined where unavailable. */
function ownStartTime(): Promise<string | undefined> {
	selfStartTime ??= processStartTime(process.pid);
	return selfStartTime;
}

/**
 * Start resolving this process's start time now, so the first ownership write does not wait on a
 * `ps` spawn. A process killed right after its first shared tab opens then still leaves its file.
 */
export function primeOwnerIdentity(): void {
	void ownStartTime();
}

/** Persist (or, when empty, remove) this process's ownership file for a registry dir. */
async function flush(dir: string): Promise<void> {
	const owned = ownedByDir.get(dir);
	const file = path.join(dir, `${process.pid}.json`);
	if (!owned || owned.size === 0) {
		await fs.rm(file, { force: true }).catch(error => {
			// A stale record is reaped later (its targets are gone), but say why it stayed.
			logger.warn("Failed to remove shared-browser target ownership file", {
				file,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return;
	}
	const record: OwnershipFile = {
		pid: process.pid,
		startTime: await ownStartTime(),
		updatedAt: Date.now(),
		targets: [...owned],
	};
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(tmp, JSON.stringify(record));
	await fs.rename(tmp, file);
}

/**
 * Record that this process created `targetId` in the given shared browser. Rejects when the ownership
 * file cannot be written, after dropping the id from memory: a target no survivor can discover must
 * not be reported as durably owned.
 */
export async function recordSharedTarget(scope: SharedTargetScope, targetId: string): Promise<void> {
	const dir = registryDir(scope);
	let owned = ownedByDir.get(dir);
	if (!owned) {
		owned = new Set();
		ownedByDir.set(dir, owned);
	}
	owned.add(targetId);
	try {
		await chain(dir, () => flush(dir));
	} catch (err) {
		owned.delete(targetId);
		throw err;
	}
}

/** Drop `targetId` from this process's ownership file (closed the normal way). */
export async function forgetSharedTarget(scope: SharedTargetScope, targetId: string): Promise<void> {
	const dir = registryDir(scope);
	const owned = ownedByDir.get(dir);
	if (!owned?.delete(targetId)) return;
	await chain(dir, () => flush(dir)).catch(err =>
		logger.debug("Failed to update shared-browser target ownership", {
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

/** True when `pid` names a live process; non-`ESRCH` probe failures are treated as alive (safe direction). */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Whether the owner recorded as `(pid, startTime)` is still running. Dead when the pid is gone, or
 * when it now belongs to a process with a different start time. Every uncertain case is alive.
 */
async function isOwnerAlive(pid: number, startTime: string | undefined): Promise<boolean> {
	if (!isPidAlive(pid)) return false;
	if (startTime === undefined) return true;
	const current = await processStartTime(pid);
	return current === undefined || current === startTime;
}

/** Options for {@link collectOrphanTargets}; the defaults hit the real registry, the seams are for tests. */
export interface CollectOrphanOptions {
	/** Wall clock; injectable for deterministic grace-window tests. */
	now?: () => number;
	/** Owner liveness probe; injectable so tests need no real subprocesses. `startTime` is absent for old owner files. */
	isAlive?: (pid: number, startTime: string | undefined) => boolean | Promise<boolean>;
	/** Grace window in ms before a dead owner's records are eligible. */
	graceMs?: number;
}

/** Targets belonging to one dead process, kept grouped so partial failures remain retryable. */
export interface OrphanOwner {
	file: string;
	pid: number;
	startTime?: string;
	updatedAt: number;
	targetIds: string[];
}

/** Orphan-scan result grouped by durable ownership file. */
export interface OrphanScan {
	owners: OrphanOwner[];
}

/**
 * Scan a registry dir for targets whose owning process is gone. Returns one
 * entry per dead owner so a reaper can retain only targets whose CDP closure
 * was not confirmed. This process's own file and every live-owner file are
 * left untouched.
 */
export async function collectOrphanTargets(
	scope: SharedTargetScope,
	opts: CollectOrphanOptions = {},
): Promise<OrphanScan> {
	const now = opts.now ?? Date.now;
	const isAlive = opts.isAlive ?? isOwnerAlive;
	const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
	const dir = registryDir(scope);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return { owners: [] };
		throw err;
	}
	const owners: OrphanOwner[] = [];
	const nowMs = now();
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = path.join(dir, entry);
		let record: OwnershipFile;
		try {
			record = (await Bun.file(file).json()) as OwnershipFile;
		} catch (error) {
			// Torn or malformed file: a live owner will rewrite it. Anything else (EACCES, ...) keeps the
			// record too, since nothing proves the owner dead, but is worth a warning.
			if (!(error instanceof SyntaxError) && !isEnoent(error)) {
				logger.warn("Skipping unreadable shared-browser ownership file", {
					file,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			continue;
		}
		if (typeof record?.pid !== "number" || !Array.isArray(record.targets)) continue;
		if (record.pid === process.pid) continue; // our own file
		if (await isAlive(record.pid, typeof record.startTime === "string" ? record.startTime : undefined)) continue; // owner still running
		if (nowMs - (record.updatedAt ?? 0) < graceMs) continue; // conservative grace
		owners.push({
			file,
			pid: record.pid,
			startTime: typeof record.startTime === "string" ? record.startTime : undefined,
			updatedAt: record.updatedAt,
			targetIds: record.targets.filter(id => typeof id === "string"),
		});
	}
	return { owners };
}

/** Outcome of {@link closeCdpTarget}: confirmed closed, or why it could not be confirmed. */
export type CdpCloseResult = { closed: true } | { closed: false; reason: string };

/**
 * The browser-level CDP connection Puppeteer keeps on a connected `Browser`. It is internal API
 * (`Browser._connection`, stripped from the public typings); `send` without a session id talks to the
 * browser endpoint itself.
 */
interface RootCdpConnection {
	send(method: "Target.closeTarget", params: { targetId: string }): Promise<{ success: boolean }>;
	send(method: "Target.getTargets"): Promise<{ targetInfos: Array<{ targetId: string }> }>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Close a page target by id over the browser-level CDP connection. Resolves `closed: true`
 * only when CDP confirms the close or confirms the target no longer exists; a
 * dropped connection or transient protocol failure resolves `closed: false` with
 * the failing step and its error message, so durable ownership remains available
 * for a later retry and the cause is visible in the log.
 *
 * Do not attach a new session to `browser.target()` for this: Puppeteer picks that target from its
 * own bookkeeping of the browser's target list, and on a shared browser that id can be one Chrome no
 * longer knows, so `Target.attachToTarget` fails ("No target with given id found") and the close
 * never runs. `Target.closeTarget` and `Target.getTargets` are browser-domain commands that need no
 * attached session, so they go straight over the root connection.
 */
export async function closeCdpTarget(browser: Browser, targetId: string): Promise<CdpCloseResult> {
	const connection = (browser as unknown as { _connection?: RootCdpConnection })._connection;
	if (!connection || typeof connection.send !== "function") {
		return { closed: false, reason: "browser has no root CDP connection" };
	}
	let closeFailure = "Target.closeTarget reported success=false";
	try {
		const result = await connection.send("Target.closeTarget", { targetId });
		if (result.success) return { closed: true };
	} catch (err) {
		// A concurrent reaper or the page itself may already have closed the
		// target. Confirm absence before treating the cleanup as complete.
		closeFailure = `Target.closeTarget failed: ${errorMessage(err)}`;
	}
	try {
		const { targetInfos } = await connection.send("Target.getTargets");
		if (!targetInfos.some(info => info.targetId === targetId)) return { closed: true };
		return { closed: false, reason: `${closeFailure}; target still present after close` };
	} catch (err) {
		return { closed: false, reason: `${closeFailure}; Target.getTargets failed: ${errorMessage(err)}` };
	}
}

/** Atomically retain unresolved targets, or remove an ownership file once all are resolved. */
async function updateOwnershipFile(owner: OrphanOwner, targetIds: string[]): Promise<void> {
	if (targetIds.length === 0) {
		await fs.rm(owner.file, { force: true });
		return;
	}
	const tmp = `${owner.file}.${process.pid}.tmp`;
	try {
		const record: OwnershipFile = {
			pid: owner.pid,
			startTime: owner.startTime,
			updatedAt: owner.updatedAt,
			targets: targetIds,
		};
		await Bun.write(tmp, JSON.stringify(record));
		await fs.rename(tmp, owner.file);
	} catch (error) {
		await fs.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Reap shared-browser targets whose owning omp process is gone. Each owner
 * file is removed only after every target is confirmed closed/absent; partial
 * failures atomically retain the unresolved ids for the next attach to retry.
 * Failures are logged, never thrown, so cleanup cannot block browser open.
 */
export async function reapOrphanSharedTargets(browser: Browser, scope: SharedTargetScope): Promise<number> {
	return (await reapOrphans(browser, scope)).closed;
}

/** Reap result: targets confirmed closed, and targets kept for retry. */
interface ReapOutcome {
	closed: number;
	retained: number;
}

async function reapOrphans(browser: Browser, scope: SharedTargetScope): Promise<ReapOutcome> {
	let scan: OrphanScan;
	try {
		scan = await collectOrphanTargets(scope);
	} catch (err) {
		logger.debug("Failed to scan shared-browser target registry", {
			error: err instanceof Error ? err.message : String(err),
		});
		return { closed: 0, retained: 0 };
	}
	let closed = 0;
	let retained = 0;
	for (const owner of scan.owners) {
		const kept: string[] = [];
		for (const targetId of owner.targetIds) {
			const result = await closeCdpTarget(browser, targetId);
			if (result.closed) {
				closed++;
			} else {
				kept.push(targetId);
				logger.warn("Retaining orphaned shared-browser target for retry", {
					targetId,
					ownerPid: owner.pid,
					reason: result.reason,
				});
			}
		}
		retained += kept.length;
		if (kept.length === owner.targetIds.length) continue;
		try {
			await updateOwnershipFile(owner, kept);
		} catch (err) {
			logger.debug("Failed to update shared-browser ownership after reap", {
				ownerPid: owner.pid,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (closed > 0) logger.debug("Reaped orphaned shared-browser targets", { count: closed, daemon: scope.daemonName });
	return { closed, retained };
}

/** Minimum gap between survivor-driven sweeps of one registry dir; attach-time sweeps are unthrottled. */
const SWEEP_MIN_INTERVAL_MS = 10_000;
const lastSweepAt = new Map<string, number>();
const sweepsInFlight = new Map<string, Promise<number>>();

/** In-process retries after a sweep retained targets: how many per streak, and how long to wait. */
const SWEEP_RETRY_MAX_ATTEMPTS = 3;
let sweepRetryDelayMs = SWEEP_MIN_INTERVAL_MS;
const sweepRetries = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> }>();

/**
 * Retry a sweep that retained targets without waiting for the next open or release: one unref'd timer
 * per registry dir, {@link SWEEP_MIN_INTERVAL_MS} after the sweep, at most {@link SWEEP_RETRY_MAX_ATTEMPTS}
 * attempts in a row. A sweep that retains nothing ends the streak. Each attempt reaps every dead owner's
 * targets (so a target is tried at most that many extra times) and logs its outcome at warn level.
 */
function scheduleSweepRetry(browser: Browser, scope: SharedTargetScope, dir: string, attempts: number): void {
	if (attempts >= SWEEP_RETRY_MAX_ATTEMPTS) {
		sweepRetries.delete(dir);
		return;
	}
	const timer = setTimeout(() => {
		void runSweepRetry(browser, scope, dir, attempts + 1);
	}, sweepRetryDelayMs);
	timer.unref();
	sweepRetries.set(dir, { attempts, timer });
}

async function runSweepRetry(browser: Browser, scope: SharedTargetScope, dir: string, attempt: number): Promise<void> {
	if (!browser.connected) {
		sweepRetries.delete(dir);
		return;
	}
	if (sweepsInFlight.has(dir)) {
		// A regular sweep is running and will schedule its own retry if it retains targets.
		sweepRetries.delete(dir);
		return;
	}
	const outcome = reapOrphans(browser, scope).catch(() => ({ closed: 0, retained: 0 }));
	const sweep = outcome.then(result => result.closed).finally(() => sweepsInFlight.delete(dir));
	sweepsInFlight.set(dir, sweep);
	const { closed, retained } = await outcome;
	logger.warn("Retried retained shared-browser targets", { attempt, closed, retained, daemon: scope.daemonName });
	if (retained > 0) scheduleSweepRetry(browser, scope, dir, attempt);
	else sweepRetries.delete(dir);
}

/** Cancel a pending sweep retry for this scope, e.g. when this process releases its last hold on the browser. */
export function cancelSweepRetries(scope: SharedTargetScope): void {
	const dir = registryDir(scope);
	const pending = sweepRetries.get(dir);
	if (!pending) return;
	clearTimeout(pending.timer);
	sweepRetries.delete(dir);
}

/**
 * Sweep dead owners' targets from a live shared browser on tab open/release, so orphans of clients
 * that died after this process attached do not wait for the next attach. At most one sweep per
 * registry dir runs at a time and starts at most every {@link SWEEP_MIN_INTERVAL_MS}. Never throws.
 */
export function sweepOrphanSharedTargets(
	browser: Browser,
	scope: SharedTargetScope,
	now: () => number = Date.now,
): Promise<number> {
	const dir = registryDir(scope);
	const running = sweepsInFlight.get(dir);
	if (running) return running;
	const at = now();
	const last = lastSweepAt.get(dir);
	if (last !== undefined && at - last < SWEEP_MIN_INTERVAL_MS) return Promise.resolve(0);
	lastSweepAt.set(dir, at);
	cancelSweepRetries(scope);
	const outcome = reapOrphans(browser, scope).catch(() => ({ closed: 0, retained: 0 }));
	const sweep = outcome
		.then(result => {
			if (result.retained > 0) scheduleSweepRetry(browser, scope, dir, 0);
			return result.closed;
		})
		.finally(() => sweepsInFlight.delete(dir));
	sweepsInFlight.set(dir, sweep);
	return sweep;
}

/** Test-only reset of the in-process ownership state. */
export function resetOrphanRegistryForTest(): void {
	for (const { timer } of sweepRetries.values()) clearTimeout(timer);
	sweepRetries.clear();
	sweepRetryDelayMs = SWEEP_MIN_INTERVAL_MS;
	selfStartTime = undefined;
	lastSweepAt.clear();
	sweepsInFlight.clear();
	ownedByDir.clear();
	writeChains.clear();
}

/** Test-only: shorten the wait before an in-process sweep retry. */
export function setSweepRetryDelayForTest(ms: number): void {
	sweepRetryDelayMs = ms;
}
