import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SessionInfoTool, type SessionInfoDetails } from "@oh-my-pi/pi-coding-agent/tools/session-info";

type LiveValues = {
	sessionId: string | null;
	sessionName: string | null;
	sessionFile: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	approvalMode: string | null;
	contextUsage: SessionInfoDetails["contextUsage"];
	messageCounts: SessionInfoDetails["messageCounts"];
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
	} | null;
	streaming: SessionInfoDetails["streaming"];
	compaction: SessionInfoDetails["compaction"];
};

function createSession(values: LiveValues): ToolSession {
	return {
		get cwd() {
			return values.cwd;
		},
		hasUI: false,
		getSessionFile: () => values.sessionFile,
		getSessionSpawns: () => null,
		getSessionId: () => values.sessionId,
		getSessionName: () => values.sessionName,
		getActiveModel: () => values.model as never,
		getThinkingLevel: () => values.thinkingLevel,
		getApprovalMode: () => values.approvalMode,
		getContextUsage: () => values.contextUsage,
		getMessageCounts: () => values.messageCounts,
		getUsageStatistics: () => values.usage as never,
		getStreamingState: () => values.streaming,
		getCompactionState: () => values.compaction,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

describe("SessionInfoTool", () => {
	test("reports only live calling-session metadata with a read-only, discoverable strict contract", async () => {
		const values: LiveValues = {
			sessionId: "session-first",
			sessionName: "First session",
			sessionFile: "/sessions/first.jsonl",
			cwd: "/workspace/first",
			model: { provider: "test-provider", id: "first-model" },
			thinkingLevel: "high",
			approvalMode: "always-ask",
			contextUsage: { tokens: 2_048, contextWindow: 8_192, percent: 25 },
			messageCounts: { user: 2, assistant: 3, toolCalls: 4, toolResults: 4, total: 13 },
			usage: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 400, totalTokens: 1_900, cost: 0.0125 },
			streaming: true,
			compaction: { active: false, speculation: "idle" },
		};
		const tool = new SessionInfoTool(createSession(values));

		expect(tool.name).toBe("session_info");
		expect(tool.approval).toBe("read");
		expect(tool.loadMode).toBe("discoverable");
		expect(tool.strict).toBe(true);
		expect(tool.parameters.assert({})).toEqual({});
		expect(() => tool.parameters.assert({ unexpected: true })).toThrow();
		const normalizedParameters = normalizeTools([tool], { injectIntent: true })?.[0]?.parameters as {
			properties?: Record<string, unknown>;
			required?: string[];
		};
		expect(normalizedParameters.properties).toEqual({});
		expect(normalizedParameters.required).toBeUndefined();

		const first = await tool.execute("session-info-first", {});
		const firstDetails = first.details;
		expect(firstDetails).toEqual({
			sessionId: "session-first",
			sessionName: "First session",
			sessionFile: "/sessions/first.jsonl",
			cwd: "/workspace/first",
			modelProvider: "test-provider",
			modelId: "first-model",
			thinkingLevel: "high",
			approvalMode: "always-ask",
			contextUsage: { tokens: 2_048, contextWindow: 8_192, percent: 25 },
			messageCounts: { user: 2, assistant: 3, toolCalls: 4, toolResults: 4, total: 13 },
			tokenCounts: { input: 1_000, output: 200, cacheRead: 300, cacheWrite: 400, total: 1_900 },
			cost: 0.0125,
			streaming: true,
			compaction: { active: false, speculation: "idle" },
		});
		const firstText = first.content.find(content => content.type === "text");
		if (!firstText || firstText.type !== "text") throw new Error("Expected session_info to return JSON text.");
		expect(JSON.parse(firstText.text)).toEqual(firstDetails);

		for (const prohibited of [
			"apiKey",
			"apiKeys",
			"accountId",
			"accountIds",
			"credentialSource",
			"credentialSources",
			"systemPrompt",
			"systemPrompts",
			"providerSession",
			"providerSessionSecret",
			"providerSessionSecrets",
			"toolSchema",
			"toolSchemas",
		]) {
			expect(firstDetails).not.toHaveProperty(prohibited);
		}
		values.sessionId = null;
		values.sessionName = null;
		values.sessionFile = null;
		values.cwd = "/workspace/second";
		values.model = null;
		values.thinkingLevel = null;
		values.approvalMode = null;
		values.contextUsage = null;
		values.messageCounts = null;
		values.usage = null;
		values.streaming = null;
		values.compaction = null;

		const second = await tool.execute("session-info-second", {});
		expect(second.details).toEqual({
			sessionId: null,
			sessionName: null,
			sessionFile: null,
			cwd: "/workspace/second",
			modelProvider: null,
			modelId: null,
			thinkingLevel: null,
			approvalMode: null,
			contextUsage: null,
			messageCounts: null,
			tokenCounts: null,
			cost: null,
			streaming: null,
			compaction: null,
		});
		const secondText = second.content.find(content => content.type === "text");
		if (!secondText || secondText.type !== "text") throw new Error("Expected session_info to return JSON text.");
		expect(JSON.parse(secondText.text)).toEqual(second.details);
	});

	test("reports the owning persisted journal ID before an advisor-local cache ID", async () => {
		const session = createSession({
			sessionId: "advisor-local-cache-id",
			sessionName: "Advisor session",
			sessionFile: "/sessions/persisted-journal.jsonl",
			cwd: "/workspace/advisor",
			model: null,
			thinkingLevel: null,
			approvalMode: null,
			contextUsage: null,
			messageCounts: null,
			usage: null,
			streaming: null,
			compaction: null,
		});
		session.sessionManager = { getSessionId: () => "persisted-journal-id" } as ToolSession["sessionManager"];

		const result = await new SessionInfoTool(session).execute("session-info-owned", {});
		if (!result.details) throw new Error("Expected session_info to return details.");

		expect(result.details.sessionId).toBe("persisted-journal-id");
	});
});
