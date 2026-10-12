/**
 * Durable ledger of browsers omp launched itself (`app.path` kind), so a
 * browser can never outlive every omp process that could close it.
 *
 * One JSON file per launched browser in `~/.omp/run/browser-launches/`.
 * Every kill decision uses recorded identity only — `(pid, startTime)` read
 * from `ps` — never process names, so a recycled pid or the user's own
 * Chrome is never touched. A browser without an entry is borrowed.
 *
 * Roles for a ledger entry:
 * - owner: the omp process that launched it (or adopted it from a dead owner);
 *   closes it on release.
 * - borrower: another live omp process attached to the same browser. When the
 *   owner releases, ownership transfers to a live borrower instead of killing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { getDaemonRuntimeRoot, isEnoent, logger, withFileLock } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logLifecycle, withLifecycleLog } from "../../launch/lifecycle-log";

export interface ProcessIdentity {
	pid: number;
	/** `ps -o lstart=` output: unique per (pid, boot) so it detects pid reuse. */
	startTime: string;
}

export interface LedgerEntry {
	browserPid: number;
	browserStartTime: string;
	ownerPid: number;
	ownerStartTime: string;
	ownerSessionId: string;
	exe: string;
	cdpPort: number;
	userDataDir?: string;
	headless: boolean;
	borrowers: ProcessIdentity[];
	/** `kill-failed`: a termination was attempted and the process is still alive. */
	state: "live" | "kill-failed";
}

/** Test seam: ledger directory. Defaults to `~/.omp/run/browser-launches`. */
export interface LedgerOptions {
	dir?: string;
}

export type BorrowRole = "owner" | "borrower" | "adopted" | "unmanaged";

// Worst case a termination takes TERM_WAIT + KILL_WAIT = 0.9 s: it must fit inside the 2 s window a
// supervisor gives an RPC agent between SIGTERM and SIGKILL, alongside tab teardown. Exit is confirmed by
// polling the process identity — never by `waitForExit`, which is unreliable for non-child pids.
const TERM_WAIT_MS = 500;
const KILL_WAIT_MS = 400;
const EXIT_POLL_MS = 40;
/** Minimum gap between `ps` identity confirmations while a pid is still alive. */
const IDENTITY_CHECK_MS = 200;

// Entry locks are held across a termination (<= 1.4 s), so a waiter must outlast one.
const ENTRY_LOCK_RETRIES = 400;
const ENTRY_LOCK_RETRY_MS = 25;

let ledgerDirOverride: string | undefined;

/** Test seam: redirect the default ledger directory for in-process tests. Pass `undefined` to restore. */
export function setLedgerDirForTest(dir: string | undefined): void {
	ledgerDirOverride = dir;
}

function ledgerDir(opts: LedgerOptions): string {
	return opts.dir ?? ledgerDirOverride ?? path.join(path.dirname(getDaemonRuntimeRoot()), "browser-launches");
}

/**
 * Serialize read-decide-write on one entry across omp processes. The native
 * lease is process-owned, so a crashed holder never strands the lock. Every
 * mutation re-reads the entry inside the lock: a deleted entry stays deleted,
 * and a borrower can never be lost to a concurrent owner decision.
 */
async function withEntryLock<T>(opts: LedgerOptions, browserPid: number, fn: () => Promise<T>): Promise<T> {
	await fs.mkdir(ledgerDir(opts), { recursive: true });
	return await withFileLock(entryPath(opts, browserPid), fn, {
		retries: ENTRY_LOCK_RETRIES,
		retryDelayMs: ENTRY_LOCK_RETRY_MS,
	});
}

function entryPath(opts: LedgerOptions, browserPid: number): string {
	return path.join(ledgerDir(opts), `${browserPid}.json`);
}

/** Start time string of `pid`, or undefined when it is not running (or `ps` is unavailable). */
export async function processStartTime(pid: number): Promise<string | undefined> {
	if (process.platform === "win32") return undefined;
	try {
		const child = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			env: { ...process.env, LC_ALL: "C" },
		});
		const text = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
		await child.exited;
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** False only when the kernel reports no such pid (ESRCH); any other probe result means the pid exists. */
function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function isIdentityAlive(identity: ProcessIdentity): Promise<boolean> {
	// A vanished pid needs no `ps` spawn; under load each spawn costs far more than the probe.
	if (!pidExists(identity.pid)) return false;
	return (await processStartTime(identity.pid)) === identity.startTime;
}

let selfIdentity: Promise<ProcessIdentity | undefined> | undefined;

