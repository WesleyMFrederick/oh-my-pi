// Integration test — a real `omp --mode rpc` child. Contract (M5, M6): SIGTERM or SIGHUP, the signals a
// supervisor sends when it closes an RPC agent, run the session's dispose (which releases owned browser
// tabs) before the process dies, and the process still exits inside the supervisor's 2 s SIGKILL window.
// Dispose is observed through a `session_shutdown` extension handler that writes a marker file.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const TEARDOWN_BUDGET_MS = 2_000;

async function waitForFile(file: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		try {
			await fs.access(file);
			return;
		} catch {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
			// Real child process: no event to await for a file appearing on disk.
			await Bun.sleep(25);
		}
	}
}

describe("RPC mode signal teardown", () => {
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		it(`given a running RPC agent with stdin still open, when it receives ${signal}, then the session disposes and the process exits inside ${TEARDOWN_BUDGET_MS} ms (${signal === "SIGTERM" ? "M5" : "M6"})`, async () => {
			await using temp = await TempDir.create("@rpc-signal-");
			const loaded = temp.join("loaded");
			const disposed = temp.join("disposed");
			const extensionPath = temp.join("marker.ts");
			await Bun.write(
				extensionPath,
				`import * as fs from "node:fs";
export default function (pi) {
	fs.writeFileSync(${JSON.stringify(loaded)}, "1");
	pi.on("session_shutdown", () => {
		fs.writeFileSync(${JSON.stringify(disposed)}, "1");
	});
}
`,
			);
			const child = Bun.spawn(
				[
					process.execPath,
					path.join(import.meta.dir, "..", "src", "cli.ts"),
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
						XDG_CACHE_HOME: temp.join("cache"),
						CI: "true",
						PI_NO_TITLE: "1",
					},
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
					timeout: 30_000,
				},
			);
			const stderr = new Response(child.stderr).text();
			try {
				await waitForFile(loaded, 20_000);
				// Let the rpc loop finish startup so the signal lands on the running session.
				await Bun.sleep(500);
				const sentAt = performance.now();
				child.kill(signal);
				await child.exited;
				const elapsedMs = performance.now() - sentAt;
				expect(await Bun.file(disposed).exists(), await stderr).toBe(true);
				expect(elapsedMs).toBeLessThan(TEARDOWN_BUDGET_MS);
			} finally {
				child.kill("SIGKILL");
			}
		}, 40_000);
	}
});
