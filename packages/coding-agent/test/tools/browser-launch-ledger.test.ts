// Integration test — real fixture processes (a `bun -e` sleeper stands in for Chrome) and an isolated
// ledger directory. The contract: omp terminates only a browser it recorded launching, identified by
// (pid, start time); borrowed, reused-unrecorded and pid-reused processes are never signalled.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import {
	addLaunchedBrowserBorrower,
	assertLaunchAllowed,
	type LedgerEntry,
	processStartTime,
	recordLaunchedBrowser,
	reapOrphanLaunchedBrowsers,
	releaseLaunchedBrowser,
} from "../../src/tools/browser/launch-ledger";

interface Fixture {
	pid: number;
	proc: Bun.Subprocess;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("launched-browser ledger", () => {
	let tempDir: TempDir;
	let opts: { dir: string };
	let spawned: Fixture[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-ledger-");
		opts = { dir: path.join(tempDir.path(), "ledger") };
		spawned = [];
	});

	afterEach(async () => {
		// Only fixtures this test started are ever signalled.
		for (const fixture of spawned) fixture.proc.kill("SIGKILL");
		await Promise.all(spawned.map(fixture => fixture.proc.exited));
		tempDir[Symbol.dispose]();
	});

	async function spawnFixture(): Promise<Fixture> {
		const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore" });
		const fixture = { pid: proc.pid, proc };
		spawned.push(fixture);
		// The ledger identifies by start time; wait until the OS reports it.
		while ((await processStartTime(fixture.pid)) === undefined) await Bun.sleep(10);
		return fixture;
	}

	async function readEntry(pid: number): Promise<LedgerEntry | undefined> {
		try {
			return (await Bun.file(path.join(opts.dir, `${pid}.json`)).json()) as LedgerEntry;
		} catch {
			return undefined;
		}
	}

	/** Record `browser`, then rewrite the owner to a fixture identity so the owner can die independently. */
	async function recordOwnedBy(browser: Fixture, owner: Fixture, borrowers: Fixture[] = []): Promise<void> {
		await recordLaunchedBrowser(
			{ browserPid: browser.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
			opts,
		);
		const entry = (await readEntry(browser.pid))!;
		entry.ownerPid = owner.pid;
		entry.ownerStartTime = (await processStartTime(owner.pid))!;
		entry.borrowers = await Promise.all(
			borrowers.map(async b => ({ pid: b.pid, startTime: (await processStartTime(b.pid))! })),
		);
		await Bun.write(path.join(opts.dir, `${browser.pid}.json`), JSON.stringify(entry));
	}

	async function killFixture(fixture: Fixture): Promise<void> {
		fixture.proc.kill("SIGKILL");
		await fixture.proc.exited;
	}

	it("given an owner killed with SIGKILL, when any omp scans, then its launched browser is terminated and the entry removed (M17)", async () => {
		const browser = await spawnFixture();
		const owner = await spawnFixture();
		await recordOwnedBy(browser, owner);
		await killFixture(owner);

		expect(await reapOrphanLaunchedBrowsers(opts)).toEqual([browser.pid]);
		await browser.proc.exited;
		expect(isAlive(browser.pid)).toBe(false);
		expect(await readEntry(browser.pid)).toBeUndefined();
	}, 20_000);

	it("given a live owner, when a scan runs, then its browser is left alone", async () => {
		const browser = await spawnFixture();
		const owner = await spawnFixture();
		await recordOwnedBy(browser, owner);

		expect(await reapOrphanLaunchedBrowsers(opts)).toEqual([]);
		expect(isAlive(browser.pid)).toBe(true);
	});

	it("given a ledger pid now held by a different process, when a scan runs, then that process is not signalled and the entry is deleted (M18)", async () => {
		const impostor = await spawnFixture();
		const owner = await spawnFixture();
		await recordOwnedBy(impostor, owner);
		const entry = (await readEntry(impostor.pid))!;
		entry.browserStartTime = "Thu Jan  1 00:00:00 1970";
		await Bun.write(path.join(opts.dir, `${impostor.pid}.json`), JSON.stringify(entry));
		await killFixture(owner);

		expect(await reapOrphanLaunchedBrowsers(opts)).toEqual([]);
		expect(isAlive(impostor.pid)).toBe(true);
		expect(await readEntry(impostor.pid)).toBeUndefined();
	});

	it("given a live borrower, when the owner releases with kill, then ownership moves and the browser keeps running (M19)", async () => {
		const browser = await spawnFixture();
		const borrower = await spawnFixture();
		await recordLaunchedBrowser(
			{ browserPid: browser.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
			opts,
		);
		const entry = (await readEntry(browser.pid))!;
		entry.borrowers = [{ pid: borrower.pid, startTime: (await processStartTime(borrower.pid))! }];
		await Bun.write(path.join(opts.dir, `${browser.pid}.json`), JSON.stringify(entry));

		expect(await releaseLaunchedBrowser(browser.pid, { kill: true, reason: "test" }, opts)).toBe("transferred");
		expect(isAlive(browser.pid)).toBe(true);
		expect((await readEntry(browser.pid))?.ownerPid).toBe(borrower.pid);
	});

	it("given a browser reused with no ledger entry, when we borrow, release and scan, then it is never killed (M20)", async () => {
		const userChrome = await spawnFixture();

		expect(await addLaunchedBrowserBorrower(userChrome.pid, opts)).toBe("unmanaged");
		expect(await releaseLaunchedBrowser(userChrome.pid, { kill: true, reason: "test" }, opts)).toBe("noop");
		expect(await reapOrphanLaunchedBrowsers(opts)).toEqual([]);
		expect(isAlive(userChrome.pid)).toBe(true);
	});

	it("given a launched browser with a caller-supplied profile, when its owner releases with kill, then the process dies and the profile stays (M21)", async () => {
		const browser = await spawnFixture();
		const profile = path.join(tempDir.path(), "profile");
		await fs.mkdir(profile);
		await Bun.write(path.join(profile, "Cookies"), "keep");
		await recordLaunchedBrowser(
			{
				browserPid: browser.pid,
				exe: "fixture",
				cdpPort: 0,
				headless: true,
				userDataDir: profile,
				ownerSessionId: "s",
			},
			opts,
		);

		expect(await releaseLaunchedBrowser(browser.pid, { kill: true, reason: "test" }, opts)).toBe("killed");
		await browser.proc.exited;
		expect(isAlive(browser.pid)).toBe(false);
		expect(await readEntry(browser.pid)).toBeUndefined();
		expect(await Bun.file(path.join(profile, "Cookies")).text()).toBe("keep");
	}, 20_000);

	it("given a browser that survives termination, when released, then release fails, the entry is kill-failed, and the same owner may not launch again (M22, M24)", async () => {
		const browser = await spawnFixture();
		await recordLaunchedBrowser(
			{ browserPid: browser.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
			opts,
		);
		const terminate = spyOn(Process.prototype, "terminate").mockResolvedValue(false);
		const waitForExit = spyOn(Process.prototype, "waitForExit").mockResolvedValue(false);
		try {
			await expect(releaseLaunchedBrowser(browser.pid, { kill: true, reason: "test" }, opts)).rejects.toThrow(
				new RegExp(`pid ${browser.pid}`),
			);
			expect((await readEntry(browser.pid))?.state).toBe("kill-failed");
			await expect(assertLaunchAllowed(opts)).rejects.toThrow(new RegExp(`pid ${browser.pid}`));
		} finally {
			terminate.mockRestore();
			waitForExit.mockRestore();
		}
	}, 20_000);

	it("given a release with kill, then exactly one lifecycle record with a duration is written (M25)", async () => {
		const browser = await spawnFixture();
		await recordLaunchedBrowser(
			{ browserPid: browser.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
			opts,
		);
		const info = spyOn(logger, "info");
		try {
			await releaseLaunchedBrowser(browser.pid, { kill: true, reason: "test" }, opts);
			const records = info.mock.calls.filter(([message]) => message === "browser.lifecycle");
			expect(records).toHaveLength(1);
			expect(records[0]![1]).toMatchObject({ action: "release", result: "ok", durationMs: expect.any(Number) });
		} finally {
			info.mockRestore();
		}
	}, 20_000);

	it("given a transfer, a reap and a refusal, then each writes exactly one lifecycle record naming the browser pid (M25)", async () => {
		const info = spyOn(logger, "info");
		const error = spyOn(logger, "error");
		try {
			const records = (action: string, pid: number) =>
				[...info.mock.calls, ...error.mock.calls].filter(
					([message, fields]) =>
						message === "browser.lifecycle" &&
						(fields as Record<string, unknown>).action === action &&
						String((fields as Record<string, unknown>).resource).endsWith(`pid ${pid}`),
				);

			const handedOff = await spawnFixture();
			const borrower = await spawnFixture();
			await recordLaunchedBrowser(
				{ browserPid: handedOff.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
				opts,
			);
			const entry = (await readEntry(handedOff.pid))!;
			entry.borrowers = [{ pid: borrower.pid, startTime: (await processStartTime(borrower.pid))! }];
			await Bun.write(path.join(opts.dir, `${handedOff.pid}.json`), JSON.stringify(entry));
			await releaseLaunchedBrowser(handedOff.pid, { kill: true, reason: "test" }, opts);
			expect(records("transfer", handedOff.pid)).toHaveLength(1);

			const orphan = await spawnFixture();
			const dead = await spawnFixture();
			await recordOwnedBy(orphan, dead);
			await killFixture(dead);
			await reapOrphanLaunchedBrowsers(opts);
			expect(records("reap", orphan.pid)).toHaveLength(1);

			const stuck = await spawnFixture();
			await recordLaunchedBrowser(
				{ browserPid: stuck.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
				opts,
			);
			const stuckEntry = (await readEntry(stuck.pid))!;
			stuckEntry.state = "kill-failed";
			await Bun.write(path.join(opts.dir, `${stuck.pid}.json`), JSON.stringify(stuckEntry));
			await expect(assertLaunchAllowed(opts)).rejects.toThrow();
			expect(records("refuse", stuck.pid)).toHaveLength(1);
		} finally {
			info.mockRestore();
			error.mockRestore();
		}
	}, 30_000);

	it("given no kill-failed entry, when launching, then the launch is allowed", async () => {
		await expect(assertLaunchAllowed(opts)).resolves.toBeUndefined();
	});
});
