/**
 * Contract: `createModelCallJournalStream` durably journals what each model call was given
 * (request-only context, effective post-hook payload) and what the provider returned, as
 * `omp:model-call` custom entries that never reach the LLM context, and never writes a late
 * call's records into a different session.
 */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	createModelCallJournalStream,
	type ModelCallJournalData,
} from "@oh-my-pi/pi-coding-agent/session/model-call-journal";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;

function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(stopReason === "error" ? { errorMessage: "provider exploded" } : {}),
		timestamp: 1,
	};
}

function contextWith(text: string): Context {
	return {
		systemPrompt: ["system"],
		messages: [{ role: "user", content: text, timestamp: 1 }],
		tools: [
			{
				name: "lookup",
				description: "Look something up",
				parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
			},
		] as unknown as Context["tools"],
	};
}

/** Fake provider: runs the payload hook, waits for `gate`, then emits `message` as its terminal event. */
function provider(payload: unknown, message: AssistantMessage, gate?: Promise<void>): StreamFn {
	return (_model, _context, options) => {
		const stream = new AssistantMessageEventStream();
		void (async () => {
			await options?.onPayload?.(payload, model, options.signal);
			await gate;
			stream.push(
				message.stopReason === "error" || message.stopReason === "aborted"
					? { type: "error", reason: message.stopReason, error: message }
					: { type: "done", reason: "stop", message },
			);
		})();
		return stream;
	};
}

function journal(manager: SessionManager): ModelCallJournalData[] {
	const records: ModelCallJournalData[] = [];
	for (const entry of manager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "omp:model-call") {
			records.push(entry.data as ModelCallJournalData);
		}
	}
	return records;
}

