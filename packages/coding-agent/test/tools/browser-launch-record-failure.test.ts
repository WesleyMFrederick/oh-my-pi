// Contract: when a launched browser cannot be written to the launch ledger, `open` fails loudly with the
// pid and cause, and the just-spawned browser is dead — never a successful but untracked open.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as ledger from "../../src/tools/browser/launch-ledger";
import { acquireBrowser, getBrowsersMapForTest } from "../../src/tools/browser/registry";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("launched browser that cannot be ledgered", () => {
	let temp: TempDir;
	let exe: string;

	beforeEach(async () => {
		temp = TempDir.createSync("@launch-record-failure-");
		ledger.setLedgerDirForTest(path.join(temp.path(), "ledger"));
		// Stand-in browser: ignores SIGTERM so only the SIGKILL fallback can end it.
		exe = path.join(temp.path(), "fake-browser");
		await Bun.write(exe, "#!/bin/sh\ntrap '' TERM\nexec sleep 300\n");
		await fs.chmod(exe, 0o755);
	});

	afterEach(() => {
		ledger.setLedgerDirForTest(undefined);
		temp[Symbol.dispose]();
	});

	it("given the ledger write fails, when opening an app.path browser, then open throws naming the pid and the spawned browser is dead", async () => {
		const record = spyOn(ledger, "recordLaunchedBrowser").mockRejectedValue(new Error("disk full"));
		try {
			const error = await acquireBrowser({ kind: "spawned", path: exe }, { cwd: temp.path() }).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toContain("disk full");
			const pid = Number(/pid (\d+)/.exec(message)?.[1]);
			expect(Number.isInteger(pid)).toBe(true);
			expect(isAlive(pid)).toBe(false);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			record.mockRestore();
		}
	}, 20_000);
});
