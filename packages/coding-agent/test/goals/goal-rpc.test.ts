import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeController } from "@oh-my-pi/pi-coding-agent/goals/mode-controller";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { createRpcGoalMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { AcpBuiltinSlashCommandResult } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

type Fixture = { authStorage: AuthStorage; modelRegistry: ModelRegistry; model: Model; baseDir: TempDir };

type Harness = {
	session: AgentSession;
	goalMode: GoalModeController;
	output: string[];
	turns: () => number;
	continuations: () => number;
	command: (text: string) => Promise<AcpBuiltinSlashCommandResult>;
	cleanup: () => Promise<void>;
};

// Real-clock exception: the controller's 800ms continuation delay is an internal timer, so an
// absent continuation is only observable after it would have fired.
const QUIET_MS = 1100;

async function createFixture(): Promise<Fixture> {
	const baseDir = TempDir.createSync("@pi-goal-rpc-shared-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
	return { authStorage, modelRegistry, model, baseDir };
}

async function waitFor(condition: () => boolean, timeoutMs = 6000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(10);
	}
}

/**
 * Scripts the provider: every run is `goal get` (distinct arguments, so the loop guard sees new
 * evidence) followed by a text stop. The run index in `completeAtRun` calls `goal complete` instead.
 */
function scriptModel(session: AgentSession, options: { tokensPerCall?: number; completeAtRun?: number } = {}): void {
	const perCall = options.tokensPerCall ?? 1;
	let call = 0;
	session.agent.streamFn = () => {
		const index = call++;
		const run = Math.floor(index / 2);
		const toolTurn = index % 2 === 0;
		const args = run === options.completeAtRun ? { op: "complete" } : { op: "get", objective: `evidence-${run}` };
		const message = {
			role: "assistant" as const,
			content: toolTurn
				? [{ type: "toolCall" as const, id: `call-${index}`, name: "goal", arguments: args }]
				: [{ type: "text" as const, text: "Progress made." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			usage: {
				input: perCall,
				output: perCall,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: perCall * 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: toolTurn ? ("toolUse" as const) : ("stop" as const),
			timestamp: Date.now(),
		};
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
		});
		return stream;
	};
}

async function createHarness(
	fixture: Fixture,
	overrides: Record<string, unknown> = {},
	options: { withController?: boolean } = {},
): Promise<Harness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-rpc-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const settings = Settings.isolated({ "compaction.enabled": false, "goal.enabled": true, ...overrides });
	const toolSessionBase: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
	const initialTools = await createTools(toolSessionBase, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));
	const session = new AgentSession({
		agent: new Agent({
			initialState: { model: fixture.model, systemPrompt: ["Test"], tools: initialTools, messages: [] },
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry: fixture.modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const goalToolSession: ToolSession = {
		...toolSessionBase,
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
	};
	toolRegistry.set("goal", new GoalTool(goalToolSession) as unknown as Tool);

	const goalMode = createRpcGoalMode(session);
	// runRpcMode forwards every session event to the controller from its always-on subscription.
	let turns = 0;
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_start") turns++;
		void goalMode.handleSessionEvent(event);
	});
	const output: string[] = [];
	const runtimeGoalMode = options.withController === false ? undefined : goalMode;
	return {
		session,
		goalMode,
		output,
		turns: () => turns,
		continuations: () =>
			session.messages.filter(m => m.role === "custom" && m.customType === "goal-continuation").length,
		command: text =>
			executeAcpBuiltinSlashCommand(text, {
				session,
				sessionManager: session.sessionManager,
				settings,
				cwd: tempDir.path(),
				output: line => {
					output.push(line);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
				goalMode: runtimeGoalMode,
			}),
		cleanup: async () => {
			unsubscribe();
			goalMode.dispose();
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

describe("/goal over RPC/ACP", () => {
	let fixture: Fixture;
	let harness: Harness;

	beforeAll(async () => {
		fixture = await createFixture();
	});
	afterAll(() => {
		fixture.baseDir.removeSync();
	});
	beforeEach(async () => {
		harness = await createHarness(fixture);
	});
	afterEach(async () => {
		await harness.cleanup();
	});

	// Failure guarded: Paseo never lists /goal, so typing it becomes a paid plain prompt.
	it("advertises /goal and starts goal mode, returning the objective as the prompt", async () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.map(command => command.name)).toContain("goal");

		const result = await harness.command("/goal Ship the release");

		expect(result).toEqual({ prompt: "Ship the release" });
		expect(harness.session.getGoalModeState()).toMatchObject({
			enabled: true,
			goal: { objective: "Ship the release", status: "active" },
		});
		expect(harness.session.getActiveToolNames()).toContain("goal");
	});

	it("/guided-goal arms the goal tool and returns a hidden interview kickoff", async () => {
		const result = await harness.command("/guided-goal ship the release");

		expect(result).toEqual({
			prompt: expect.stringContaining("ship the release"),
			synthetic: true,
		});
		expect(result).toMatchObject({ prompt: expect.stringContaining("<rough-goal>") });
		expect(harness.session.getActiveToolNames()).toContain("goal");
		expect(harness.goalMode.enabled).toBe(false);
	});

	it("/guided-goal refuses while a goal is active", async () => {
		await harness.command("/goal Ship the release");

		const result = await harness.command("/guided-goal x");

		expect(result).toEqual({ consumed: true });
		expect(harness.output.at(-1)).toContain("Goal mode is already active");
	});

	// Failure guarded: /goal silently doing nothing (or being sent to the model) where no controller exists.
	it("reports loudly when the host provides no goal controller", async () => {
		const bare = await createHarness(fixture, {}, { withController: false });
		try {
			const result = await bare.command("/goal Ship the release");

			expect(result).toEqual({ consumed: true });
			expect(bare.output.join("\n")).toContain("Goal mode is not available in this mode.");
			expect(bare.session.getGoalModeState()).toBeUndefined();
		} finally {
			await bare.cleanup();
		}
	});

	// Failure guarded: starting a goal while plan mode owns the toolset corrupts the tool snapshot.
	it("refuses /goal under plan mode with the TUI wording", async () => {
		harness.session.setPlanModeState({ enabled: true, planFilePath: "/tmp/plan.md" });

		const result = await harness.command("/goal Ship the release");

		expect(result).toEqual({ consumed: true });
		expect(harness.output).toEqual(["Exit plan mode first."]);
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	// Failure guarded: pause/resume/budget/drop/show text commands diverging from controller state.
	it("pauses, resumes, budgets, shows and drops through the text handle", async () => {
		await harness.command("/goal Ship the release");

		await harness.command("/goal pause");
		expect(harness.goalMode.paused).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");

		await harness.command("/goal budget 100");
		expect(harness.output.at(-1)).toBe("Resume the goal before adjusting the budget.");

		await harness.command("/goal resume");
		expect(harness.goalMode.enabled).toBe(true);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("active");

		await harness.command("/goal budget 100");
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBe(100);
		await harness.command("/goal budget off");
		expect(harness.session.getGoalModeState()?.goal.tokenBudget).toBeUndefined();
		await harness.command("/goal budget nope");
		expect(harness.output.at(-1)).toBe("Goal budget must be a positive integer or `off`.");

		await harness.command("/goal show");
		expect(harness.output.at(-1)).toContain("Objective: Ship the release");

		await harness.command("/goal Replace it");
		expect(harness.output.at(-1)).toContain("Goal mode is already active");

		await harness.command("/goal drop");
		expect(harness.goalMode.enabled).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.status).not.toBe("active");
		expect(harness.session.getActiveToolNames()).not.toContain("goal");
	});
});

describe("RPC goal continuation", () => {
	let fixture: Fixture;
	let harness: Harness | undefined;

	beforeAll(async () => {
		fixture = await createFixture();
	});
	afterAll(() => {
		fixture.baseDir.removeSync();
	});
	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	async function startGoal(h: Harness): Promise<void> {
		const result = await h.command("/goal Ship the release");
		if (!result || !("prompt" in result)) throw new Error("expected /goal to return a prompt");
		await h.session.prompt(result.prompt);
	}

	// Failure guarded: a goal that stops after one turn and waits for the user, defeating /goal in Paseo.
	it("keeps taking turns without user input until the model completes the goal", async () => {
		harness = await createHarness(fixture);
		scriptModel(harness.session, { completeAtRun: 2 });

		await startGoal(harness);
		await waitFor(() => harness!.goalMode.enabled === false && harness!.turns() >= 3);

		// Run 0 came from the user prompt; runs 1 and 2 are hidden goal-continuation turns.
		expect(harness.turns()).toBe(3);
		expect(harness.continuations()).toBe(2);

		await Bun.sleep(QUIET_MS);
		expect(harness.turns()).toBe(3);
	});

	// Failure guarded: a paused goal that keeps spending tokens.
	it("stops continuing after /goal pause", async () => {
		harness = await createHarness(fixture);
		scriptModel(harness.session);

		await startGoal(harness);
		await waitFor(() => harness!.turns() >= 2);
		await harness.command("/goal pause");
		await harness.session.waitForIdle();
		const turnsAtPause = harness.turns();

		await Bun.sleep(QUIET_MS);

		expect(harness.turns()).toBe(turnsAtPause);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("paused");
	});

	// Failure guarded: runaway spend past the token budget.
	it("stops continuing once the token budget is exhausted", async () => {
		harness = await createHarness(fixture);
		scriptModel(harness.session, { tokensPerCall: 10 });
		await harness.command("/goal Ship the release");
		await harness.command("/goal budget 15");

		await harness.session.prompt("Ship the release");
		await waitFor(() => harness!.session.getGoalModeState()?.goal.status === "budget-limited");
		await harness.session.waitForIdle();
		const continuationsAtLimit = harness.continuations();

		await Bun.sleep(QUIET_MS);

		expect(harness.continuations()).toBe(continuationsAtLimit);
		expect(harness.session.getGoalModeState()?.goal.status).toBe("budget-limited");
	});

	// Failure guarded: ignoring goal.continuationModes, or running silently without auto-continue.
	it("does not continue when rpc is not in goal.continuationModes and says so", async () => {
		harness = await createHarness(fixture, { "goal.continuationModes": ["interactive"] });
		scriptModel(harness.session);

		await startGoal(harness);
		await harness.session.waitForIdle();
		await Bun.sleep(QUIET_MS);

		expect(harness.turns()).toBe(1);
		expect(harness.continuations()).toBe(0);
		expect(harness.output.join("\n")).toContain(
			"Auto-continue is off in rpc mode; add it to goal.continuationModes to keep working between turns.",
		);
	});
});
