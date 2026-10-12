/**
 * Regression tests for issue #10022: the project-shared broker-owned Chromium
 * (`omp.browser.headless`) retains page targets created by omp processes that
 * ended abnormally, because tab ownership was tracked only in per-process
 * memory. `orphan-registry` records ownership durably and reaps targets whose
 * owning process is gone.
 *
 * The contract under test:
 *  - a dead owner's targets are collected for reaping, a live owner's are not;
 *  - this process's own targets are never reaped (a live session keeps its tabs);
 *  - a conservative grace window keeps a just-crashed owner's fresh records;
 *  - confirmed closures are removed, while transient failures remain durable
 *    and are retried on the next reap.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import {
	collectOrphanTargets,
	forgetSharedTarget,
	reapOrphanSharedTargets,
	recordSharedTarget,
	sweepOrphanSharedTargets,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import { processStartTime } from "@oh-my-pi/pi-coding-agent/tools/browser/launch-ledger";
import { logger } from "@oh-my-pi/pi-utils";
import type { Browser } from "puppeteer-core";

const DAEMON_NAME = "omp.browser.headless";

/** Unique per-test scope so registry dirs never collide across the suite. */
function makeScope(): SharedTargetScope {
	const projectDir = path.join("/tmp", `omp-orphan-test-${crypto.randomUUID()}`);
	return { projectDir, daemonName: DAEMON_NAME };
}

