// Contract: a `kill: true` release that joins an earlier release of the same tab must still honour the
// launch ledger — a browser another live omp process borrows is never killed (reviewer finding 1).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { BrowserHandle } from "../../src/tools/browser/registry";
import { processStartTime, recordLaunchedBrowser, setLedgerDirForTest } from "../../src/tools/browser/launch-ledger";
import { ensureSpawnedKilledForTest } from "../../src/tools/browser/tab-supervisor";

async function spawnFixture(): Promise<Bun.Subprocess> {
	const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore" });
	while ((await processStartTime(proc.pid)) === undefined) await Bun.sleep(10);
	return proc;
}

function spawnedHandle(proc: Bun.Subprocess, ledgerPid: number | undefined): BrowserHandle {
	return {
		kind: { kind: "spawned", path: process.execPath },
		pid: proc.pid,
		subprocess: proc,
		ledgerPid,
	} as unknown as BrowserHandle;
}

describe("joined kill release honours the ledger", () => {
	let temp: TempDir;
	const fixtures: Bun.Subprocess[] = [];

	beforeEach(() => {
		temp = TempDir.createSync("@joined-release-");
		setLedgerDirForTest(path.join(temp.path(), "ledger"));
	});

	afterEach(async () => {
		setLedgerDirForTest(undefined);
		for (const fixture of fixtures.splice(0)) fixture.kill("SIGKILL");
		temp[Symbol.dispose]();
	});

	it("given a ledgered browser with a live borrower, when a joined kill release runs, then the browser and the borrower stay alive (M19)", async () => {
		const browser = await spawnFixture();
		const borrower = await spawnFixture();
		fixtures.push(browser, borrower);
		const entry = await recordLaunchedBrowser({
			browserPid: browser.pid,
			exe: "fixture",
			cdpPort: 0,
			headless: true,
			ownerSessionId: "s",
		});
		if (!entry) throw new Error("ledger unavailable");
		const borrowerStart = await processStartTime(borrower.pid);
		if (!borrowerStart) throw new Error("no start time");
		const file = path.join(temp.path(), "ledger", `${browser.pid}.json`);
		await Bun.write(file, JSON.stringify({ ...entry, borrowers: [{ pid: borrower.pid, startTime: borrowerStart }] }));

		await ensureSpawnedKilledForTest(spawnedHandle(browser, browser.pid));

		expect(browser.exitCode).toBeNull();
		expect(borrower.exitCode).toBeNull();
		expect((await Bun.file(file).json()).ownerPid).toBe(borrower.pid);
	});

	it("given a ledgered browser with no borrower, when a joined kill release runs, then the browser is terminated", async () => {
		const browser = await spawnFixture();
		fixtures.push(browser);
		await recordLaunchedBrowser({
			browserPid: browser.pid,
			exe: "fixture",
			cdpPort: 0,
			headless: true,
			ownerSessionId: "s",
		});

		await ensureSpawnedKilledForTest(spawnedHandle(browser, browser.pid));

		expect(await Promise.race([browser.exited.then(() => true), Bun.sleep(3_000).then(() => false)])).toBe(true);
	});
});
