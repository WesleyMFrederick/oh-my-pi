import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { classifyFallbackCause } from "../src/session/fallback-cause";

describe("fallback causes", () => {
	it("Given a rate-limit response tagged as quota, When classified, Then harness overload wins", () => {
		const cause = classifyFallbackCause(
			{
				provider: "anthropic",
				errorMessage: 'Request failed: 429 {"error":{"type":"rate_limit_error"}}',
			} as AssistantMessage,
			AIError.Flag.UsageLimit,
		);
		expect(cause).toEqual({ origin: "harness", kind: "rate_limit" });
	});

	it("Given a decorated error, When stable evidence exists, Then decoration does not change the cause", () => {
		const cause = classifyFallbackCause(
			{
				errorMessage: "Retry failed after aborting fallback",
				errorClassificationMessage: "503 Service Unavailable",
			} as AssistantMessage,
			0,
		);
		expect(cause).toEqual({ origin: "provider", kind: "server_error" });
	});

	const cases = [
		["request_too_large: image count exceeds the limit of 20", "provider", "model_capacity_limit"],
		[
			"Codex error event: The experimental native turn lane cannot accept stateful WebSocket messages while a native turn is running. Start a new independent response.create turn instead. (code=unsupported_native_inflight_message)",
			"harness",
			"steer_collision",
		],
		["Codex error event: at capacity (code=turn_rate_limit_exceeded)", "harness", "rate_limit"],
		[
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"account rate limit"}}',
			"harness",
			"rate_limit",
		],
		["Request was aborted", "harness", "abort"],
		["400 Unsupported value: reasoning 'none'", "harness", "request_invalid"],
		["404 Unknown model", "harness", "unknown_model"],
		["error (code=websocket_connection_limit_reached)", "harness", "connection_lifetime"],
		["Codex error event: usage limit (code=usage_limit_reached)", "provider", "usage_limit"],
		["503 Service Unavailable", "provider", "server_error"],
		["Request failed: 503 Hosted inference is temporarily unavailable", "provider", "server_error"],
		["Request failed: 400 Unsupported value: reasoning 'none'", "harness", "request_invalid"],
		["529 overloaded", "provider", "overloaded"],
		["server at capacity", "provider", "capacity"],
		["model refused the request", "provider", "refusal"],
		["account policy denied", "provider", "account_policy"],
		["connection error", "unknown", "connection_error"],
		["socket closed", "unknown", "socket_closed"],
		["idle timeout", "unknown", "idle_timeout"],
		["something unexpected", "unknown", "unclassified"],
	] as const;
	for (const [text, origin, kind] of cases) {
		it(`Given ${text}, When classified, Then it is ${origin}/${kind}`, () => {
			const cause = classifyFallbackCause({ errorMessage: text } as AssistantMessage, 0);
			expect(cause.origin).toBe(origin);
			expect(cause.kind).toBe(kind);
		});
	}
});