/** This process's identity; undefined where start times are unavailable (ledger disabled). */
function selfProcessIdentity(): Promise<ProcessIdentity | undefined> {
	selfIdentity ??= processStartTime(process.pid).then(startTime =>
		startTime === undefined ? undefined : { pid: process.pid, startTime },
	);
	return selfIdentity;
}

async function writeEntry(opts: LedgerOptions, entry: LedgerEntry): Promise<void> {
	const target = entryPath(opts, entry.browserPid);
	const tmp = `${target}.${process.pid}.${Bun.randomUUIDv7()}.tmp`;
	await Bun.write(tmp, JSON.stringify(entry));
	await fs.rename(tmp, target);
}

/**
 * Remove an entry and its lock file. Callers hold the entry lock and have found the entry gone or the
 * browser dead. Lock reclamation rule: the lock file is unlinked only by a holder, and only when there
 * is no entry left to serialize (this call, or a release that finds the entry already absent). A
 * concurrent acquirer that raced onto the unlinked file can then only observe "entry absent" and
 * return noop, which is also what it would observe on the new file; and that acquirer's own noop path
 * unlinks whatever it created, so no lock file outlives the last release. An entry that still exists
 * keeps a stable lock file for as long as it exists.
 */
async function deleteEntry(opts: LedgerOptions, browserPid: number): Promise<void> {
	await fs.rm(entryPath(opts, browserPid), { force: true });
	await fs.rm(`${entryPath(opts, browserPid)}.lock`, { force: true });
}

function isLedgerEntry(raw: unknown): raw is LedgerEntry {
	if (typeof raw !== "object" || raw === null) return false;
	const e = raw as Partial<LedgerEntry>;
	return (
		typeof e.browserPid === "number" &&
		typeof e.browserStartTime === "string" &&
		typeof e.ownerPid === "number" &&
		typeof e.ownerStartTime === "string" &&
		Array.isArray(e.borrowers)
	);
}

async function readEntry(opts: LedgerOptions, browserPid: number): Promise<LedgerEntry | undefined> {
	try {
		const raw: unknown = await Bun.file(entryPath(opts, browserPid)).json();
		return isLedgerEntry(raw) ? raw : undefined;
	} catch (error) {
		if (!isEnoent(error)) logger.debug("Unreadable browser launch ledger entry", { browserPid });
		return undefined;
	}
}

async function readAllEntries(opts: LedgerOptions): Promise<LedgerEntry[]> {
	let names: string[];
	try {
		names = await fs.readdir(ledgerDir(opts));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	const entries: LedgerEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const pid = Number(name.slice(0, -".json".length));
		if (!Number.isInteger(pid)) continue;
		const entry = await readEntry(opts, pid);
		if (entry) entries.push(entry);
	}
	return entries;
}

/**
 * Record a browser this process just launched. Returns `undefined` only on
 * platforms without process start times (Windows); elsewhere a missing start
 * time or a failed write throws, so a launch is never silently untracked.
 */
export async function recordLaunchedBrowser(
	launch: {
		browserPid: number;
		exe: string;
		cdpPort: number;
		userDataDir?: string;
		headless: boolean;
		ownerSessionId: string;
	},
	opts: LedgerOptions = {},
): Promise<LedgerEntry | undefined> {
	if (process.platform === "win32") return undefined;
	const [self, browserStartTime] = await Promise.all([selfProcessIdentity(), processStartTime(launch.browserPid)]);
	if (!self) throw new ToolError("Cannot record the launched browser: this process's start time is unreadable.");
	if (browserStartTime === undefined) {
		throw new ToolError(
			`Cannot record the launched browser (pid ${launch.browserPid}): its start time is unreadable.`,
		);
	}
	const entry: LedgerEntry = {
		browserPid: launch.browserPid,
		browserStartTime,
		ownerPid: self.pid,
		ownerStartTime: self.startTime,
		ownerSessionId: launch.ownerSessionId,
		exe: launch.exe,
		cdpPort: launch.cdpPort,
		userDataDir: launch.userDataDir,
		headless: launch.headless,
		borrowers: [],
		state: "live",
	};
	await withEntryLock(opts, launch.browserPid, () => writeEntry(opts, entry));
	return entry;
}

/**
 * Attach this process to an already-running browser found via CDP reuse.
 * `unmanaged`: no ledger entry (or a stale one) — the browser is someone
 * else's and is never killed. `adopted`: the recorded owner died, this
 * process takes over. `borrower`: the owner is alive.
 */