describe("createModelCallJournalStream", () => {
	it("journals two sequential calls with their own request-only context and effective payload, durably and outside LLM context", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		const seen: unknown[] = [];

		const first = contextWith("first question\n<request-only>injected reminder</request-only>");
		const firstStream = createModelCallJournalStream(manager, provider({ body: "raw" }, reply("first answer")))(
			model,
			first,
			{
				apiKey: "sk-secret",
				onPayload: async payload => {
					seen.push(payload);
					return { body: "replaced by hook" };
				},
			},
		);
		const firstDone = await (await firstStream).result();
		// Consumers mutating their objects afterwards must not rewrite history.
		first.messages[0] = { role: "user", content: "mutated later", timestamp: 2 };
		firstDone.content = [{ type: "text", text: "mutated reply" }];

		const secondStream = createModelCallJournalStream(manager, provider({ body: "p2" }, reply("second answer")))(
			model,
			contextWith("second question"),
			undefined,
		);
		await (await secondStream).result();
		await manager.flush();

		expect(seen).toEqual([{ body: "raw" }]);
		const reopened = await SessionManager.open(manager.getSessionFile()!, "/sessions", storage);
		const records = journal(reopened);
		const ids = [...new Set(records.map(r => r.requestId))];
		expect(ids).toHaveLength(2);
		const [a, b] = ids as [string, string];
		const phase = (id: string, name: ModelCallJournalData["phase"]) =>
			records.find(r => r.requestId === id && r.phase === name);

		expect(JSON.stringify(phase(a, "request")?.context)).toContain("injected reminder");
		expect(JSON.stringify(phase(a, "request")?.context)).not.toContain("mutated later");
		expect(JSON.stringify(phase(a, "request")?.context?.tools)).toContain('"required":["q"]');
		expect(phase(a, "payload")?.payload).toEqual({ body: "replaced by hook" });
		expect(phase(a, "response")?.message?.content).toEqual([{ type: "text", text: "first answer" }]);
		expect(JSON.stringify(phase(b, "request")?.context)).toContain("second question");
		expect(phase(b, "payload")?.payload).toEqual({ body: "p2" });
		expect(phase(b, "response")?.message?.content).toEqual([{ type: "text", text: "second answer" }]);
		expect(JSON.stringify(records)).not.toContain("sk-secret");
		expect(reopened.buildSessionContext().messages).toEqual([]);
		await reopened.close();
	});

	it("journals each tool as its model-facing schema, not the live harness object behind it", async () => {
		// Given a context whose tools are live objects holding session/runner back-references
		const context = contextWith("q");
		const schema = context.tools![0]!;
		const liveTool = {
			...schema,
			session: { cwd: "/cwd", settingsCache: "SESSION-GRAPH".repeat(1000) },
			runner: { extensions: ["RUNNER-GRAPH"] },
		} as unknown as Context["tools"];
		context.tools = [liveTool] as unknown as Context["tools"];
		context.inactiveTools = [liveTool] as unknown as Context["inactiveTools"];
		const manager = SessionManager.create("/cwd", "/sessions", new MemorySessionStorage());

		// When the call is journaled
		await (
			await createModelCallJournalStream(manager, provider({ body: "p" }, reply("a")))(model, context, undefined)
		).result();

		// Then only name, description and parameters are recorded
		const request = journal(manager).find(r => r.phase === "request");
		const expected = [{ name: "lookup", description: "Look something up", parameters: schema.parameters }];
		expect(request?.context?.tools).toEqual(expected as unknown as Context["tools"]);
		expect(request?.context?.inactiveTools).toEqual(expected as unknown as Context["inactiveTools"]);
		expect(JSON.stringify(request)).not.toContain("GRAPH");
	});

	it("journals a failed call's error message and still yields the original terminal event", async () => {
		const manager = SessionManager.create("/cwd", "/sessions", new MemorySessionStorage());
		const failure = reply("partial", "error");
		const stream = await createModelCallJournalStream(manager, provider({ n: 1 }, failure))(
			model,
			contextWith("q"),
			undefined,
		);
		const events = [];
		for await (const event of stream) events.push(event);

		expect(events.at(-1)).toEqual({ type: "error", reason: "error", error: failure });
		const records = journal(manager);
		const error = records.find(r => r.phase === "error");
		expect(error?.error).toBe("provider exploded");
		expect(error?.message?.content).toEqual([{ type: "text", text: "partial" }]);
		expect(new Set(records.map(r => r.requestId)).size).toBe(1);
	});

	it("correlates interleaved concurrent calls by request id", async () => {
		const manager = SessionManager.create("/cwd", "/sessions", new MemorySessionStorage());
		const releaseSlow = Promise.withResolvers<void>();
		const slow = createModelCallJournalStream(manager, provider({ who: "slow" }, reply("slow"), releaseSlow.promise));
		const fast = createModelCallJournalStream(manager, provider({ who: "fast" }, reply("fast")));

		const slowResult = (await slow(model, contextWith("slow q"), undefined)).result();
		await (await fast(model, contextWith("fast q"), undefined)).result();
		releaseSlow.resolve();
		await slowResult;

		const records = journal(manager);
		for (const who of ["slow", "fast"]) {
			const payload = records.find(r => r.phase === "payload" && JSON.stringify(r.payload).includes(who));
			const same = records.filter(r => r.requestId === payload?.requestId);
			expect(same.map(r => r.phase).sort()).toEqual(["payload", "request", "response"]);
			expect(JSON.stringify(same.find(r => r.phase === "request")?.context)).toContain(`${who} q`);
			expect(JSON.stringify(same.find(r => r.phase === "response")?.message)).toContain(who);
		}
	});

	it("records a late response in the session that dispatched the call, not the session that replaced it", async () => {
		const storage = new MemorySessionStorage();
		const manager = SessionManager.create("/cwd", "/sessions", storage);
		const release = Promise.withResolvers<void>();
		const hookRan = Promise.withResolvers<void>();
		const wrapped = createModelCallJournalStream(manager, provider({ n: 1 }, reply("late"), release.promise));

		const stream = await wrapped(model, contextWith("old session q"), { onPayload: () => hookRan.resolve() });
		await hookRan.promise;
		const originalFile = manager.getSessionFile()!;
		const oldSessionId = manager.getSessionId();
		await manager.newSession();
		release.resolve();
		const finished = await stream.result();
		await manager.flush();

		expect(manager.getSessionId()).not.toBe(oldSessionId);
		expect(journal(manager)).toEqual([]);
		const original = await SessionManager.open(originalFile, "/sessions", storage);
		const records = journal(original);
		expect(records.map(r => r.phase).sort()).toEqual(["payload", "request", "response"]);
		expect(records.find(r => r.phase === "response")?.message).toEqual(finished);
		await original.close();
	});

	it("fails the call explicitly when a replaced session has no file to record into", async () => {
		const manager = SessionManager.inMemory("/cwd");
		const release = Promise.withResolvers<void>();
		const hookRan = Promise.withResolvers<void>();
		const wrapped = createModelCallJournalStream(manager, provider({ n: 1 }, reply("late"), release.promise));

		const stream = await wrapped(model, contextWith("q"), { onPayload: () => hookRan.resolve() });
		await hookRan.promise;
		await manager.newSession();
		release.resolve();

		await expect(stream.result()).rejects.toThrow("no session file");
		expect(journal(manager)).toEqual([]);
	});
});
