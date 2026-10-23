/**
 * Regression tests for `EventController`'s post-turn desktop notifications
 * (`sendCompletionNotification` / `sendErrorNotification`).
 *
 * Both read the settled turn's outcome from the `agent_end` event's own
 * `messages`, not the mutable `viewSession` active context: a classifier-
 * refusal failure ends with `stopReason === "error"` but is pruned from
 * active context before the public `agent_end` fires (see
 * `#removeAssistantMessageFromActiveContext` in `agent-session.ts`), and a
 * user Ctrl+C on the `ask` tool selector similarly leaves `stopReason ===
 * "aborted"` on the terminal message. Reading the mutable context for either
 * check risks a stale/absent lookup — dropping the intended notification, or
 * worse, pairing a misleading "Complete" toast with an error/abort.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

import { cfgAskNotify, cfgCompletionNotify, cfgErrorNotify } from "@oh-my-pi/pi-coding-agent/modes/settings";

const originalWarpProtocolVersion = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;

function restoreWarpProtocolEnvironment(): void {
	if (originalWarpProtocolVersion === undefined) {
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	} else {
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = originalWarpProtocolVersion;
	}
}

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	// Neutral baseline for notification gates; afterEach restores the suite's inherited value.
	delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-abortguard-"));
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	restoreWarpProtocolEnvironment();
});

type StopReason = "stop" | "length" | "aborted" | "error";

function makeAssistantMessage(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function makeContext() {
	return createInteractiveModeContext({
		sessionManager: {
			getSessionName: () => "test-session",
		},
	});
}

function makeAgentEndEvent(messages: AssistantMessage[]): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

/** Full context needed to drive `#handleAgentEnd` -> `#finishAgentEnd` end to end. */
function makeTurnEndContext(options: { lastAssistantMessage?: AssistantMessage } = {}) {
	return createInteractiveModeContext({
		sessionManager: { getSessionName: () => "test-session" },
		viewSession: {
			getLastAssistantMessage: () => options.lastAssistantMessage,
		},
	});
}

describe("EventController.sendCompletionNotification — abort guard", () => {
	it("skips notification when the terminal assistant message stopReason === 'aborted'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("aborted")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips notification when the terminal assistant message stopReason === 'error'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("fires notification when stopReason === 'stop' (normal completion)", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(1);
		// Completion now sends a structured notification (title=session, body="Complete").
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Complete", type: "completion" }));
	});

	it("fires notification when agent_end carries no assistant message (e.g. brand-new session)", () => {
		// Defensive: `findLast` returns undefined; treat as 'no abort flag', proceed.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([]));
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("honors the existing completion.notify=off gate", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "off");
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips legacy completion notify when Warp CLI-agent protocol is active", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
		const controller = new EventController(makeContext());
		controller.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});
});