export async function addLaunchedBrowserBorrower(browserPid: number, opts: LedgerOptions = {}): Promise<BorrowRole> {
	try {
		await fs.access(entryPath(opts, browserPid));
	} catch {
		// No entry: nothing to lock, and taking the lock would only leave a lock file behind.
		return "unmanaged";
	}
	return await withEntryLock(opts, browserPid, async () => {
		const entry = await readEntry(opts, browserPid);
		if (!entry) return "unmanaged";
		if (!(await isIdentityAlive({ pid: browserPid, startTime: entry.browserStartTime }))) {
			await deleteEntry(opts, browserPid);
			return "unmanaged";
		}
		const self = await selfProcessIdentity();
		if (!self) return "unmanaged";
		if (entry.ownerPid === self.pid && entry.ownerStartTime === self.startTime) return "owner";
		if (await isIdentityAlive({ pid: entry.ownerPid, startTime: entry.ownerStartTime })) {
			if (!entry.borrowers.some(b => b.pid === self.pid && b.startTime === self.startTime)) {
				entry.borrowers.push(self);
				await writeEntry(opts, entry);
			}
			return "borrower";
		}
		entry.ownerPid = self.pid;
		entry.ownerStartTime = self.startTime;
		entry.borrowers = entry.borrowers.filter(b => !(b.pid === self.pid && b.startTime === self.startTime));
		await writeEntry(opts, entry);
		return "adopted";
	});
}

async function waitForIdentityGone(identity: ProcessIdentity, budgetMs: number): Promise<boolean> {
	const deadline = performance.now() + budgetMs;
	let lastIdentityCheck = Number.NEGATIVE_INFINITY;
	while (performance.now() < deadline) {
		if (!pidExists(identity.pid)) return true;
		// A pid that still exists may have been reused: confirm identity, but only every
		// IDENTITY_CHECK_MS so a slow-exiting process does not cost a `ps` spawn per poll.
		if (performance.now() - lastIdentityCheck >= IDENTITY_CHECK_MS) {
			lastIdentityCheck = performance.now();
			if (!(await isIdentityAlive(identity))) return true;
		}
		// Polling a pid we may not be the parent of: there is no exit event to await.
		await Bun.sleep(EXIT_POLL_MS);
	}
	return !(await isIdentityAlive(identity));
}

/** Signal `identity.pid` only while the start time still matches, so a reused pid is never hit. */
async function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
	if (!(await isIdentityAlive(identity))) return;
	try {
		process.kill(identity.pid, signal);
	} catch {
		// Already gone (ESRCH) or not signalable; liveness polling reports the outcome.
	}
}

/**
 * SIGTERM, then SIGKILL if it has not exited in time, confirming each stage by
 * `(pid, startTime)` liveness polling. The process tree is killed through the
 * native helper at the SIGKILL stage so renderer children do not outlive a wedged browser.
 */
async function terminateByIdentity(identity: ProcessIdentity): Promise<boolean> {
	if (!(await isIdentityAlive(identity))) return true;
	await signalIdentity(identity, "SIGTERM");
	if (await waitForIdentityGone(identity, TERM_WAIT_MS)) return true;
	if (await isIdentityAlive(identity)) {
		const proc = Process.fromPid(identity.pid);
		if (proc) await proc.terminate({ gracefulMs: 0, timeoutMs: 100 }).catch(() => false);
		await signalIdentity(identity, "SIGKILL");
	}
	return await waitForIdentityGone(identity, KILL_WAIT_MS);
}

export type ReleaseOutcome = "killed" | "transferred" | "dropped" | "noop";

/**
 * Drop this process's claim on a ledgered browser.
 * - borrower: removed from the entry; the browser stays.
 * - owner with `kill`: ownership transfers to a live borrower, otherwise the
 *   browser is terminated and the entry deleted. A browser that survives
 *   termination keeps a `kill-failed` entry and this throws.
 * - owner without `kill`: the entry stays; the reaper handles it after exit.
 */
