// Contract: once a launched browser is in the launch ledger, giving up on the launch (abort while waiting for
// CDP) goes through the ledger decision — a browser another live omp process has borrowed keeps running and
// ownership transfers to that borrower (reviewer blocker). A launch nobody borrowed is still killed.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { processStartTime, setLedgerDirForTest } from "../../src/tools/browser/launch-ledger";
import { acquireBrowser } from "../../src/tools/browser/registry";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("abandoning a recorded browser launch", () => {
	let temp: TempDir;
	let ledgerDir: string;
	let exe: string;
	const fixtures: Bun.Subprocess[] = [];
	const launched: number[] = [];

	beforeEach(async () => {
		temp = TempDir.createSync("@launch-abort-borrowed-");
		ledgerDir = path.join(temp.path(), "ledger");
		setLedgerDirForTest(ledgerDir);
		// Stand-in browser: never serves CDP, so the launch waits until aborted; ignores SIGTERM.
		exe = path.join(temp.path(), "fake-browser");
		await Bun.write(exe, "#!/bin/sh\ntrap '' TERM\nexec sleep 300\n");
		await fs.chmod(exe, 0o755);
	});

	afterEach(async () => {
		setLedgerDirForTest(undefined);
		// Only processes this test started are signalled.
		for (const fixture of fixtures.splice(0)) fixture.kill("SIGKILL");
		for (const pid of launched.splice(0)) if (isAlive(pid)) process.kill(pid, "SIGKILL");
		temp[Symbol.dispose]();
	});

	async function waitForEntry(): Promise<{ file: string; pid: number }> {
		for (let i = 0; i < 300; i++) {
			const names = (await fs.readdir(ledgerDir).catch(() => [] as string[])).filter(n => n.endsWith(".json"));
			if (names.length > 0)
				return { file: path.join(ledgerDir, names[0]!), pid: Number(names[0]!.replace(".json", "")) };
			// Waiting on another code path's disk write: no event to await.
			await Bun.sleep(20);
		}
		throw new Error("launch was never recorded");
	}

	it("given a live borrower registered while the launcher waits for CDP, when the launch is aborted, then the browser survives and ownership transfers", async () => {
		const abort = new AbortController();
		const opening = acquireBrowser({ kind: "spawned", path: exe }, { cwd: temp.path(), signal: abort.signal }).then(
			() => undefined,
			(err: unknown) => err,
		);
		const { file, pid } = await waitForEntry();
		launched.push(pid);
		const borrower = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore" });
		fixtures.push(borrower);
		let borrowerStart = await processStartTime(borrower.pid);
		while (borrowerStart === undefined) {
			await Bun.sleep(10);
			borrowerStart = await processStartTime(borrower.pid);
		}
		const entry = await Bun.file(file).json();
		await Bun.write(file, JSON.stringify({ ...entry, borrowers: [{ pid: borrower.pid, startTime: borrowerStart }] }));

		abort.abort();
		expect(await opening).toBeInstanceOf(Error);

		expect(isAlive(pid)).toBe(true);
		expect(isAlive(borrower.pid)).toBe(true);
		expect((await Bun.file(file).json()).ownerPid).toBe(borrower.pid);
	}, 30_000);

	it("given no borrower, when the launch is aborted, then the browser is terminated and the ledger dir is empty", async () => {
		const abort = new AbortController();
		const opening = acquireBrowser({ kind: "spawned", path: exe }, { cwd: temp.path(), signal: abort.signal }).then(
			() => undefined,
			(err: unknown) => err,
		);
		const { pid } = await waitForEntry();
		launched.push(pid);
		abort.abort();
		expect(await opening).toBeInstanceOf(Error);
		expect(isAlive(pid)).toBe(false);
		expect(await fs.readdir(ledgerDir)).toEqual([]);
	}, 30_000);
});
