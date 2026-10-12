// Real concurrent omp-like processes against one ledger directory. Contracts: (1) a borrow racing the
// owner's release either lands before the decision (browser transfers, stays alive) or sees the entry gone
// (never resurrects it); (2) concurrent releases of one browser terminate it exactly once.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { processStartTime } from "../../src/tools/browser/launch-ledger";

const WORKER = path.join(import.meta.dir, "fixtures", "ledger-worker.ts");

interface Worker {
	proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	lines: AsyncGenerator<string>;
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
			yield buffered.slice(0, i);
			buffered = buffered.slice(i + 1);
		}
	}
}

function startWorker(mode: string, dir: string, browserPid: number): Worker {
	const proc = Bun.spawn([process.execPath, WORKER, mode, dir, String(browserPid)], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { proc, lines: readLines(proc.stdout) };
}

async function next(worker: Worker): Promise<unknown> {
	const line = await worker.lines.next();
	if (line.done) throw new Error(`worker exited early: ${await new Response(worker.proc.stderr).text()}`);
	return JSON.parse(line.value);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function spawnBrowserFixture(): Promise<Bun.Subprocess> {
	const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore" });
	while ((await processStartTime(proc.pid)) === undefined) await Bun.sleep(10);
	return proc;
}

describe("launch ledger across processes", () => {
	it("given a borrow racing the owner's kill release, then the browser is either transferred alive or killed with no resurrected entry (M19)", async () => {
		await using temp = await TempDir.create("@ledger-race-");
		const dir = path.join(temp.path(), "ledger");
		const outcomes = new Set<string>();
		for (let round = 0; round < 8; round++) {
			const browser = await spawnBrowserFixture();
			const owner = startWorker("own", dir, browser.pid);
			const borrower = startWorker("borrow", dir, browser.pid);
			try {
				expect(await next(owner)).toBe("ready");
				expect(await next(borrower)).toBe("ready");
				owner.proc.stdin.write("go\n");
				borrower.proc.stdin.write("go\n");
				await owner.proc.stdin.flush();
				await borrower.proc.stdin.flush();
				const ownerOutcome = await next(owner);
				const role = await next(borrower);
				const entryFile = Bun.file(path.join(dir, `${browser.pid}.json`));
				if (ownerOutcome === "transferred") {
					expect(role).toBe("borrower");
					expect(isAlive(browser.pid)).toBe(true);
					expect(await entryFile.exists()).toBe(true);
				} else {
					expect(ownerOutcome).toBe("killed");
					expect(role).toBe("unmanaged");
					expect(isAlive(browser.pid)).toBe(false);
					expect(await entryFile.exists()).toBe(false);
				}
				outcomes.add(String(ownerOutcome));
			} finally {
				// Only processes this test started are signalled.
				borrower.proc.stdin.end();
				browser.kill("SIGKILL");
				owner.proc.kill("SIGKILL");
				borrower.proc.kill("SIGKILL");
				await Promise.all([browser.exited, owner.proc.exited, borrower.proc.exited]);
			}
		}
		expect(outcomes.size).toBeGreaterThan(0);
	}, 60_000);

	it("given two concurrent kill releases of one browser, then exactly one kills it and logs one success record (M22)", async () => {
		await using temp = await TempDir.create("@ledger-twice-");
		const dir = path.join(temp.path(), "ledger");
		const browser = await spawnBrowserFixture();
		const worker = startWorker("release-twice", dir, browser.pid);
		try {
			const result = (await next(worker)) as {
				outcomes: string[];
				releaseRecords: number;
				leftover: string[];
			};
			expect([...result.outcomes].sort()).toEqual(["killed", "noop"]);
			expect(result.releaseRecords).toBe(1);
			expect(result.leftover).toEqual([]);
			await browser.exited;
			expect(isAlive(browser.pid)).toBe(false);
		} finally {
			browser.kill("SIGKILL");
			worker.proc.kill("SIGKILL");
			await Promise.all([browser.exited, worker.proc.exited]);
		}
	}, 30_000);

	it("given the owner's kill release racing another process's release of the same browser, then the browser dies once and the ledger dir is left empty (M22)", async () => {
		await using temp = await TempDir.create("@ledger-two-proc-");
		const dir = path.join(temp.path(), "ledger");
		for (let round = 0; round < 6; round++) {
			const browser = await spawnBrowserFixture();
			const owner = startWorker("own", dir, browser.pid);
			const other = startWorker("release-only", dir, browser.pid);
			try {
				expect(await next(owner)).toBe("ready");
				expect(await next(other)).toBe("ready");
				owner.proc.stdin.write("go\n");
				other.proc.stdin.write("go\n");
				await owner.proc.stdin.flush();
				await other.proc.stdin.flush();
				expect(await next(owner)).toBe("killed");
				// Entry still present: the other process is not the owner ("dropped"); already gone: "noop".
				expect(["noop", "dropped"]).toContain((await next(other)) as string);
				await browser.exited;
				expect(isAlive(browser.pid)).toBe(false);
				expect(await fs.readdir(dir)).toEqual([]);
			} finally {
				browser.kill("SIGKILL");
				owner.proc.kill("SIGKILL");
				other.proc.kill("SIGKILL");
				await Promise.all([browser.exited, owner.proc.exited, other.proc.exited]);
			}
		}
	}, 60_000);
});