export async function releaseLaunchedBrowser(
	browserPid: number,
	release: { kill: boolean; reason: string },
	opts: LedgerOptions = {},
): Promise<ReleaseOutcome> {
	try {
		await fs.access(entryPath(opts, browserPid));
	} catch {
		// Already released (or never ledgered): idempotent noop without a lock file.
		return "noop";
	}
	return await withEntryLock(opts, browserPid, async () => {
		const entry = await readEntry(opts, browserPid);
		const self = await selfProcessIdentity();
		if (!entry) {
			await deleteEntry(opts, browserPid);
			return "noop";
		}
		if (!self) return "noop";
		const resource = `browser pid ${browserPid}`;
		const owner = String(self.pid);
		const isOwner = entry.ownerPid === self.pid && entry.ownerStartTime === self.startTime;
		if (!isOwner) {
			const kept = entry.borrowers.filter(b => !(b.pid === self.pid && b.startTime === self.startTime));
			if (kept.length !== entry.borrowers.length) {
				entry.borrowers = kept;
				await writeEntry(opts, entry);
			}
			return "dropped";
		}
		if (!release.kill) return "noop";
		const liveBorrowers: ProcessIdentity[] = [];
		for (const borrower of entry.borrowers) if (await isIdentityAlive(borrower)) liveBorrowers.push(borrower);
		const [next, ...rest] = liveBorrowers;
		if (next) {
			const started = performance.now();
			entry.ownerPid = next.pid;
			entry.ownerStartTime = next.startTime;
			entry.borrowers = rest;
			await writeEntry(opts, entry);
			logLifecycle({
				action: "transfer",
				resource,
				owner,
				reason: `${release.reason}; new owner ${next.pid}`,
				result: "ok",
				durationMs: Math.round(performance.now() - started),
			});
			return "transferred";
		}
		return await withLifecycleLog({ action: "release", resource, owner, reason: release.reason }, async () => {
			const gone = await terminateByIdentity({ pid: browserPid, startTime: entry.browserStartTime });
			if (!gone) {
				entry.state = "kill-failed";
				await writeEntry(opts, entry);
				throw new ToolError(
					`Could not terminate the launched browser (pid ${browserPid}); it is still running. Close it manually, then retry.`,
				);
			}
			await deleteEntry(opts, browserPid);
			return "killed" as const;
		});
	});
}

/**
 * Terminate launched browsers whose owner is dead and that no live omp
 * process borrows. Entries whose browser exited, or whose pid now belongs to
 * a different process (identity mismatch), are deleted without any signal.
 * Returns the pids terminated.
 */
export async function reapOrphanLaunchedBrowsers(opts: LedgerOptions = {}): Promise<number[]> {
	const reaped: number[] = [];
	for (const candidate of await readAllEntries(opts)) {
		const didReap = await withEntryLock(opts, candidate.browserPid, async () => {
			// Re-read under the lock: a release, transfer or borrow may have run since the scan.
			const entry = await readEntry(opts, candidate.browserPid);
			if (!entry) return false;
			const browser: ProcessIdentity = { pid: entry.browserPid, startTime: entry.browserStartTime };
			if (!(await isIdentityAlive(browser))) {
				await deleteEntry(opts, entry.browserPid);
				return false;
			}
			if (await isIdentityAlive({ pid: entry.ownerPid, startTime: entry.ownerStartTime })) return false;
			for (const borrower of entry.borrowers) if (await isIdentityAlive(borrower)) return false;
			try {
				await withLifecycleLog(
					{
						action: "reap",
						resource: `browser pid ${entry.browserPid}`,
						owner: String(entry.ownerPid),
						reason: "owner-dead",
					},
					async () => {
						if (!(await terminateByIdentity(browser))) {
							entry.state = "kill-failed";
							await writeEntry(opts, entry);
							throw new Error(`browser pid ${entry.browserPid} survived termination`);
						}
						await deleteEntry(opts, entry.browserPid);
					},
				);
				return true;
			} catch {
				// Logged by withLifecycleLog; the entry stays `kill-failed` for the next scan.
				return false;
			}
		});
		if (didReap) reaped.push(candidate.browserPid);
	}
	return reaped;
}

/**
 * Refuse a new launch while this process owns a browser it failed to
 * terminate and that is still running — launching more would only multiply
 * the leak.
 */
export async function assertLaunchAllowed(opts: LedgerOptions = {}): Promise<void> {
	const self = await selfProcessIdentity();
	if (!self) return;
	for (const entry of await readAllEntries(opts)) {
		if (entry.state !== "kill-failed") continue;
		if (entry.ownerPid !== self.pid || entry.ownerStartTime !== self.startTime) continue;
		if (!(await isIdentityAlive({ pid: entry.browserPid, startTime: entry.browserStartTime }))) continue;
		const started = performance.now();
		logLifecycle({
			action: "refuse",
			resource: `browser pid ${entry.browserPid}`,
			owner: String(self.pid),
			reason: "kill-failed entry still alive",
			result: "refused",
			durationMs: Math.round(performance.now() - started),
		});
		throw new ToolError(
			`Refusing to launch another browser: the previous one (pid ${entry.browserPid}) could not be terminated and is still running. Close it manually first.`,
		);
	}
}
