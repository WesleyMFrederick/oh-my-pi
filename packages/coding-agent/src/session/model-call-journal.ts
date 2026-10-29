import * as fs from "node:fs";
import * as path from "node:path";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Tool } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBlobsDir, isEexist, isEnoent, logger, readLines } from "@oh-my-pi/pi-utils";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { BlobStore } from "./blob-store";
import type { SessionEntry } from "./session-entries";
import { resolveBlobRefsInEntries } from "./session-loader";
import type { SessionManager } from "./session-manager";
import { truncateForPersistence } from "./session-persistence";

export const MODEL_CALL_CUSTOM_TYPE = "omp:model-call";
export const MODEL_CALL_RECORDS_FILE = "model-calls.ndjson";

export function modelCallRecordsPath(sessionFile: string): string | null {
	return sessionFile.endsWith(".jsonl") ? path.join(sessionFile.slice(0, -6), MODEL_CALL_RECORDS_FILE) : null;
}

const pendingCopies = new Map<string, Promise<void>>();
const checkedTails = new Map<string, Promise<void>>();

export async function copyModelCallRecords(sourceSessionFile: string, destinationSessionFile: string): Promise<void> {
	const source = modelCallRecordsPath(sourceSessionFile);
	const destination = modelCallRecordsPath(destinationSessionFile);
	if (!source || !destination || path.resolve(source) === path.resolve(destination)) return;
	const key = path.resolve(destination);
	const copy = (async () => {
		try {
			await fs.promises.mkdir(path.dirname(destination), { recursive: true });
			await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
		} catch (error) {
			if (isEnoent(error) || isEexist(error)) return;
			logger.warn("Failed to copy model-call records", {
				source,
				destination,
				error: String(error),
			});
		}
	})();
	pendingCopies.set(key, copy);
	await copy;
	if (pendingCopies.get(key) === copy) pendingCopies.delete(key);
}

function repairTail(file: string): Promise<void> {
	const key = path.resolve(file);
	let pending = checkedTails.get(key);
	if (!pending) {
		pending = (async () => {
			try {
				const handle = await fs.promises.open(file, "r");
				try {
					const { size } = await handle.stat();
					if (size === 0) return;
					const last = new Uint8Array(1);
					await handle.read(last, 0, 1, size - 1);
					if (last[0] !== 0x0a) await fs.promises.appendFile(file, "\n");
				} finally {
					await handle.close();
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		})();
		checkedTails.set(key, pending);
	}
	return pending;
}

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

export interface ModelCallJournalPointer {
	version: 2;
	key: string;
	requestId: string;
	phase: ModelCallJournalData["phase"];
	model: ModelCallJournalData["model"];
}

export interface ModelCallJournalRecord extends Omit<ModelCallJournalData, "version"> {
	version: 2;
	key: string;
}

export async function resolveModelCallEntries(sessionFile: string, entries: SessionEntry[]): Promise<SessionEntry[]> {
	const keys = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODEL_CALL_CUSTOM_TYPE) continue;
		const data = entry.data as ModelCallJournalPointer | undefined;
		if (data?.version === 2) keys.add(data.key);
	}
	const records = new Map<string, ModelCallJournalRecord>();
	const file = modelCallRecordsPath(sessionFile);
	if (keys.size > 0 && file) {
		await pendingCopies.get(path.resolve(file));
		const decoder = new TextDecoder();
		try {
			for await (const line of readLines(Bun.file(file).stream())) {
				try {
					const record = JSON.parse(decoder.decode(line)) as ModelCallJournalRecord;
					if (record?.version === 2 && keys.has(record.key)) records.set(record.key, record);
				} catch {
					// A damaged line must not hide the rest of the call history.
				}
			}
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	const sidecarEntries: SessionEntry[] = [];
	const resolved = entries.map(entry => {
		if (entry.type !== "custom" || entry.customType !== MODEL_CALL_CUSTOM_TYPE) return entry;
		const data = entry.data as ModelCallJournalPointer | undefined;
		if (data?.version !== 2) return entry;
		const record = records.get(data.key);
		const resolvedEntry = {
			...entry,
			data: record ?? { ...data, unavailable: "missing" },
		};
		if (record) sidecarEntries.push(resolvedEntry);
		return resolvedEntry;
	});
	await resolveBlobRefsInEntries(sidecarEntries, new BlobStore(getBlobsDir()));
	return resolved;
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
	return {
		...rest,
		...(tools ? { tools: tools.map(toolSchema) } : {}),
		...(inactiveTools ? { inactiveTools: inactiveTools.map(toolSchema) } : {}),
	};
}

/**
 * Journal app-level request context, post-hook provider payloads and the raw terminal
 * response/error of every call. Transport options (keys, headers) are never captured.
 *
 * Each call is bound to the session that dispatched it. SessionManager is one mutable
 * object across `/new` and session switches and appends to its *current* file, but side
 * turns outlive a switch. Sidecar writes precede pointers; late pointers are flushed
 * through a cloned manager pointed at the dispatching file. In-memory calls pass through.
 */
export function createModelCallJournalStream(sm: SessionManager, stream: StreamFn): StreamFn {
	const blobStore = new BlobStore(getBlobsDir());
	return (model, context, options) => {
		if (!sm.isPersisted()) return stream(model, context, options);
		const requestId = Snowflake.next();
		const sessionId = sm.getSessionId();
		const originalFile = sm.getSessionFile();
		const identity = { provider: model.provider, id: model.id, api: model.api };
		const outer = new AssistantMessageEventStream();

		let lateManager: Promise<SessionManager> | undefined;
		let lateTail: Promise<void> = Promise.resolve();
		const openOriginal = async (): Promise<SessionManager> => {
			// Persisted sessions always have a file at dispatch.
			const late = sm.cloneCurrentSession();
			try {
				await late.setSessionFile(originalFile!);
			} catch (error) {
				await late.close().catch(() => undefined);
				throw error;
			}
			return late;
		};
		const appendLate = (entry: ModelCallJournalPointer): Promise<void> => {
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

		const record = (data: ModelCallRecord): Promise<void> => {
			const pointer: ModelCallJournalPointer = {
				version: 2,
				key: Snowflake.next(),
				requestId,
				phase: data.phase,
				model: identity,
			};
			const serialized = `${JSON.stringify(truncateForPersistence({ ...pointer, ...data }, blobStore))}\n`;
			return (async () => {
				const sessionFile = sm.getSessionId() === sessionId ? sm.getSessionFile()! : originalFile!;
				const file = modelCallRecordsPath(sessionFile);
				if (!file) throw new Error("Model-call journal requires a .jsonl session file");
				await pendingCopies.get(path.resolve(file));
				try {
					await repairTail(file);
					await fs.promises.mkdir(path.dirname(file), { recursive: true });
					await fs.promises.appendFile(file, serialized);
				} catch (error) {
					checkedTails.delete(path.resolve(file));
					throw error;
				}
				if (sm.getSessionId() === sessionId) {
					sm.appendCustomEntry(MODEL_CALL_CUSTOM_TYPE, pointer);
				} else {
					await appendLate(pointer);
				}
			})();
		};

		const run = async (): Promise<void> => {
			await record({ phase: "request", context: requestSnapshot(context) });
			await sm.ensureOnDisk();
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
