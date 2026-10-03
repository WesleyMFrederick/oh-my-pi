import { describe, expect, it, vi } from "bun:test";
import type { Agent, AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Judge, JudgmentRequest, NoulAnswer } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { JUDGED_CONTENT_MAX_TOKENS, TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";
import { countTokens, Encoding } from "@oh-my-pi/pi-natives";

function judgedRule(name: string, fields: Partial<Rule>): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: `${name} guidance`,
		_source: { provider: "test", providerName: "test", path: `/rules/${name}.md`, level: "project" },
		...fields,
	};
}

/** Judge answering each question with the yes-probability its instructions map to (default 0). */
function fakeJudge(verdicts: Record<string, number>, gate?: Promise<void>) {
	const requests: JudgmentRequest[] = [];
	const judge = {
		label: "fake",
		judge: async (request: JudgmentRequest) => {
			requests.push(request);
			await gate;
			const answers: Record<string, NoulAnswer> = {};
			for (const id in request.questions) {
				answers[id] = { type: "noul", noul: verdicts[request.questions[id].instructions] ?? 0 };
			}
			return { api: "fake", provider: "fake", model: "fake", answers, usage: {} };
		},
	} as unknown as Judge;
	return { judge, requests };
}

/** `content` field of a judged `{ output, content }` state. */
function sentContent(request: JudgmentRequest): string {
	const { state } = request;
	if (typeof state === "object" && "content" in state) {
		const { content } = state;
		if (typeof content === "string") return content;
	}
	throw new Error("judgment state has no string `content`");
}

function setup(rules: Rule[], judge: Judge | ((model?: string) => Judge | undefined), branch: SessionEntry[] = []) {
	const manager = new TtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 0,
	});
	for (const rule of rules) expect(manager.addRule(rule)).toBe(true);
	let generation = 0;
	const abort = vi.fn();
	const warnings: { content: string; rules: string[] }[] = [];
	const host = {
		agent: { state: { messages: [], tools: [] }, abort } as unknown as Agent,
		sessionManager: {
			getCwd: () => "/work",
			appendTtsrInjection: vi.fn(),
			getBranch: () => branch,
		} as unknown as SessionManager,
		settings: {} as Settings,
		emitSessionEvent: async () => {},
		schedulePostPromptTask: vi.fn(),
		scheduleAgentContinue: vi.fn(),
		promptGeneration: () => 0,
		ruleJudge: typeof judge === "function" ? judge : () => judge,
		deliverRuleWarning: async (content: string, ruleNames: string[]) => {
			warnings.push({ content, rules: ruleNames });
		},
		sessionGeneration: () => generation,
	} satisfies TtsrCoordinatorHost;
	return {
		coordinator: new TtsrCoordinator(host, manager),
		abort,
		warnings,
		replaceSession: () => generation++,
	};
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return { role: "assistant", content, stopReason, timestamp: Date.now() } as AssistantMessage;
}

const PROMISES_TESTS = "Does the reply claim tests pass without having run them?";
const HAS_TODO = "Does the text leave a TODO for later?";

let entryId = 0;
/** Assistant turn that calls `read` on `path`. */
function readEntry(path: string): SessionEntry {
	const id = `e${entryId++}`;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: assistant([{ type: "toolCall", id, name: "read", arguments: { path } }], "toolUse"),
	};
}

