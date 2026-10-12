// Contract (M3, M4, M13-M16, M21): a browser omp launched and recorded in the launch ledger dies when its
// session is disposed (abort or error path) or goes idle (headless only); a headed, persisted or unrecorded
// browser is never killed by the idle sweep. Outcomes are observed as real fixture-process liveness. The
// fixture is a real process standing in for the browser; tabs are seeded exactly as `open` leaves them.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { recordLaunchedBrowser, setLedgerDirForTest } from "../../src/tools/browser/launch-ledger";
import type { PuppeteerBrowserHandle } from "../../src/tools/browser/registry";
import {
	getTabsMapForTest,
	releaseIdleTabsForOwner,
	type WorkerTabSession,
} from "../../src/tools/browser/tab-supervisor";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitDead(pid: number): Promise<boolean> {
	const deadline = Date.now() + 3_000;
	// Observing another process's exit: no event to await for a non-child pid.
	while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
	return !isAlive(pid);
}

interface Seeded {
	pid: number;
	proc: Bun.Subprocess;
}

describe("launched browser lifecycle", () => {
	let temp: TempDir;
	let authStorage: AuthStorage;
	const spawned: Bun.Subprocess[] = [];

	beforeEach(() => {
		temp = TempDir.createSync("@launched-lifecycle-");
		setLedgerDirForTest(path.join(temp.path(), "ledger"));
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(() => {
		// Only fixtures this test spawned are signalled.
		for (const proc of spawned.splice(0)) if (isAlive(proc.pid)) proc.kill("SIGKILL");
		getTabsMapForTest().clear();
		setLedgerDirForTest(undefined);
		authStorage.close();
		temp.removeSync();
	});

	async function seedTab(opts: {
		owner: string;
		name?: string;
		headless?: boolean;
		persist?: boolean;
		recorded?: boolean;
		idleForMs?: number;
	}): Promise<Seeded> {
		const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		spawned.push(proc);
		const recorded = opts.recorded ?? true;
		if (recorded) {
			await recordLaunchedBrowser({
				browserPid: proc.pid,
				exe: "fixture",
				cdpPort: 0,
				headless: opts.headless ?? true,
				ownerSessionId: opts.owner,
			});
		}
		const name = opts.name ?? `tab-${proc.pid}`;
		const browser: PuppeteerBrowserHandle = {
			key: `fixture:${proc.pid}`,
			kind: { kind: "spawned", path: "/fixture", args: [] },
			// Closing a stand-in connection is a no-op; the process kill is what is under test.
			browser: { connected: false, disconnect: async () => undefined, close: async () => undefined } as never,
			refCount: 1,
			pid: proc.pid,
			subprocess: proc,
			headlessLaunch: opts.headless ?? true,
			ledgerPid: recorded ? proc.pid : undefined,
			stealth: { browserSession: null, override: null },
		};
		const tab: WorkerTabSession = {
			backend: "worker",
			name,
			browser,
			targetId: "target",
			state: "alive",
			info: { url: "about:blank", viewport: { width: 1, height: 1 }, targetId: "target" },
			pending: new Map(),
			kindTag: "spawned",
			ownerSessionId: opts.owner,
			persist: opts.persist,
			lastActivityAt: Date.now() - (opts.idleForMs ?? 0),
			frozen: false,
			worker: {
				send: () => undefined,
				onMessage: () => () => undefined,
				onError: () => () => undefined,
				terminate: async () => undefined,
				mode: "inline",
			},
			activateForScreenshot: false,
		};
		getTabsMapForTest().set(name, tab);
		return { pid: proc.pid, proc };
	}

	describe("idle sweep", () => {
		it("given a headless launched browser idle past the window, when the owner's sweep runs, then the browser process is dead and its ledger entry gone (M14)", async () => {
			const fx = await seedTab({ owner: "s", idleForMs: 5_000 });
			await releaseIdleTabsForOwner("s", { idleMs: 1_000 });
			expect(await waitDead(fx.pid)).toBe(true);
			const entries = await fs.readdir(path.join(temp.path(), "ledger")).catch(() => [] as string[]);
			expect(entries.filter(name => name === `${fx.pid}.json`)).toEqual([]);
		});

		it("given a headed launched browser, a persisted one, an unrecorded one and another session's, when the sweep runs, then every browser stays alive (M13, M15, M16)", async () => {
			const headed = await seedTab({ owner: "s", headless: false, idleForMs: 5_000 });
			const persisted = await seedTab({ owner: "s", persist: true, idleForMs: 5_000 });
			const unrecorded = await seedTab({ owner: "s", recorded: false, idleForMs: 5_000 });
			const foreign = await seedTab({ owner: "other", idleForMs: 5_000 });
			await releaseIdleTabsForOwner("s", { idleMs: 1_000 });
			for (const fx of [headed, persisted, unrecorded, foreign]) expect(isAlive(fx.pid)).toBe(true);
		});

		it("given a headless browser still inside the idle window, when the sweep runs, then it stays alive", async () => {
			const fx = await seedTab({ owner: "s", idleForMs: 10 });
			await releaseIdleTabsForOwner("s", { idleMs: 60_000 });
			expect(isAlive(fx.pid)).toBe(true);
		});
	});

	describe("session dispose", () => {
		function createSession(handler: () => { content: string[] }): AgentSession {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("expected bundled model");
			const mock = createMockModel({ handler });
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [] },
				streamFn: mock.stream,
			});
			return new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(temp.path()),
				settings: Settings.isolated(),
				modelRegistry: new ModelRegistry(authStorage, path.join(temp.path(), "models.yml")),
			});
		}

		it("given an aborted session owning a launched browser, when disposed, then that browser dies and another session's browser survives (M3, M21)", async () => {
			const session = createSession(() => ({ content: ["ok"] }));
			const id = session.sessionManager.getSessionId();
			const mine = await seedTab({ owner: id, headless: false });
			const theirs = await seedTab({ owner: "someone-else" });
			await session.abort();
			await session.dispose();
			expect(await waitDead(mine.pid)).toBe(true);
			expect(isAlive(theirs.pid)).toBe(true);
		});

		it("given a session whose model call failed, when disposed, then its launched browser dies (M4)", async () => {
			const session = createSession(() => {
				throw new Error("provider exploded");
			});
			const id = session.sessionManager.getSessionId();
			const mine = await seedTab({ owner: id });
			await session.prompt("hi").catch(() => undefined);
			await session.dispose();
			expect(await waitDead(mine.pid)).toBe(true);
		});
	});
});
