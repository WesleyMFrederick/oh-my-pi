// Contract: a ledger entry that exists but cannot be read or validated is the only durable ownership record
// for a possibly-live browser. Release never deletes it (and never kills on its say-so), the reaper skips it,
// and a borrower treats the browser as someone else's. A confirmed-absent entry is still a clean noop.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	addLaunchedBrowserBorrower,
	processStartTime,
	reapOrphanLaunchedBrowsers,
	recordLaunchedBrowser,
	releaseLaunchedBrowser,
} from "../../src/tools/browser/launch-ledger";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("unreadable launch ledger entries", () => {
	let temp: TempDir;
	let dir: string;
	let browser: Bun.Subprocess;

	beforeEach(async () => {
		temp = TempDir.createSync("@ledger-unreadable-");
		dir = path.join(temp.path(), "ledger");
		browser = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore" });
		while ((await processStartTime(browser.pid)) === undefined) await Bun.sleep(10);
		await recordLaunchedBrowser(
			{ browserPid: browser.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: "s" },
			{ dir },
		);
	});

	afterEach(async () => {
		// Only the fixture this test started is signalled.
		browser.kill("SIGKILL");
		await browser.exited;
		await fs.chmod(dir, 0o700).catch(() => undefined);
		const file = path.join(dir, `${browser.pid}.json`);
		await fs.chmod(file, 0o600).catch(() => undefined);
		temp[Symbol.dispose]();
	});

	const entryFile = () => path.join(dir, `${browser.pid}.json`);
	const corrupt = {
		"unreadable (mode 000)": () => fs.chmod(entryFile(), 0o000),
		"malformed JSON": () => Bun.write(entryFile(), "{not json"),
		"JSON of the wrong shape": () => Bun.write(entryFile(), JSON.stringify({ browserPid: "x" })),
	};

	for (const [label, damage] of Object.entries(corrupt)) {
		it(`given an entry that is ${label}, when its owner releases with kill, then release throws naming the file and the entry and browser survive`, async () => {
			await damage();
			const error = await releaseLaunchedBrowser(browser.pid, { kill: true, reason: "test" }, { dir }).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect((error as Error).message).toContain(entryFile());
			expect(isAlive(browser.pid)).toBe(true);
			await fs.stat(entryFile());
		});

		it(`given an entry that is ${label}, when a borrower arrives and the reaper runs, then the browser is never killed and the entry is kept`, async () => {
			await damage();
			expect(await addLaunchedBrowserBorrower(browser.pid, { dir })).toBe("unmanaged");
			expect(await reapOrphanLaunchedBrowsers({ dir })).toEqual([]);
			expect(isAlive(browser.pid)).toBe(true);
			await fs.stat(entryFile());
		});
	}

	it("given the entry is confirmed absent, when release runs, then it is a noop and the browser is untouched", async () => {
		await fs.rm(entryFile());
		expect(await releaseLaunchedBrowser(browser.pid, { kill: true, reason: "test" }, { dir })).toBe("noop");
		expect(isAlive(browser.pid)).toBe(true);
	});

	it("given the ledger dir is unreadable (mode 000), when its owner releases with kill, then release throws naming the entry path and the entry and browser survive", async () => {
		await fs.chmod(dir, 0o000);
		const error = await releaseLaunchedBrowser(browser.pid, { kill: true, reason: "test" }, { dir }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect((error as Error).message).toContain(entryFile());
		expect(isAlive(browser.pid)).toBe(true);
		await fs.chmod(dir, 0o700);
		await fs.stat(entryFile());
	});

	it("given the ledger dir is unreadable (mode 000), when a borrower arrives, then it throws naming the entry path and the entry is intact afterwards", async () => {
		await fs.chmod(dir, 0o000);
		const error = await addLaunchedBrowserBorrower(browser.pid, { dir }).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect((error as Error).message).toContain(entryFile());
		expect(isAlive(browser.pid)).toBe(true);
		await fs.chmod(dir, 0o700);
		expect((await Bun.file(entryFile()).json()).browserPid).toBe(browser.pid);
	});
});
