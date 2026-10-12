// Integration test — a real `omp --mode rpc` child that owns a launched browser. Contract (M5, M6, M3-style
// teardown): when a supervisor closes an RPC agent (stdin EOF, SIGTERM, SIGHUP) the launched browser is dead
// and confirmed within 1.5 s of the signal, so Paseo's SIGKILL 2 s later never strands it.
//
// The child's extension stands in for a browser open: it spawns a SIGTERM-ignoring fixture process (the
// "browser"), records it in the launch ledger as owned by this session, and registers a tab on it — the same
// state `browser.open` with `app.path` leaves behind — without launching Chrome.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const SRC = path.join(import.meta.dir, "..", "src");
const TEARDOWN_BUDGET_MS = 1_500;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => Promise<boolean> | boolean, deadlineMs: number, what: string): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		// Observing another process's side effects on disk/pid table: there is no event to await.
		await Bun.sleep(20);
	}
}

/**
 * Send `get_available_models` and resolve once its response frame arrives. That command awaits the startup
 * model refresh, so the reply proves the command loop is live AND the refresh (on a cold cache it writes
 * ~7 MB of model rows with synchronous SQLite calls that block the child's event loop for 1 s or more) is done.
 */
async function awaitRpcResponse(
	child: Bun.Subprocess<"pipe", "pipe", "pipe">,
	id: string,
	deadlineMs = 30_000,
): Promise<void> {
	child.stdin.write(`${JSON.stringify({ id, type: "get_available_models" })}\n`);
	await child.stdin.flush();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const deadline = Date.now() + deadlineMs;
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			if (buffered.includes(`"id":"${id}"`)) return;
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error(`timed out waiting for RPC response ${id}`);
}

function extensionSource(pidFile: string, fixtureScript: string): string {
	return `import * as fs from "node:fs";
import { recordLaunchedBrowser } from ${JSON.stringify(path.join(SRC, "tools/browser/launch-ledger"))};
import { getTabsMapForTest } from ${JSON.stringify(path.join(SRC, "tools/browser/tab-supervisor"))};
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		const browser = Bun.spawn(["/bin/sh", ${JSON.stringify(fixtureScript)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		browser.unref();
		const sessionId = ctx.sessionManager.getSessionId();
		await recordLaunchedBrowser({ browserPid: browser.pid, exe: "fixture", cdpPort: 0, headless: true, ownerSessionId: sessionId });
		getTabsMapForTest().set("fixture-tab", {
			name: "fixture-tab",
			backend: "worker",
			state: "alive",
			targetId: "fixture-target",
			kindTag: "spawned",
			ownerSessionId: sessionId,
			pending: new Map(),
			lastActivityAt: Date.now(),
			frozen: false,
			activateForScreenshot: false,
			info: {},
			worker: {
				mode: "inline",
				send() {},
				onMessage: () => () => {},
				onError: () => () => {},
				terminate: async () => {},
			},
			browser: {
				key: "fixture",
				kind: { kind: "spawned", path: "/fixture" },
				browser: { connected: false },
				refCount: 1,
				pid: browser.pid,
				subprocess: browser,
				ledgerPid: browser.pid,
				stealth: { browserSession: null, override: null },
			},
		});
		fs.writeFileSync(${JSON.stringify(pidFile)}, String(browser.pid));
	});
}
`;
}

type Trigger = "SIGTERM" | "SIGHUP" | "stdin-EOF" | "stdin-EOF then SIGTERM";

const CASES: Array<{ trigger: Trigger; row: string }> = [
	{ trigger: "SIGTERM", row: "M5" },
	{ trigger: "SIGHUP", row: "M6" },
	{ trigger: "stdin-EOF", row: "M5" },
	{ trigger: "stdin-EOF then SIGTERM", row: "M5" },
];

describe("RPC teardown of a launched browser", () => {
	for (const { trigger, row } of CASES) {
		it(`given an RPC agent owning a launched browser, when it gets ${trigger}, then the browser is dead within ${TEARDOWN_BUDGET_MS} ms and the ledger entry is gone (${row})`, async () => {
			await using temp = await TempDir.create("@rpc-teardown-");
			const pidFile = temp.join("browser.pid");
			const fixtureScript = temp.join("fake-browser.sh");
			await Bun.write(fixtureScript, "trap '' TERM HUP\nwhile :; do sleep 1; done\n");
			const extensionPath = temp.join("fixture-browser.ts");
			await Bun.write(extensionPath, extensionSource(pidFile, fixtureScript));
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(SRC, "cli.ts"),
					"--trusted-extension",
					extensionPath,
					"--mode",
					"rpc",
					"--provider",
					"anthropic",
					"--model",
					"claude-sonnet-4-5",
					"--no-session",
				],
				{
					cwd: temp.path(),
					env: {
						PATH: Bun.env.PATH,
						HOME: temp.join("home"),
						PI_CODING_AGENT_DIR: temp.join("agent"),
						XDG_CONFIG_HOME: temp.join("config"),
						XDG_DATA_HOME: temp.join("data"),
						XDG_STATE_HOME: temp.join("state"),
						XDG_CACHE_HOME: temp.join("cache"),
						CI: "true",
						PI_NO_TITLE: "1",
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 60_000,
				},
			);
			const stderr = new Response(child.stderr).text();
			let browserPid: number | undefined;
			try {
				await waitFor(() => Bun.file(pidFile).exists(), 30_000, "fixture browser to start");
				browserPid = Number(await Bun.file(pidFile).text());
				expect(isAlive(browserPid)).toBe(true);
				// Startup is still running when the extension's session_start writes the pid file (extension init,
				// model refresh, command discovery); a signal sent then queues behind that work and the measured
				// teardown would include it (measured: a 0.6-0.9 s event-loop stall that delayed the browser's
				// SIGTERM past the 1.5 s budget). Wait for the refresh to finish before timing teardown.
				await awaitRpcResponse(child, "ready-probe");

				const sentAt = performance.now();
				if (trigger === "SIGTERM" || trigger === "SIGHUP") child.kill(trigger);
				else {
					child.stdin.end();
					if (trigger === "stdin-EOF then SIGTERM") child.kill("SIGTERM");
				}
				await waitFor(() => !isAlive(browserPid!), TEARDOWN_BUDGET_MS + 1_000, "launched browser to die");
				const deadAfterMs = performance.now() - sentAt;
				expect(deadAfterMs, await stderr).toBeLessThan(TEARDOWN_BUDGET_MS);
				await child.exited;
				const ledgerDir = path.join(temp.join("state"), "omp", "run", "browser-launches");
				const leftover = await fs.readdir(ledgerDir).catch(() => [] as string[]);
				expect(leftover.filter(name => name.endsWith(".json"))).toEqual([]);
			} finally {
				// Only processes this test started are signalled.
				if (browserPid !== undefined && isAlive(browserPid)) process.kill(browserPid, "SIGKILL");
				child.kill("SIGKILL");
				// A startup timeout leaves `browserPid` unset while the child may still write the pid file later;
				// killing the child would then orphan the SIGTERM-ignoring fixture. The pid file lives in this
				// test's own temp dir, so the process it names is this test's fixture.
				await child.exited;
				const fixturePid = Number(
					(
						await Bun.file(pidFile)
							.text()
							.catch(() => "")
					).trim(),
				);
				if (Number.isInteger(fixturePid) && fixturePid > 0 && isAlive(fixturePid))
					process.kill(fixturePid, "SIGKILL");
			}
		}, 90_000);
	}
});
