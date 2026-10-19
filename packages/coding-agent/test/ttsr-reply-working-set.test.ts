import { describe, expect, it, vi } from "bun:test";
import type { Agent, AgentEvent, AgentMessage, AgentTool, BeforeToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, JudgmentRequest, NoulAnswer } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";

const SCOPED_GLOBS = ["scratch/x/**"];
const IN_FOLDER = "scratch/x/a.ts";
const OUT_OF_FOLDER = "src/other/a.ts";
const QUESTION = "Does the reply use a do-not-use glossary word?";

function rule(name: string, fields: Partial<Rule>): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: `${name} guidance`,
		_source: { provider: "test", providerName: "test", path: `/rules/${name}.md`, level: "project" },
		...fields,
	};
}

/** Text rule gated to one folder, the shape a generated glossary rule takes. */
const glossaryRule = rule("glossary-detail", { condition: ["\\bdetail"], scope: ["text"], globs: SCOPED_GLOBS });

function setup(rules: Rule[]) {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 0,
	});
	for (const candidate of rules) expect(manager.addRule(candidate)).toBe(true);
	const requests: JudgmentRequest[] = [];
	const judge = {
		label: "fake",
		judge: async (request: JudgmentRequest) => {
			requests.push(request);
			const answers: Record<string, NoulAnswer> = {};
			for (const id in request.questions) answers[id] = { type: "noul", noul: 0.9 };
			return { api: "fake", provider: "fake", model: "fake", answers, usage: {} };
		},
	} as unknown as Judge;
	let generation = 0;
	const abort = vi.fn();
	const host = {
		agent: { state: { messages: [], tools: [] }, abort } as unknown as Agent,
		sessionManager: {
			getCwd: () => "/work",
			appendTtsrInjection: vi.fn(),
			getBranch: () => [],
		} as unknown as SessionManager,
		settings: {} as Settings,
		emitSessionEvent: async () => {},
		schedulePostPromptTask: vi.fn(),
		scheduleAgentContinue: vi.fn(),
		promptGeneration: () => 0,
		ruleJudge: () => judge,
		deliverRuleWarning: async () => {},
		sessionGeneration: () => generation,
	} satisfies TtsrCoordinatorHost;
	return { coordinator: new TtsrCoordinator(host, manager), abort, requests, replaceSession: () => generation++ };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, stopReason: "stop", timestamp: Date.now() } as AssistantMessage;
}

/** Starts an agent run the way the session routes it: `agent_start`, then the run's input messages. */
function startRun(coordinator: TtsrCoordinator, input: AgentMessage[]): void {
	coordinator.onAgentStart();
	for (const message of input) coordinator.onInputMessageStart(message);
}

function userPrompt(text: string, fields: { synthetic?: boolean } = {}): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now(), ...fields } as AgentMessage;
}

/** One tool turn: the response calls `read` on `path`, and the loop executes it. */
async function toolTurn(coordinator: TtsrCoordinator, path: string): Promise<void> {
	coordinator.onTurnStart();
	coordinator.onAssistantMessageStart();
	const toolCall = { type: "toolCall" as const, id: `call-${path}`, name: "read", arguments: { path } };
	const message = assistant([toolCall]);
	coordinator.onAssistantMessageEnd(message);
	await coordinator.beforeToolCall({
		assistantMessage: message,
		toolCall,
		tool: { name: "read" } as AgentTool,
		args: { path },
		context: { systemPrompt: "", messages: [], tools: [] },
	} as unknown as BeforeToolCallContext);
	coordinator.onTurnEnd();
}

/** A later reply turn streaming `text`; true when TTSR consumed it by interrupting. */
async function replyTurn(coordinator: TtsrCoordinator, text: string): Promise<boolean> {
	coordinator.onTurnStart();
	coordinator.onAssistantMessageStart();
	const message = assistant([{ type: "text", text }]);
	const fired = await coordinator.checkMessageUpdate({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
	} as AgentEvent);
	coordinator.onAssistantMessageEnd(message);
	coordinator.onTurnEnd();
	return fired;
}

