// Integration test — real non-child fixture processes. Contract (R1): releasing a launched browser that
// shuts down slowly (Chrome flushes its profile after SIGTERM) or ignores SIGTERM still ends `killed`,
// with the process dead and the entry and its lock file gone, inside Paseo's 2 s window. The fixtures are
// started detached via `sh -c '... &'` so they are not children of this process, as real Chrome is not.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	processStartTime,
	reapOrphanLaunchedBrowsers,
	recordLaunchedBrowser,
	releaseLaunchedBrowser,
} from "../../src/tools/browser/launch-ledger";

const TEARDOWN_BUDGET_MS = 2_000;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("launched browser that exits slowly", () => {
	let temp: TempDir;
	let opts: { dir: string };
	const pids: number[] = [];

	beforeEach(() => {
		temp = TempDir.createSync("@ledger-slow-exit-");
		opts = { dir: path.join(temp.path(), "ledger") };
	});

	afterEach(() => {
		// Only fixtures this test started are signalled.
		for (const pid of pids.splice(0)) if (isAlive(pid)) process.kill(pid, "SIGKILL");
		temp[Symbol.dispose]();
	});

	/** Detached non-child fixture. `onTerm`: shell trap body for SIGTERM ("" ignores it). */
	async function spawnDetached(onTerm: string): Promise<number> {
		const script = path.join(temp.path(), `fixture-${pids.length}.sh`);
		const pidFile = path.join(temp.path(), `fixture-${pids.length}.pid`);
		await Bun.write(
			script,
			`trap '${onTerm}' TERM\necho $$ > ${JSON.stringify(pidFile)}\nwhile :; do sleep 0.05; done\n`,
		);
		const launcher = Bun.spawn(["/bin/sh", "-c", `/bin/sh ${JSON.stringify(script)} </dev/null >/dev/null 2>&1 &`], {
			stdout: "ignore",
			stderr: "ignore",
		});
		await launcher.exited;
		while (!(await Bun.file(pidFile).exists()) || (await Bun.file(pidFile).text()).trim() === "") await Bun.sleep(10);
		const pid = Number((await Bun.file(pidFile).text()).trim());
		pids.push(pid);
		while ((await processStartTime(pid)) === undefined) await Bun.sleep(10);
		return pid;
	}

	async function record(pid: number): Promise<void> {
		await recordLaunchedBrowser(
			{ browserPid: pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
			opts,
		);
	}

	async function expectCleanRelease(pid: number): Promise<void> {
		const started = performance.now();
		expect(await releaseLaunchedBrowser(pid, { kill: true, reason: "test" }, opts)).toBe("killed");
		expect(performance.now() - started).toBeLessThan(TEARDOWN_BUDGET_MS);
		expect(isAlive(pid)).toBe(false);
		const left = await fs.readdir(opts.dir);
		expect(left.filter(name => name.startsWith(`${pid}.json`))).toEqual([]);
	}

	it("given a non-child browser that exits 300 ms after SIGTERM, when released with kill, then it ends killed with entry and lock removed (R1)", async () => {
		const pid = await spawnDetached("sleep 0.3; exit 0");
		await record(pid);
		await expectCleanRelease(pid);
	}, 20_000);

	it("given a non-child browser that ignores SIGTERM, when released with kill, then SIGKILL ends it inside the budget (R1)", async () => {
		const pid = await spawnDetached("");
		await record(pid);
		await expectCleanRelease(pid);
	}, 20_000);

	it("given an orphaned non-child browser that exits slowly, when the reaper scans, then it is terminated and its entry and lock removed (R1)", async () => {
		const pid = await spawnDetached("sleep 0.3; exit 0");
		await record(pid);
		const entryFile = path.join(opts.dir, `${pid}.json`);
		const entry = JSON.parse(await Bun.file(entryFile).text());
		entry.ownerStartTime = "Thu Jan  1 00:00:00 1970";
		await Bun.write(entryFile, JSON.stringify(entry));
		expect(await reapOrphanLaunchedBrowsers(opts)).toEqual([pid]);
		expect(isAlive(pid)).toBe(false);
		expect((await fs.readdir(opts.dir)).filter(name => name.startsWith(`${pid}.json`))).toEqual([]);
	}, 20_000);
});
