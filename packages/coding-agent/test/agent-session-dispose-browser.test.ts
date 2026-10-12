// Contract (M3, M4): disposing a session — after an error or a cancel — releases the browser tabs it
// owns with kill semantics, and starts that release before the slower shutdown steps so a supervisor's
// SIGKILL window cannot cut it off.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as tabSupervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession dispose releases owned browser tabs", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-browser-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
	}

	it("given an aborted session, when disposed, then it releases only its own tabs with kill, before dispose awaits anything", async () => {
		const release = spyOn(tabSupervisor, "releaseTabsForOwner").mockResolvedValue(0);
		try {
			const session = createSession();
			await session.abort();
			const disposing = session.dispose();
			// No await since dispose() was called: the release must already be in flight.
			expect(release).toHaveBeenCalledTimes(1);
			expect(release).toHaveBeenCalledWith(session.sessionManager.getSessionId(), { kill: true });
			await disposing;
			expect(release).toHaveBeenCalledTimes(1);
		} finally {
			release.mockRestore();
		}
	});
});
