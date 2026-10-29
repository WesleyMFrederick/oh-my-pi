/**
 * Contract: `createModelCallJournalStream` durably journals what each model call was given
 * (request-only context, effective post-hook payload) and what the provider returned, as
 * `omp:model-call` custom entries that never reach the LLM context, and never writes a late
 * call's records into a different session.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { exportFromFile } from "@oh-my-pi/pi-coding-agent/export/html";
import {
	createModelCallJournalStream,
	type ModelCallJournalData,
	modelCallRecordsPath,
	resolveModelCallEntries,
} from "@oh-my-pi/pi-coding-agent/session/model-call-journal";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";

let dir: string;
const managers: SessionManager[] = [];
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-call-journal-"));
});
afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.close()));
	await fs.rm(dir, { recursive: true, force: true });
});

function createManager(): SessionManager {
	const manager = SessionManager.create(dir, dir, new FileSessionStorage());
	managers.push(manager);
	return manager;
}

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

async function journal(manager: SessionManager): Promise<ModelCallJournalData[]> {
	const entries = await resolveModelCallEntries(manager.getSessionFile()!, manager.getEntries());
	return entries.flatMap(entry =>
		entry.type === "custom" && entry.customType === "omp:model-call" ? [entry.data as ModelCallJournalData] : [],
	);
}

describe("createModelCallJournalStream", () => {
	it("externalizes request images and restores them without mutating manager entries", async () => {
		const manager = createManager();
		const data = Buffer.from("image bytes".repeat(200)).toString("base64");
		const context = contextWith("image");
		context.messages = [
			{
				role: "user",
				content: [{ type: "image", data, mimeType: "image/png" }],
				timestamp: 1,
			},
		];
		await (
			await createModelCallJournalStream(manager, provider({}, reply("seen")))(model, context, undefined)
		).result();
		const text = await Bun.file(modelCallRecordsPath(manager.getSessionFile()!)!).text();
		expect(text).toContain("blob:sha256:");
		expect(text).not.toContain(data);
		const entries = manager.getEntries();
		const before = structuredClone(entries);
		const records = await journal(manager);
		expect(records.find(record => record.phase === "request")?.context?.messages).toEqual(context.messages);
		expect(entries).toEqual(before);
	});

	it("separates a torn tail from every record of the next call", async () => {
		const manager = createManager();
		await Bun.write(modelCallRecordsPath(manager.getSessionFile()!)!, '{"version":2,"key":"torn');
		await (
			await createModelCallJournalStream(manager, provider({}, reply("answer")))(model, contextWith("q"), undefined)
		).result();
		const records = await journal(manager);
		expect(records.map(record => record.phase)).toEqual(["request", "payload", "response"]);
		for (const record of records) expect(record).not.toHaveProperty("unavailable");
	});

	it("journals two sequential calls with their own request-only context and effective payload, durably and outside LLM context", async () => {
		const storage = new FileSessionStorage();
		const manager = createManager();
		const seen: unknown[] = [];

		const first = contextWith(`${"x".repeat(200_000)}\n<request-only>injected reminder</request-only>`);
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
		const reopened = await SessionManager.open(manager.getSessionFile()!, dir, storage);
		const records = await journal(reopened);
		for (const entry of reopened.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== "omp:model-call") continue;
			for (const field of ["context", "payload", "message", "error"]) {
				expect(entry.data).not.toHaveProperty(field);
			}
			expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(1024);
		}
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
		const manager = createManager();

		// When the call is journaled
		await (
			await createModelCallJournalStream(manager, provider({ body: "p" }, reply("a")))(model, context, undefined)
		).result();

		// Then only name, description and parameters are recorded
		const request = (await journal(manager)).find(r => r.phase === "request");
		const expected = [{ name: "lookup", description: "Look something up", parameters: schema.parameters }];
		expect(request?.context?.tools).toEqual(expected as unknown as Context["tools"]);
		expect(request?.context?.inactiveTools).toEqual(expected as unknown as Context["inactiveTools"]);
		expect(JSON.stringify(request)).not.toContain("GRAPH");
	});

	it("journals a failed call's error message and still yields the original terminal event", async () => {
		const manager = createManager();
		const failure = reply("partial", "error");
		const stream = await createModelCallJournalStream(manager, provider({ n: 1 }, failure))(
			model,
			contextWith("q"),
			undefined,
		);
		const events = [];
		for await (const event of stream) events.push(event);

		expect(events.at(-1)).toEqual({ type: "error", reason: "error", error: failure });
		const records = await journal(manager);
		const error = records.find(r => r.phase === "error");
		expect(error?.error).toBe("provider exploded");
		expect(error?.message?.content).toEqual([{ type: "text", text: "partial" }]);
		expect(new Set(records.map(r => r.requestId)).size).toBe(1);
	});

	it("correlates interleaved concurrent calls by request id", async () => {
		const manager = createManager();
		const releaseSlow = Promise.withResolvers<void>();
		const slow = createModelCallJournalStream(manager, provider({ who: "slow" }, reply("slow"), releaseSlow.promise));
		const fast = createModelCallJournalStream(manager, provider({ who: "fast" }, reply("fast")));

		const slowResult = (await slow(model, contextWith("slow q"), undefined)).result();
		await (await fast(model, contextWith("fast q"), undefined)).result();
		releaseSlow.resolve();
		await slowResult;

		const records = await journal(manager);
		for (const who of ["slow", "fast"]) {
			const payload = records.find(r => r.phase === "payload" && JSON.stringify(r.payload).includes(who));
			const same = records.filter(r => r.requestId === payload?.requestId);
			expect(same.map(r => r.phase).sort()).toEqual(["payload", "request", "response"]);
			expect(JSON.stringify(same.find(r => r.phase === "request")?.context)).toContain(`${who} q`);
			expect(JSON.stringify(same.find(r => r.phase === "response")?.message)).toContain(who);
		}
	});

	it("records a late response in the session that dispatched the call, not the session that replaced it", async () => {
		const storage = new FileSessionStorage();
		const manager = createManager();
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
		expect(await journal(manager)).toEqual([]);
		const original = await SessionManager.open(originalFile, dir, storage);
		const records = await journal(original);
		expect(records.map(r => r.phase).sort()).toEqual(["payload", "request", "response"]);
		expect(records.find(r => r.phase === "response")?.message).toEqual(finished);
		await original.close();
	});

	it("leaves in-memory call results unchanged and records nothing, even across a session switch", async () => {
		const manager = SessionManager.inMemory("/cwd");
		const release = Promise.withResolvers<void>();
		const hookRan = Promise.withResolvers<void>();
		const wrapped = createModelCallJournalStream(manager, provider({ n: 1 }, reply("late"), release.promise));

		const stream = await wrapped(model, contextWith("q"), { onPayload: () => hookRan.resolve() });
		await hookRan.promise;
		await manager.newSession();
		release.resolve();

		expect(await stream.result()).toEqual(reply("late"));
		expect(manager.getEntries()).toEqual([]);
		expect(await fs.readdir(dir)).toEqual([]);
	});

	for (const operation of ["branch", "forkFrom", "forkFromWithArtifacts", "persistCopy"] as const) {
		it(`keeps inherited model-call bodies readable after ${operation}`, async () => {
			const source = createManager();
			await (
				await createModelCallJournalStream(
					source,
					provider({ body: "carried payload" }, reply("carried response")),
				)(model, contextWith("carried question"), undefined)
			).result();
			await source.flush();
			const sourceFile = source.getSessionFile()!;
			let destination = source;
			if (operation === "branch") {
				source.createBranchedSession(source.getLeafId()!);
				await (
					await createModelCallJournalStream(source, provider({ body: "new payload" }, reply("new response")))(
						model,
						contextWith("new question"),
						undefined,
					)
				).result();
			} else if (operation === "persistCopy") {
				destination = await source.persistCopy({ sessionDir: dir });
				managers.push(destination);
			} else {
				destination = await SessionManager.forkFrom(
					sourceFile,
					dir,
					dir,
					new FileSessionStorage(),
					operation === "forkFrom" ? { copyArtifacts: false } : undefined,
				);
				managers.push(destination);
			}
			expect(destination.getSessionFile()).not.toBe(sourceFile);
			const records = await journal(destination);
			expect(records.find(record => record.phase === "request")?.context?.messages[0]?.content).toBe(
				"carried question",
			);
			expect(records.find(record => record.phase === "payload")?.payload).toEqual({ body: "carried payload" });
			expect(records.find(record => record.phase === "response")?.message?.content).toEqual([
				{ type: "text", text: "carried response" },
			]);
			if (operation === "branch") {
				expect(
					records.filter(record => record.phase === "request").map(record => record.context?.messages[0]?.content),
				).toEqual(["carried question", "new question"]);
				expect(
					records.filter(record => record.phase === "response").map(record => record.message?.content),
				).toEqual([[{ type: "text", text: "carried response" }], [{ type: "text", text: "new response" }]]);
			}
		});
	}

	it("marks missing sidecar records without changing legacy inline records or manager entries", async () => {
		const manager = createManager();
		await (
			await createModelCallJournalStream(manager, provider({ body: "p" }, reply("a")))(
				model,
				contextWith("q"),
				undefined,
			)
		).result();
		const legacy: ModelCallJournalData = {
			version: 1,
			requestId: "legacy",
			phase: "request",
			model: { provider: model.provider, id: model.id, api: model.api },
			context: contextWith("legacy question"),
		};
		manager.appendCustomEntry("omp:model-call", legacy);
		await fs.rm(modelCallRecordsPath(manager.getSessionFile()!)!);
		const entries = manager.getEntries();
		const resolved = await resolveModelCallEntries(manager.getSessionFile()!, entries);
		expect(resolved).not.toBe(entries);
		expect(
			resolved.slice(0, 3).map(entry => {
				if (entry.type !== "custom") throw new Error("Expected model-call pointer");
				const data = entry.data;
				return data && typeof data === "object" && "unavailable" in data ? data.unavailable : undefined;
			}),
		).toEqual(["missing", "missing", "missing"]);
		expect(resolved.at(-1)).toBe(entries.at(-1));
		expect(entries[0]?.type === "custom" && entries[0].data).not.toHaveProperty("unavailable");
	});

	it("embeds resolved model-call bodies in standalone HTML exports", async () => {
		const manager = createManager();
		await (
			await createModelCallJournalStream(manager, provider({ body: "export payload" }, reply("export response")))(
				model,
				contextWith("export question"),
				undefined,
			)
		).result();
		await manager.flush();
		const outputPath = path.join(dir, "export.html");
		await exportFromFile(manager.getSessionFile()!, { outputPath });
		const { document } = parseHTML(await Bun.file(outputPath).text());
		const embedded = document.getElementById("session-data")!.textContent!;
		const data = JSON.parse(Buffer.from(embedded.trim(), "base64").toString()) as {
			entries: { data?: ModelCallJournalData }[];
		};
		const records = data.entries.map(entry => entry.data);
		expect(records.find(record => record?.phase === "request")?.context?.messages[0]?.content).toBe(
			"export question",
		);
		expect(records.find(record => record?.phase === "payload")?.payload).toEqual({ body: "export payload" });
		expect(records.find(record => record?.phase === "response")?.message?.content).toEqual([
			{ type: "text", text: "export response" },
		]);
	});

	it("embeds resolved sub-session request and response bodies in the parent export", async () => {
		const parent = createManager();
		parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
		await parent.flush();
		await parent.ensureOnDisk();
		const parentFile = parent.getSessionFile()!;
		const childFile = path.join(parentFile.slice(0, -6), "agent-child.jsonl");
		const child = createManager();
		await child.setSessionFile(childFile);
		await (
			await createModelCallJournalStream(child, provider({}, reply("child response")))(
				model,
				contextWith("child question"),
				undefined,
			)
		).result();
		await child.flush();
		const outputPath = path.join(dir, "sub-export.html");
		await exportFromFile(parentFile, { outputPath });
		const { document } = parseHTML(await Bun.file(outputPath).text());
		const embedded = document.getElementById("session-data")!.textContent!;
		const data = JSON.parse(Buffer.from(embedded.trim(), "base64").toString()) as {
			subSessions: Record<string, { entries: { data?: ModelCallJournalData }[] }>;
		};
		const records = data.subSessions["agent-child"]!.entries.map(entry => entry.data);
		expect(records.find(record => record?.phase === "request")?.context?.messages[0]?.content).toBe("child question");
		expect(records.find(record => record?.phase === "response")?.message?.content).toEqual([
			{ type: "text", text: "child response" },
		]);
	});
});