describe("EventController — completion-notification custom entries", () => {
	const notification = {
		title: "Decision needed",
		body: "Choose the notification behavior",
		type: "ask",
		actions: "focus",
	} as const;

	it.each(["stop", "length"] as const)(
		"Given a matching complete final-message marker with %s stop reason, when the turn settles, then it replaces completion with one ask notification",
		async stopReason => {
			// Given
			const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
			cfgCompletionNotify.override(settings, "off");
			cfgAskNotify.override(settings, "on");
			const assistant: AssistantMessage = {
				...makeAssistantMessage(stopReason),
				content: [
					{ type: "text", text: "First line" },
					{ type: "thinking", thinking: "not displayed" },
					{ type: "text", text: "Last line" },
				],
			};
			const ctx = makeTurnEndContext();
			ctx.sessionManager.appendCustomEntry("completion-notification", {
				messageTimestamp: assistant.timestamp,
				messageText: "First line\nLast line",
				notification,
			});
			const controller = new EventController(ctx);

			// When
			await controller.handleEvent(makeAgentEndEvent([assistant]));

			// Then
			expect(spy.mock.calls).toEqual([[notification]]);
		},
	);

	it.each(["stop", "length"] as const)(
		"Given a matching marker with a tool call and %s stop reason, when the turn settles, then it cannot override completion",
		stopReason => {
			// Given
			const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
			cfgCompletionNotify.override(settings, "on");
			cfgAskNotify.override(settings, "on");
			const assistant: AssistantMessage = {
				...makeAssistantMessage(stopReason),
				content: [
					{ type: "text", text: "hello" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "example.ts" } },
				],
			};
			const ctx = makeContext();
			ctx.sessionManager.appendCustomEntry("completion-notification", {
				messageTimestamp: assistant.timestamp,
				messageText: "hello",
				notification,
			});

			// When
			new EventController(ctx).sendCompletionNotification(makeAgentEndEvent([assistant]));

			// Then
			expect(spy.mock.calls).toEqual([
				[{ title: "test-session", body: "Complete", type: "completion", actions: "focus" }],
			]);
		},
	);

	it("Given ask notifications are off, when a matching marker settles, then it sends neither ask nor fallback completion", () => {
		// Given
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		cfgAskNotify.override(settings, "off");
		const assistant = makeAssistantMessage("stop");
		const ctx = makeContext();
		ctx.sessionManager.appendCustomEntry("completion-notification", {
			messageTimestamp: assistant.timestamp,
			messageText: "hello",
			notification,
		});

		// When
		new EventController(ctx).sendCompletionNotification(makeAgentEndEvent([assistant]));

		// Then
		expect(spy).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "a previous assistant's timestamp", messageTimestamp: 1000, messageText: "hello" },
		{ name: "different text at the same timestamp", messageTimestamp: 1001, messageText: "old card" },
		{ name: "normalized rather than exact text", messageTimestamp: 1001, messageText: "hello\n" },
	])("Given a marker for $name, when the last assistant settles, then normal completion is retained", data => {
		// Given
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		cfgAskNotify.override(settings, "on");
		const previous = { ...makeAssistantMessage("stop"), timestamp: 1000 };
		const assistant = { ...makeAssistantMessage("stop"), timestamp: 1001 };
		const ctx = makeContext();
		ctx.sessionManager.appendCustomEntry("completion-notification", {
			messageTimestamp: data.messageTimestamp,
			messageText: data.messageText,
			notification,
		});

		// When
		new EventController(ctx).sendCompletionNotification(makeAgentEndEvent([previous, assistant]));

		// Then
		expect(spy.mock.calls).toEqual([
			[{ title: "test-session", body: "Complete", type: "completion", actions: "focus" }],
		]);
	});

	it.each([
		{ name: "missing data", data: undefined },
		{ name: "null data", data: null },
		{ name: "a string timestamp", data: { messageTimestamp: "1001", messageText: "hello", notification } },
		{ name: "a non-finite timestamp", data: { messageTimestamp: Number.NaN, messageText: "hello", notification } },
		{ name: "missing message text", data: { messageTimestamp: 1001, notification } },
		{ name: "a null notification", data: { messageTimestamp: 1001, messageText: "hello", notification: null } },
		{
			name: "a non-string title",
			data: { messageTimestamp: 1001, messageText: "hello", notification: { ...notification, title: 42 } },
		},
		{
			name: "a missing body",
			data: {
				messageTimestamp: 1001,
				messageText: "hello",
				notification: { title: "Decision needed", type: "ask", actions: "focus" },
			},
		},
		{
			name: "a different notification type",
			data: { messageTimestamp: 1001, messageText: "hello", notification: { ...notification, type: "completion" } },
		},
		{
			name: "different actions",
			data: { messageTimestamp: 1001, messageText: "hello", notification: { ...notification, actions: "report" } },
		},
	])(
		"Given $name in a marker, when the turn settles, then malformed metadata cannot replace completion",
		({ data }) => {
			// Given
			const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
			cfgCompletionNotify.override(settings, "on");
			const assistant = { ...makeAssistantMessage("stop"), timestamp: 1001 };
			const ctx = makeContext();
			ctx.sessionManager.appendCustomEntry("completion-notification", data);

			// When
			new EventController(ctx).sendCompletionNotification(makeAgentEndEvent([assistant]));

			// Then
			expect(spy.mock.calls).toEqual([
				[{ title: "test-session", body: "Complete", type: "completion", actions: "focus" }],
			]);
		},
	);

	it("Given several entries, when the turn settles, then the latest valid matching marker wins over newer stale or malformed entries", () => {
		// Given
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgAskNotify.override(settings, "on");
		const assistant = { ...makeAssistantMessage("stop"), timestamp: 1001 };
		const ctx = makeContext();
		const data = { messageTimestamp: 1001, messageText: "hello", notification };
		ctx.sessionManager.appendCustomEntry("completion-notification", data);
		const latest = { ...notification, body: "Use the latest displayed question" };
		ctx.sessionManager.appendCustomEntry("completion-notification", { ...data, notification: latest });
		ctx.sessionManager.appendCustomEntry("completion-notification", { ...data, notification: null });
		ctx.sessionManager.appendCustomEntry("completion-notification", { ...data, messageTimestamp: 1000 });

		// When
		new EventController(ctx).sendCompletionNotification(makeAgentEndEvent([assistant]));

		// Then
		expect(spy.mock.calls).toEqual([[latest]]);
	});

	it("Given a notified decision turn, when a later turn has no marker, then it cannot reuse the prior ask payload", () => {
		// Given
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgCompletionNotify.override(settings, "on");
		cfgAskNotify.override(settings, "on");
		const assistant = { ...makeAssistantMessage("stop"), timestamp: 1001 };
		const ctx = makeContext();
		ctx.sessionManager.appendCustomEntry("completion-notification", {
			messageTimestamp: 1001,
			messageText: "hello",
			notification,
		});
		const controller = new EventController(ctx);

		// When
		controller.sendCompletionNotification(makeAgentEndEvent([assistant]));
		controller.sendCompletionNotification(makeAgentEndEvent([{ ...assistant, timestamp: 1002 }]));

		// Then
		expect(spy.mock.calls).toEqual([
			[notification],
			[{ title: "test-session", body: "Complete", type: "completion", actions: "focus" }],
		]);
	});

	it.each(["aborted", "error", "nonterminal", "streaming", "warp"] as const)(
		"Given a matching marker and a %s turn, when the real turn-end path runs, then existing notification gates still apply",
		async outcome => {
			// Given
			const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
			cfgCompletionNotify.override(settings, "on");
			cfgAskNotify.override(settings, "on");
			cfgErrorNotify.override(settings, "on");
			const assistant = makeAssistantMessage(outcome === "aborted" || outcome === "error" ? outcome : "stop");
			const ctx = makeTurnEndContext();
			ctx.sessionManager.appendCustomEntry("completion-notification", {
				messageTimestamp: assistant.timestamp,
				messageText: "hello",
				notification,
			});
			if (outcome === "streaming") {
				Object.defineProperty(ctx.session, "isStreaming", { value: true, configurable: true });
			}
			if (outcome === "warp") process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = "1";
			const event = makeAgentEndEvent([assistant]);
			if (outcome === "nonterminal") event.isTerminal = false;

			// When
			await new EventController(ctx).handleEvent(event);

			// Then
			expect(spy.mock.calls).toEqual(
				outcome === "error"
					? [[{ title: "test-session", body: "Stopped with error", type: "error", actions: "focus" }]]
					: [],
			);
		},
	);
});