/** `/skill:<name>` prompt entry. */
function skillPromptEntry(name: string): SessionEntry {
	return {
		type: "custom_message",
		id: `e${entryId++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: "",
		display: true,
		details: { name, path: `/skills/${name}/SKILL.md` },
	};
}

describe("TTSR judged rules", () => {
	it("never interrupts mid-stream and warns once on completion, asking only in-scope questions", async () => {
		const { judge, requests } = fakeJudge({ [PROMISES_TESTS]: 0.9 });
		const { coordinator, abort, warnings } = setup(
			[
				judgedRule("honest-tests", { question: PROMISES_TESTS, scope: ["text", "thinking"] }),
				judgedRule("rust-only", { question: HAS_TODO, scope: ["tool:edit(*.rs)"] }),
			],
			judge,
		);
		const message = assistant([
			{ type: "thinking", thinking: "tests probably pass" },
			{ type: "text", text: "All tests pass." },
		]);
		const streamed = await coordinator.checkMessageUpdate({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "All tests pass.", partial: message },
		} as AgentEvent);
		expect(streamed).toBe(false);
		expect(abort).not.toHaveBeenCalled();

		coordinator.onAssistantMessageEnd(message);
		await coordinator.settleJudgments();

		// Reply and reasoning are judged separately; the edit-scoped rule is never asked.
		expect(requests.map(request => Object.values(request.questions).map(q => q.instructions))).toEqual([
			[PROMISES_TESTS],
			[PROMISES_TESTS],
		]);
		// Both outputs flag the rule; it is delivered once.
		expect(warnings).toHaveLength(1);
		expect(warnings[0].rules).toEqual(["honest-tests"]);
		expect(warnings[0].content).toContain("honest-tests guidance");
	});

	it("asks only when the condition prefilter matches and ignores low-probability verdicts", async () => {
		const { judge, requests } = fakeJudge({ [HAS_TODO]: 0.4 });
		const { coordinator, warnings } = setup(
			[judgedRule("no-todo", { question: HAS_TODO, condition: ["TODO"], scope: ["text"] })],
			judge,
		);

		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "Done, nothing left." }]));
		await coordinator.settleJudgments();
		expect(requests).toHaveLength(0);

		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "TODO: wire the rest later." }]));
		await coordinator.settleJudgments();
		expect(requests).toHaveLength(1);
		expect(warnings).toHaveLength(0);
	});

	it("drops verdicts for aborted messages and for sessions replaced mid-judgment", async () => {
		const gate = Promise.withResolvers<void>();
		const { judge, requests } = fakeJudge({ [PROMISES_TESTS]: 1 }, gate.promise);
		const { coordinator, warnings, replaceSession } = setup(
			[judgedRule("honest-tests", { question: PROMISES_TESTS, scope: ["text"] })],
			judge,
		);

		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "All tests pass." }], "aborted"));
		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "All tests pass." }]));
		replaceSession();
		gate.resolve();
		await coordinator.settleJudgments();

		expect(requests).toHaveLength(1);
		expect(warnings).toHaveLength(0);
	});

	it("routes a rule with its own judge to that model and the rest to the judge role, isolating failures", async () => {
		// Given one rule pinned to jev, one on the judge role, and one pinned to a judge that fails
		const jev = fakeJudge({ [PROMISES_TESTS]: 0.9 });
		const role = fakeJudge({ [HAS_TODO]: 0.9 });
		const asked: (string | undefined)[] = [];
		const broken = {
			label: "broken",
			judge: async () => {
				throw new Error("no API key");
			},
		} as unknown as Judge;
		const judges: Record<string, Judge> = { "typesafe/jev-latest": jev.judge, "broken/model": broken };
		const { coordinator, warnings } = setup(
			[
				judgedRule("honest-tests", { question: PROMISES_TESTS, judge: "typesafe/jev-latest", scope: ["text"] }),
				judgedRule("no-todo", { question: HAS_TODO, scope: ["text"] }),
				judgedRule("pinned-broken", { question: "Is it broken?", judge: "broken/model", scope: ["text"] }),
			],
			model => {
				asked.push(model);
				return model === undefined ? role.judge : judges[model];
			},
		);

		// When a reply completes
		coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "All tests pass. TODO: docs." }]));
		await coordinator.settleJudgments();

		// Then each judge is asked only its own rules' questions, and the failing judge drops only its rule
		expect(asked.sort()).toEqual(["broken/model", "typesafe/jev-latest", undefined]);
		expect(jev.requests.map(request => Object.values(request.questions).map(q => q.instructions))).toEqual([
			[PROMISES_TESTS],
		]);
		expect(role.requests.map(request => Object.values(request.questions).map(q => q.instructions))).toEqual([
			[HAS_TODO],
		]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].rules.sort()).toEqual(["honest-tests", "no-todo"]);
	});

	it("sends as much output as fits Jev's state budget, measured in Jev tokens", async () => {
		const { judge, requests } = fakeJudge({});
		const { coordinator } = setup([judgedRule("no-todo", { question: HAS_TODO, scope: ["text"] })], judge);
		// One Jev token per character: 60k characters would overflow the ~33k-token branch limit.
		const chinese = "人人生而自由，在尊严和权利上一律平等。他们赋有理性和良心，并应以兄弟关系的精神相对待。".repeat(
			1_500,
		);
		// ~20k tokens in 96k characters: fits whole despite its length.
		const english = "The quick brown fox jumps over the lazy dog while the tests keep passing. ".repeat(1_300);
		for (const text of [chinese, english]) coordinator.onAssistantMessageEnd(assistant([{ type: "text", text }]));
		await coordinator.settleJudgments();

		const sent = requests.map(sentContent);
		expect(chinese.startsWith(sent[0])).toBe(true);
		const tokens = countTokens(sent[0], Encoding.Jev);
		expect(tokens).toBeLessThanOrEqual(JUDGED_CONTENT_MAX_TOKENS);
		expect(tokens).toBeGreaterThan(JUDGED_CONTENT_MAX_TOKENS - 50);
		expect(sent[1]).toBe(english);
	});

	it("asks a skill-gated rule only while its skill is the latest phase skill loaded", async () => {
		// Given a rule on during ce-brainstorm and off once ce-plan loads, beside an ungated rule
		// (verdicts stay "no", so `repeatMode: once` never retires the rule mid-test)
		const { judge, requests } = fakeJudge({});
		const branch: SessionEntry[] = [];
		const { coordinator } = setup(
			[
				judgedRule("what-not-how", {
					question: PROMISES_TESTS,
					scope: ["text"],
					whileSkill: ["ce-brainstorm"],
					untilSkill: ["ce-plan"],
				}),
				judgedRule("no-todo", { question: HAS_TODO, scope: ["text"] }),
			],
			judge,
			branch,
		);
		const asked = async () => {
			requests.length = 0;
			coordinator.onAssistantMessageEnd(assistant([{ type: "text", text: "All tests pass." }]));
			await coordinator.settleJudgments();
			return requests.flatMap(request => Object.values(request.questions).map(q => q.instructions));
		};

		// When no phase skill was loaded, then only the ungated rule is asked
		expect(await asked()).toEqual([HAS_TODO]);

		// When the agent reads only a reference file of the skill, then the phase stays off
		branch.push(readEntry("skill://ce-brainstorm/references/dialogue.md"));
		expect(await asked()).toEqual([HAS_TODO]);

		// When the agent reads the skill itself, then the gated rule is asked
		branch.push(readEntry("skill://ce-brainstorm"));
		expect((await asked()).sort()).toEqual([HAS_TODO, PROMISES_TESTS].sort());

		// When ce-plan loads, then the gated rule turns off
		branch.push(skillPromptEntry("ce-plan"));
		expect(await asked()).toEqual([HAS_TODO]);

		// When /skill:ce-brainstorm runs again, then it turns back on
		branch.push(skillPromptEntry("ce-brainstorm"));
		expect((await asked()).sort()).toEqual([HAS_TODO, PROMISES_TESTS].sort());
	});
});