function registryDir(scope: SharedTargetScope): string {
	return path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`);
}

async function writeOwnershipFile(
	scope: SharedTargetScope,
	record: { pid: number; updatedAt: number; targets: string[]; startTime?: string },
): Promise<void> {
	const dir = registryDir(scope);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `${record.pid}.json`), JSON.stringify(record));
}

/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
async function deadPid(): Promise<number> {
	const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

/** Minimal puppeteer Browser stub recording closes and optionally failing selected targets. */
function makeBrowser(closed: string[], failTargets: ReadonlySet<string> = new Set()): Browser {
	const session = {
		send: async (method: string, params?: { targetId: string }) => {
			if (method === "Target.getTargets") {
				return { targetInfos: [...failTargets].map(targetId => ({ targetId })) };
			}
			if (!params) throw new Error(`Missing params for ${method}`);
			if (failTargets.has(params.targetId)) throw new Error("transient CDP failure");
			closed.push(params.targetId);
			return { success: true };
		},
		detach: async () => undefined,
	};
	return {
		target: () => ({ createCDPSession: async () => session }),
	} as unknown as Browser;
}

const scopes: SharedTargetScope[] = [];
function trackedScope(): SharedTargetScope {
	const scope = makeScope();
	scopes.push(scope);
	return scope;
}

afterEach(async () => {
	resetOrphanRegistryForTest();
	for (const scope of scopes.splice(0)) {
		await fs.rm(daemonRuntimeDir(scope.projectDir), { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("orphan-registry — ownership scan", () => {
	it("collects a dead owner's targets and leaves a live owner's untouched", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		const live = 424242; // treated as alive by the injected probe below
		await writeOwnershipFile(scope, { pid: dead, updatedAt: 0, targets: ["dead-a", "dead-b"] });
		await writeOwnershipFile(scope, { pid: live, updatedAt: 0, targets: ["live-a"] });

		const scan = await collectOrphanTargets(scope, {
			now: () => 10_000_000,
			isAlive: pid => pid === live,
		});

		expect(scan.owners).toEqual([
			{
				file: path.join(registryDir(scope), `${dead}.json`),
				pid: dead,
				updatedAt: 0,
				targetIds: ["dead-a", "dead-b"],
			},
		]);
	});

	it("never reaps this process's own recorded targets", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "mine-1");
		await recordSharedTarget(scope, "mine-2");

		// Our own file is present on disk...
		const own = (await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).json()) as {
			targets: string[];
		};
		expect(own.targets.sort()).toEqual(["mine-1", "mine-2"]);

		// ...but a scan (even with everything else forced dead) skips it.
		const scan = await collectOrphanTargets(scope, { now: () => 10_000_000, isAlive: () => false });
		expect(scan.owners).toEqual([]);
	});

	it("forgetSharedTarget drops one id and removes the file once empty", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "a");
		await recordSharedTarget(scope, "b");
		await forgetSharedTarget(scope, "a");
		const after = (await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).json()) as {
			targets: string[];
		};
		expect(after.targets).toEqual(["b"]);

		await forgetSharedTarget(scope, "b");
		expect(await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).exists()).toBe(false);
	});

	it("keeps a dead owner's records inside the conservative grace window", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, { pid: dead, updatedAt: 100_000, targets: ["fresh"] });

		const withinGrace = await collectOrphanTargets(scope, {
			now: () => 105_000,
			isAlive: () => false,
			graceMs: 15_000,
		});
		expect(withinGrace.owners).toEqual([]);

		const pastGrace = await collectOrphanTargets(scope, {
			now: () => 130_000,
			isAlive: () => false,
			graceMs: 15_000,
		});
		expect(pastGrace.owners).toEqual([
			{
				file: path.join(registryDir(scope), `${dead}.json`),
				pid: dead,
				updatedAt: 100_000,
				targetIds: ["fresh"],
			},
		]);
	});
});

describe("orphan-registry — reap", () => {
	it("closes a dead owner's targets via CDP and deletes its ownership file", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, {
			pid: dead,
			updatedAt: Date.now() - 60_000,
			targets: ["orphan-1", "orphan-2"],
		});
		const closed: string[] = [];

		const count = await reapOrphanSharedTargets(makeBrowser(closed), scope);

		expect(count).toBe(2);
		expect(closed.sort()).toEqual(["orphan-1", "orphan-2"]);
		expect(await Bun.file(path.join(registryDir(scope), `${dead}.json`)).exists()).toBe(false);
	});

	it("retains transient CDP failures and retries them on the next reap", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		const updatedAt = Date.now() - 60_000;
		await writeOwnershipFile(scope, {
			pid: dead,
			updatedAt,
			targets: ["closed-now", "retry-later"],
		});
		const firstClosed: string[] = [];

		const firstCount = await reapOrphanSharedTargets(makeBrowser(firstClosed, new Set(["retry-later"])), scope);

		expect(firstCount).toBe(1);
		expect(firstClosed).toEqual(["closed-now"]);
		const retained = (await Bun.file(path.join(registryDir(scope), `${dead}.json`)).json()) as {
			pid: number;
			updatedAt: number;
			targets: string[];
		};
		expect(retained).toEqual({ pid: dead, updatedAt, targets: ["retry-later"] });

		const retryClosed: string[] = [];
		const retryCount = await reapOrphanSharedTargets(makeBrowser(retryClosed), scope);

		expect(retryCount).toBe(1);
		expect(retryClosed).toEqual(["retry-later"]);
		expect(await Bun.file(path.join(registryDir(scope), `${dead}.json`)).exists()).toBe(false);
	});
});

describe("orphan-registry — owner identity and survivor sweep", () => {
	const STALE = Date.now() - 60_000;
	const fixtures: Bun.Subprocess[] = [];

	afterEach(() => {
		// Only fixtures this test spawned are signalled.
		for (const proc of fixtures.splice(0)) proc.kill("SIGKILL");
	});

	async function liveFixture(): Promise<{ pid: number; startTime: string }> {
		const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		fixtures.push(proc);
		let startTime = await processStartTime(proc.pid);
		while (startTime === undefined) {
			await Bun.sleep(10);
			startTime = await processStartTime(proc.pid);
		}
		return { pid: proc.pid, startTime };
	}

	it("given an owner file whose pid is now a different live process, when scanned after grace, then its targets are collected (PID reuse)", async () => {
		const scope = trackedScope();
		const impostor = await liveFixture();
		await writeOwnershipFile(scope, {
			pid: impostor.pid,
			startTime: "Thu Jan  1 00:00:00 1970",
			updatedAt: STALE,
			targets: ["t-reused"],
		});
		const scan = await collectOrphanTargets(scope);
		expect(scan.owners.map(owner => owner.targetIds)).toEqual([["t-reused"]]);
	});

	it("given an owner file whose pid and start time still match a live process, then it is left alone", async () => {
		const scope = trackedScope();
		const owner = await liveFixture();
		await writeOwnershipFile(scope, { ...owner, updatedAt: STALE, targets: ["t-live"] });
		expect((await collectOrphanTargets(scope)).owners).toEqual([]);
	});

	it("given an old owner file without a start time, then a live pid is kept and a dead pid is collected", async () => {
		const scope = trackedScope();
		const live = await liveFixture();
		const dead = await deadPid();
		await writeOwnershipFile(scope, { pid: live.pid, updatedAt: STALE, targets: ["t-old-live"] });
		await writeOwnershipFile(scope, { pid: dead, updatedAt: STALE, targets: ["t-old-dead"] });
		const scan = await collectOrphanTargets(scope);
		expect(scan.owners.map(owner => owner.targetIds)).toEqual([["t-old-dead"]]);
	});

	it("given this process records a target, then its owner file carries this process's start time", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "t-mine");
		const file = path.join(registryDir(scope), `${process.pid}.json`);
		const record = (await Bun.file(file).json()) as { startTime?: string };
		expect(record.startTime).toBe(await processStartTime(process.pid));
	});

	it("given the CDP session cannot be created, when a sweep retains the target, then the warning carries the failing step and its error", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, { pid: dead, updatedAt: STALE, targets: ["t-keep"] });
		const browser = {
			target: () => ({
				createCDPSession: async () => {
					throw new Error("Connection closed");
				},
			}),
		} as unknown as Browser;
		const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			expect(await reapOrphanSharedTargets(browser, scope)).toBe(0);
			const retained = warn.mock.calls.find(([message]) => message.includes("Retaining orphaned"));
			expect(retained?.[1]).toMatchObject({
				targetId: "t-keep",
				ownerPid: dead,
				reason: "createCDPSession failed: Connection closed",
			});
		} finally {
			warn.mockRestore();
		}
		// Retry path unchanged: the ownership record is still on disk.
		expect(await fs.readdir(registryDir(scope))).toEqual([`${dead}.json`]);
	});

	it("given the target survives a failed close, when a sweep retains it, then the reason says it is still present", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, { pid: dead, updatedAt: STALE, targets: ["t-stuck"] });
		const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			expect(await reapOrphanSharedTargets(makeBrowser([], new Set(["t-stuck"])), scope)).toBe(0);
			const retained = warn.mock.calls.find(([message]) => message.includes("Retaining orphaned"));
			expect((retained?.[1] as { reason: string }).reason).toBe(
				"Target.closeTarget failed: transient CDP failure; target still present after close",
			);
		} finally {
			warn.mockRestore();
		}
	});

	it("given a client died after this process attached, when a survivor sweep runs, then it closes its targets and is throttled between sweeps", async () => {
		const scope = trackedScope();
		const first = await deadPid();
		await writeOwnershipFile(scope, { pid: first, updatedAt: STALE, targets: ["t-a", "t-b"] });
		const closed: string[] = [];
		const browser = makeBrowser(closed);
		let clock = 1_000_000;

		expect(await sweepOrphanSharedTargets(browser, scope, () => clock)).toBe(2);
		expect(closed.sort()).toEqual(["t-a", "t-b"]);
		expect(await fs.readdir(registryDir(scope))).toEqual([]);

		const second = await deadPid();
		await writeOwnershipFile(scope, { pid: second, updatedAt: STALE, targets: ["t-d"] });
		clock += 1_000;
		expect(await sweepOrphanSharedTargets(browser, scope, () => clock)).toBe(0);
		expect(closed).not.toContain("t-d");

		clock += 20_000;
		expect(await sweepOrphanSharedTargets(browser, scope, () => clock)).toBe(1);
		expect(closed).toContain("t-d");
	});
});