describe("EventController.sendErrorNotification", () => {
	it("fires an error notification when stopReason === 'error'", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Stopped with error", type: "error", title: "test-session" }),
		);
	});

	it("uses the last assistant message when agent_end carries multiple messages", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(
			makeAgentEndEvent([makeAssistantMessage("stop"), makeAssistantMessage("error")]),
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("honors error.notify=off without changing completion notifications", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "off");
		cfgCompletionNotify.override(settings, "on");

		const errorController = new EventController(makeContext());
		errorController.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(0);

		const completionController = new EventController(makeContext());
		completionController.sendCompletionNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Complete", type: "completion" }));
	});

	it("skips user-aborted turns", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("aborted")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("skips normal completion turns", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		controller.sendErrorNotification(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).toHaveBeenCalledTimes(0);
	});
	it("skips an error turn marked as a non-terminal scheduling pause", () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		const controller = new EventController(makeContext());
		const event = {
			...makeAgentEndEvent([makeAssistantMessage("error")]),
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }> & { isTerminal: false };

		controller.sendErrorNotification(event);

		expect(spy).not.toHaveBeenCalled();
	});
});

describe("EventController — notifications through the real turn-end path (#handleAgentEnd)", () => {
	it("fires only the error toast — never a paired 'Complete' toast — for one error-ending turn", async () => {
		// Regression for the exact coupling bug: with both notify settings on,
		// a classifier-refusal turn's stale active context must not let
		// sendCompletionNotification's own stopReason check pass by reading a
		// different (non-error) snapshot than sendErrorNotification just used.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		cfgCompletionNotify.override(settings, "on");
		const controller = new EventController(makeTurnEndContext({ lastAssistantMessage: undefined }));
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Stopped with error", type: "error" }));
	});
});

describe("EventController — error toast gated while auto-retry is pending", () => {
	it("keeps retry suppression when the next attempt starts before a deferred failed agent_end settles", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));

		expect(spy).not.toHaveBeenCalled();
	});

	it("clears a retry latch when the view retargets to a session that is not retrying", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		controller.resetTranscriptAnchors();
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("fires no error toast at all when the retry recovers", async () => {
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		cfgCompletionNotify.override(settings, "off");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		await controller.handleEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
		// The recovered turn settles normally with stopReason 'stop'.
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(spy).not.toHaveBeenCalled();
	});

	it("keeps suppressing every agent_end that lands while a retry is outstanding, with no auto_retry_end in between", async () => {
		// The wire-level `agent_end` is coalesced by `AgentSession` while a prompt
		// is in flight (every mid-retry attempt supersedes the previous one), so
		// this controller cannot use "have I seen an agent_end yet" to decide
		// whether a retry settled — only `auto_retry_end` can. Two agent_ends
		// landing back-to-back with no `auto_retry_end` between them must both
		// stay suppressed.
		const spy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
		cfgErrorNotify.override(settings, "on");
		cfgCompletionNotify.override(settings, "off");
		const controller = new EventController(makeTurnEndContext());

		await controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 100,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).not.toHaveBeenCalled();

		// Only once the lifecycle explicitly settles does the next agent_end notify.
		await controller.handleEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 2,
			finalError: "still overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_end" }>);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("error")]));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({ body: "Stopped with error", type: "error" }));
	});
});

