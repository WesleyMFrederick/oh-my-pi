// Integration test — real timers and a real fixture process: the contract is that the broker stops a
// daemon once no client holds it for `idleStopMs` and never while a holder remains. Outcomes are
// observed through process liveness (kill -0) and the broker's own RPC state, not log text, except
// the one-record-per-action evidence contract.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { runPsCommand } from "../../src/cli/ps-cli";
import * as clientModule from "../../src/launch/client";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const NAME = "fixture.browser";
const IDLE_STOP_MS = 400;

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const saved = [DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV, DAEMON_IDLE_GRACE_ENV].map(
		name => [name, process.env[name]] as const,
	);
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "60000";
	const broker = startDaemonBrokerFromEnvironment();
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return broker;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface Harness {
	projectDir: string;
	runtimeDir: string;
	broker: Promise<void>;
	clients: DaemonBrokerClient[];
	newClient(): Promise<DaemonBrokerClient>;
	start(client: DaemonBrokerClient, extra?: { idleStopMs?: number; detached?: boolean }): Promise<number>;
}

describe("daemon broker holders", () => {
	let tempDir: TempDir;
	let h: Harness;
	let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;
	let errorSpy: ReturnType<typeof spyOn<typeof logger, "error">>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-launch-holders-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const clients: DaemonBrokerClient[] = [];
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
		clients.push(first);
		const broker = startBroker(projectDir, runtimeDir);
		h = {
			projectDir,
			runtimeDir,
			broker,
			clients,
			async newClient() {
				const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 60_000 });
				clients.push(client);
				return client;
			},
			async start(client, extra) {
				const started = await client.request({
					op: "start",
					spec: {
						name: NAME,
						application: process.execPath,
						args: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: extra?.detached ?? false,
						detached: extra?.detached ?? false,
						idleStopMs: extra?.idleStopMs ?? IDLE_STOP_MS,
					},
				});
				if (started.op !== "start" || started.daemon.pid === undefined) throw new Error("fixture did not start");
				return started.daemon.pid;
			},
		};
		infoSpy = spyOn(logger, "info");
		errorSpy = spyOn(logger, "error");
	});

	afterEach(async () => {
		infoSpy.mockRestore();
		errorSpy.mockRestore();
		await h.clients[0]!.request({ op: "shutdown" }).catch(() => undefined);
		for (const client of h.clients) client.close();
		await h.broker.catch(() => undefined);
		tempDir[Symbol.dispose]();
	});

	async function hold(client: DaemonBrokerClient, holder: string): Promise<void> {
		await client.request({ op: "hold", name: NAME, holder });
	}
	async function unhold(client: DaemonBrokerClient, holder: string): Promise<void> {
		await client.request({ op: "unhold", name: NAME, holder });
	}
	async function waitExit(client: DaemonBrokerClient, timeoutMs: number): Promise<boolean> {
		const result = await client.request({ op: "wait", name: NAME, for: "exit", timeoutMs });
		return result.op === "wait" && !result.timedOut;
	}
	async function stateOf(client: DaemonBrokerClient): Promise<string> {
		const result = await client.request({ op: "describe", name: NAME });
		return result.op === "describe" ? result.daemon.state : "unknown";
	}
	function lifecycleRecords(action: string): Array<Record<string, unknown>> {
		return [...infoSpy.mock.calls, ...errorSpy.mock.calls]
			.filter(
				([message, fields]) =>
					message === "browser.lifecycle" && (fields as { action?: string })?.action === action,
			)
			.map(([, fields]) => fields as Record<string, unknown>);
	}

	it("given one holder that unholds, when the grace passes, then the browser process is gone and one stop-ok record exists (M1, M13, M25)", async () => {
		const a = h.clients[0]!;
		const pid = await h.start(a);
		await hold(a, "a");
		await unhold(a, "a");
		expect(await waitExit(a, 5_000)).toBe(true);
		expect(isAlive(pid)).toBe(false);
		expect(lifecycleRecords("hold")).toHaveLength(1);
		expect(lifecycleRecords("unhold")).toHaveLength(1);
		// The exit event settles the daemon before the broker's stop action finishes and logs its record.
		const stopsFor = (): Array<Record<string, unknown>> =>
			lifecycleRecords("stop").filter(record => String(record.resource).endsWith(`pid ${pid}`));
		for (const deadline = Date.now() + 5_000; stopsFor().length === 0 && Date.now() < deadline;) {
			// The record is written by the broker after the exit event; there is no signal to await.
			await Bun.sleep(10);
		}
		expect(stopsFor()).toHaveLength(1);
		const stops = stopsFor();
		expect(stops[0]).toMatchObject({ result: "ok", reason: "idle-unheld" });
		for (const record of [...lifecycleRecords("hold"), ...lifecycleRecords("unhold"), ...stops]) {
			expect(typeof record.durationMs).toBe("number");
		}
	}, 20_000);

	it("given no holder and an idle connected client, when the grace passes, then the browser stops and the client socket still works (M2)", async () => {
		const a = h.clients[0]!;
		const idle = await h.newClient();
		const pid = await h.start(a);
		expect(await waitExit(a, 5_000)).toBe(true);
		expect(isAlive(pid)).toBe(false);
		const ping = await idle.request({ op: "ping" });
		expect(ping.op).toBe("ping");
	}, 20_000);

	it("given two holders, when one unholds, then the browser keeps running (M9)", async () => {
		const a = h.clients[0]!;
		const b = await h.newClient();
		const pid = await h.start(a);
		await hold(a, "a");
		await hold(b, "b");
		await unhold(a, "a");
		expect(await waitExit(a, IDLE_STOP_MS * 3)).toBe(false);
		expect(isAlive(pid)).toBe(true);
	}, 20_000);

	it("given the grace is running, when a new hold arrives, then the stop is cancelled (M10)", async () => {
		const a = h.clients[0]!;
		const b = await h.newClient();
		const pid = await h.start(a, { idleStopMs: 800 });
		await hold(a, "a");
		await unhold(a, "a");
		await Bun.sleep(300);
		await hold(b, "b");
		expect(await waitExit(a, 1_500)).toBe(false);
		expect(isAlive(pid)).toBe(true);
	}, 20_000);

	it("given a holder whose connection drops without unholding, when the grace passes, then the browser stops (M11)", async () => {
		const a = h.clients[0]!;
		const crashing = await h.newClient();
		const pid = await h.start(a);
		await hold(crashing, "crashing");
		crashing.close();
		expect(await waitExit(a, 5_000)).toBe(true);
		expect(isAlive(pid)).toBe(false);
	}, 20_000);

	it("given a holder and a detached daemon, when the broker restarts, then the holder re-holds and the daemon is not stopped (M12)", async () => {
		const a = h.clients[0]!;
		const pid = await h.start(a, { idleStopMs: 600, detached: true });
		await hold(a, "a");
		await a.request({ op: "shutdown" });
		await h.broker;
		h.broker = startBroker(h.projectDir, h.runtimeDir);
		// The holder's connection to the old broker closed; it must re-publish on its own.
		expect(await waitExit(a, 2_500)).toBe(false);
		expect(isAlive(pid)).toBe(true);
		await unhold(a, "a");
		expect(await waitExit(a, 5_000)).toBe(true);
		expect(isAlive(pid)).toBe(false);
	}, 30_000);

	it("given a daemon that cannot be terminated, when stop is requested, then the RPC fails naming the pid and an error record is written (M22, M25)", async () => {
		const a = h.clients[0]!;
		const pid = await h.start(a, { idleStopMs: 60_000 });
		const terminate = spyOn(Process.prototype, "terminate").mockResolvedValue(false);
		try {
			await expect(a.request({ op: "stop", name: NAME, timeoutMs: 100 })).rejects.toThrow(new RegExp(`pid ${pid}`));
			expect(await stateOf(a)).not.toBe("exited");
			const stops = lifecycleRecords("stop").filter(record => String(record.resource).endsWith(`pid ${pid}`));
			expect(stops).toHaveLength(1);
			expect(stops[0]).toMatchObject({ result: "failed" });
			expect(errorSpy.mock.calls.some(([message]) => message === "browser.lifecycle")).toBe(true);
		} finally {
			terminate.mockRestore();
			// The fixture is ours: stop it for real so the test leaves nothing behind.
			process.kill(pid, "SIGKILL");
		}
	}, 20_000);

	it("given a daemon that cannot be terminated, when `omp ps stop` runs, then the command reports the pid and exits nonzero (M22)", async () => {
		const a = h.clients[0]!;
		const pid = await h.start(a, { idleStopMs: 60_000 });
		const terminate = spyOn(Process.prototype, "terminate").mockResolvedValue(false);
		// The CLI resolves its broker from the project scope; hand it this test's isolated broker.
		const scope = spyOn(clientModule, "daemonClientForProject").mockResolvedValue(a);
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const priorExitCode = process.exitCode;
		try {
			await runPsCommand({
				action: "stop",
				name: NAME,
				flags: { all: false, json: false, plain: true, follow: false, head: false, timeout: 0.1 },
			});
			expect(process.exitCode).toBe(1);
			expect(String(stderr.mock.calls[0]?.[0])).toContain(`pid ${pid}`);
		} finally {
			process.exitCode = priorExitCode;
			stderr.mockRestore();
			scope.mockRestore();
			terminate.mockRestore();
			process.kill(pid, "SIGKILL");
		}
	}, 20_000);
});
