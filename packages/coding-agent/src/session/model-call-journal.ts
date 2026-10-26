import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Tool } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { logger } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import type { SessionManager } from "./session-manager";

export const MODEL_CALL_CUSTOM_TYPE = "omp:model-call";

export interface ModelCallJournalData {
	version: 1;
	requestId: string;
	phase: "request" | "payload" | "response" | "error";
	model: { provider: string; id: string; api: string };
	context?: Context;
	payload?: unknown;
	message?: AssistantMessage;
	error?: string;
}

type ModelCallRecord = Omit<ModelCallJournalData, "version" | "requestId" | "model">;

function snapshot<T>(value: T): T {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("Model-call journal value is not JSON-serializable");
	return JSON.parse(json) as T;
}

const TOOL_SCHEMA_KEYS = [
	"name",
	"description",
	"parameters",
	"strict",
	"deferLoading",
	"customFormat",
	"customWireName",
	"native",
	"examples",
] as const satisfies readonly (keyof Tool)[];

function toolSchema(tool: Tool): Tool {
	return Object.fromEntries(
		TOOL_SCHEMA_KEYS.filter(key => tool[key] !== undefined).map(key => [key, tool[key]]),
	) as unknown as Tool;
}

// Runtime tools carry session/runner back-references that would serialize megabytes per call.
function requestSnapshot(context: Context): Context {
	const { tools, inactiveTools, ...rest } = context;
	return snapshot({
		...rest,
		...(tools ? { tools: tools.map(toolSchema) } : {}),
		...(inactiveTools ? { inactiveTools: inactiveTools.map(toolSchema) } : {}),
	});
}

/**
 * Journal app-level request context, post-hook provider payloads and the raw terminal
 * response/error of every call. Transport options (keys, headers) are never captured.
 *
 * Each call is bound to the session that dispatched it. SessionManager is one mutable
 * object across `/new` and session switches and appends to its *current* file, but side
 * turns outlive a switch. While the session is unchanged records append synchronously. After
 * a switch, a private manager is cloned and pointed back at the dispatching session's file
 * through the same storage; late records are written and flushed there, sequenced, before the
 * event that triggered them is forwarded, and that manager is closed when the call finishes.
 * A session that has no file (in-memory) cannot be reopened and fails the call explicitly.
 */
export function createModelCallJournalStream(sm: SessionManager, stream: StreamFn): StreamFn {
	return (model, context, options) => {
		const requestId = Snowflake.next();
		const sessionId = sm.getSessionId();
		const originalFile = sm.getSessionFile();
		const identity = { provider: model.provider, id: model.id, api: model.api };
		const outer = new AssistantMessageEventStream();

		let lateManager: Promise<SessionManager> | undefined;
		let lateTail: Promise<void> = Promise.resolve();
		const openOriginal = async (): Promise<SessionManager> => {
			if (!originalFile) {
				throw new Error("Model-call journal cannot record into a replaced session that has no session file");
			}
			const late = sm.cloneCurrentSession();
			try {
				await late.setSessionFile(originalFile);
			} catch (error) {
				await late.close().catch(() => undefined);
				throw error;
			}
			return late;
		};
		const appendLate = (entry: ModelCallJournalData): Promise<void> => {
			const written = lateTail.then(async () => {
				lateManager ??= openOriginal();
				const late = await lateManager;
				late.appendCustomEntry(MODEL_CALL_CUSTOM_TYPE, entry);
				await late.flush();
			});
			lateTail = written.catch(() => undefined);
			return written;
		};
		const closeLate = async (): Promise<void> => {
			await lateTail;
			const pending = lateManager;
			lateManager = undefined;
			if (pending) await (await pending.catch(() => undefined))?.close();
		};

		const record = (data: ModelCallRecord, detached = false): Promise<void> | undefined => {
			const entry: ModelCallJournalData = { version: 1, requestId, model: identity, ...data };
			const owned = detached ? entry : snapshot(entry);
			if (sm.getSessionId() === sessionId) {
				sm.appendCustomEntry(MODEL_CALL_CUSTOM_TYPE, owned);
				return undefined;
			}
			return appendLate(owned);
		};

		const run = async (): Promise<void> => {
			const requestContext = requestSnapshot(context);
			await sm.ensureOnDisk();
			await record({ phase: "request", context: requestContext }, true);
			try {
				const inner = await stream(model, context, {
					...options,
					onPayload: async (payload, payloadModel, signal) => {
						const replacement = await options?.onPayload?.(payload, payloadModel, signal);
						await record({ phase: "payload", payload: replacement === undefined ? payload : replacement });
						return replacement;
					},
				});
				outer.forwardLocalWorkFrom(inner);
				let terminal = false;
				for await (const event of inner) {
					if (event.type === "done" || event.type === "error") {
						terminal = true;
						const message = event.type === "done" ? event.message : event.error;
						await record(
							event.type === "done"
								? { phase: "response", message }
								: { phase: "error", message, error: message.errorMessage },
						);
					}
					outer.push(event);
				}
				if (!terminal) {
					// Producers may end(result) without a terminal event; result() still settles.
					const message = await inner.result();
					const failed = message.stopReason === "error" || message.stopReason === "aborted";
					await record(
						failed ? { phase: "error", message, error: message.errorMessage } : { phase: "response", message },
					);
					outer.end(message);
				}
			} catch (error) {
				await record({ phase: "error", error: error instanceof Error ? error.message : String(error) })?.catch(
					journalError => {
						logger.warn("Model-call journal could not record a call failure", {
							error: journalError instanceof Error ? journalError.message : String(journalError),
						});
					},
				);
				throw error;
			}
		};

		void run()
			.then(closeLate)
			.catch(async error => {
				await closeLate().catch(closeError => {
					logger.warn("Model-call journal could not close the replaced session", {
						error: closeError instanceof Error ? closeError.message : String(closeError),
					});
				});
				outer.fail(error);
			});
		return outer;
	};
}