function asyncWaitEnd(): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return {
		...makeAgentEndEvent([makeAssistantMessage("stop")]),
		isTerminal: false,
		yielded: true,
		awaitingAsyncWork: true,
	};
}

/** Session whose owned background job is pending until `drain()` settles it without delivering a wake. */
function makeAsyncWaitContext() {
	let pending = true;
	const settled = Promise.withResolvers<void>();
	const ctx = createInteractiveModeContext({
		sessionManager: { getSessionName: () => "test-session" },
		session: {
			// The real settle is emitted while its prompt is still admitted.
			hasAdmittedSubmission: true,
			hasPendingAsyncWork: () => pending,
			settleAsyncWork: () => settled.promise,
		},
	});
	const drain = () => {
		pending = false;
		settled.resolve();
	};
	return { ctx, drain };
}

/** One macrotask hop: every microtask continuation queued so far has run. */
async function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

describe("EventController — terminal title across a non-terminal agent_end", () => {
	it("keeps the working title and skips loader teardown but still flushes a deferred model switch during a scheduled continuation (isTerminal:false, not yielded)", async () => {
		const stateSpy = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const ctx = makeTurnEndContext();
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const flushPendingModelSwitch = vi.spyOn(ctx, "flushPendingModelSwitch");
		const controller = new EventController(ctx);
		await controller.handleEvent({
			...makeAgentEndEvent([makeAssistantMessage("stop")]),
			isTerminal: false,
		} as Extract<AgentSessionEvent, { type: "agent_end" }> & { isTerminal: false });
		// The agent's own continuation (reminder/retry) follows: never drop to `idle`, never run #finishAgentEnd teardown.
		expect(stateSpy).not.toHaveBeenCalledWith("idle");
		expect(markActivityEnd).not.toHaveBeenCalled();
		// The automatic continuation must still pick up a queued plan-mode model switch.
		expect(flushPendingModelSwitch).toHaveBeenCalledTimes(1);
	});

	it("keeps the working title on a queued steer/follow-up or IRC continuation (isTerminal:false, yielded:true, no awaitingAsyncWork)", async () => {
		// `AgentSession#flushPendingAgentEnd` re-tags a built terminal end as
		// non-terminal when queued input is about to drain; `yielded` stays true.
		const stateSpy = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const ctx = makeTurnEndContext();
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const controller = new EventController(ctx);
		await controller.handleEvent({
			...makeAgentEndEvent([makeAssistantMessage("stop")]),
			isTerminal: false,
			yielded: true,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);
		expect(stateSpy).not.toHaveBeenCalledWith("idle");
		expect(markActivityEnd).not.toHaveBeenCalled();
	});

	it("drops the title to idle at an async-wait settle and tears down once background work drains without a wake", async () => {
		// A cancelled or acknowledged background job never delivers a wake, so no
		// terminal agent_end follows; without this, title and loader spin forever.
		const stateSpy = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const { ctx, drain } = makeAsyncWaitContext();
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const tornDown = Promise.withResolvers<void>();
		markActivityEnd.mockImplementation(() => tornDown.resolve());
		const controller = new EventController(ctx);
		await controller.handleEvent(asyncWaitEnd());
		expect(stateSpy).toHaveBeenCalledWith("idle");
		// The job is still running: loader/progress teardown waits for it.
		expect(markActivityEnd).not.toHaveBeenCalled();

		drain();
		await tornDown.promise;
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
	});

	it("leaves teardown to the woken run when background work resumes the agent", async () => {
		vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const { ctx, drain } = makeAsyncWaitContext();
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const controller = new EventController(ctx);
		await controller.handleEvent(asyncWaitEnd());
		// The job result woke the loop: a new run starts before the drain completes.
		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		drain();
		await nextMacrotask();
		// The woken run's own agent_end finalizes; this settle must not stop its loader.
		expect(markActivityEnd).not.toHaveBeenCalled();
	});

	it("transitions to idle and tears down on the terminal agent_end", async () => {
		const stateSpy = vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
		const ctx = makeTurnEndContext();
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const controller = new EventController(ctx);
		await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("stop")]));
		expect(stateSpy).toHaveBeenCalledWith("idle");
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
	});
});