describe("TTSR reply working set", () => {
	it("fires a folder-gated text rule on a later-turn reply after a tool call in that folder", async () => {
		// Given a run whose tool turn read a file in the gated folder
		const { coordinator, abort } = setup([glossaryRule]);
		startRun(coordinator, [userPrompt("tidy the evidence facts")]);
		await toolTurn(coordinator, IN_FOLDER);

		// When the final reply, its own turn, uses the word
		const fired = await replyTurn(coordinator, "the split detail step");

		// Then the rule fires
		expect(fired).toBe(true);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("counts eval-bridged tool calls toward the working set", async () => {
		// Given a run whose only in-folder call was dispatched through the eval bridge
		const { coordinator } = setup([glossaryRule]);
		startRun(coordinator, [userPrompt("tidy the evidence facts")]);
		await coordinator.beforeBridgedToolCall("bridged-1", { name: "read" } as AgentTool, { path: IN_FOLDER });

		// When the reply uses the word
		// Then the rule fires
		expect(await replyTurn(coordinator, "the split detail step")).toBe(true);
	});

	it("does not fire when the run only touched files outside the folder", async () => {
		// Given a run whose tool call stayed outside the gated folder
		const { coordinator, abort } = setup([glossaryRule]);
		startRun(coordinator, [userPrompt("fix the other module")]);
		await toolTurn(coordinator, OUT_OF_FOLDER);

		// When the reply uses the word
		const fired = await replyTurn(coordinator, "the split detail step");

		// Then the rule stays silent
		expect(fired).toBe(false);
		expect(abort).not.toHaveBeenCalled();
	});

	it("does not fire on a reply before any tool call", async () => {
		// Given a fresh run with no tool calls yet
		const { coordinator } = setup([glossaryRule]);
		startRun(coordinator, [userPrompt("what does detail mean?")]);

		// When the reply uses the word
		// Then the rule stays silent
		expect(await replyTurn(coordinator, "a detail is a small fact")).toBe(false);
	});

	it("starts an empty working set when a new USER prompt starts the next run", async () => {
		// Given a finished run that worked in the gated folder
		const { coordinator } = setup([glossaryRule]);
		startRun(coordinator, [userPrompt("tidy the evidence facts")]);
		await toolTurn(coordinator, IN_FOLDER);
		await replyTurn(coordinator, "done");

		// When the USER's next prompt starts a run that touches only another folder
		startRun(coordinator, [userPrompt("now fix the other module")]);
		await toolTurn(coordinator, OUT_OF_FOLDER);

		// Then the old folder no longer gates the reply in
		expect(await replyTurn(coordinator, "the split detail step")).toBe(false);
	});

	it("keeps the working set across a continuation that no USER prompt started", async () => {
		// Given a run that worked in the gated folder
		const { coordinator } = setup([glossaryRule]);
		startRun(coordinator, [userPrompt("tidy the evidence facts")]);
		await toolTurn(coordinator, IN_FOLDER);

		// When a continuation run starts with only a synthetic prompt
		startRun(coordinator, [userPrompt("continue", { synthetic: true })]);

		// Then its reply is still gated in
		expect(await replyTurn(coordinator, "the split detail step")).toBe(true);
	});

	it("drops the working set when the session is replaced", async () => {
		// Given a run that worked in the gated folder
		const { coordinator, replaceSession } = setup([glossaryRule]);
		startRun(coordinator, [userPrompt("tidy the evidence facts")]);
		await toolTurn(coordinator, IN_FOLDER);

		// When the session is replaced and continued without a USER prompt
		replaceSession();
		startRun(coordinator, []);

		// Then the old folder no longer gates the reply in
		expect(await replyTurn(coordinator, "the split detail step")).toBe(false);
	});

	it("gives a judged reply output the run's working set", async () => {
		// Given a judged rule gated to the folder and a run that read a file there
		const judged = rule("glossary-judged", { question: QUESTION, scope: ["text"], globs: SCOPED_GLOBS });
		const { coordinator, requests } = setup([judged]);
		startRun(coordinator, [userPrompt("tidy the evidence facts")]);
		await toolTurn(coordinator, IN_FOLDER);

		// When the reply completes in a later turn
		await replyTurn(coordinator, "the split detail step");
		await coordinator.settleJudgments();

		// Then the reply is judged against the question
		expect(requests.map(request => Object.values(request.questions).map(q => q.instructions))).toEqual([[QUESTION]]);
	});

	it("does not judge a reply whose run never touched the folder", async () => {
		// Given a judged rule gated to the folder and a run that read elsewhere
		const judged = rule("glossary-judged", { question: QUESTION, scope: ["text"], globs: SCOPED_GLOBS });
		const { coordinator, requests } = setup([judged]);
		startRun(coordinator, [userPrompt("fix the other module")]);
		await toolTurn(coordinator, OUT_OF_FOLDER);

		// When the reply completes
		await replyTurn(coordinator, "the split detail step");
		await coordinator.settleJudgments();

		// Then no judge request is made
		expect(requests).toHaveLength(0);
	});
});
