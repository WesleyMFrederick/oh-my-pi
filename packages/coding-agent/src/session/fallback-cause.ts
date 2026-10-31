import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";

export type FallbackCause = { origin: "harness" | "provider" | "unknown"; kind: string; code?: string };

type Failure = { message: AssistantMessage; errorId: number; text: string; code?: string; status?: number };
type Rule = { origin: FallbackCause["origin"]; kind: string; matches: (failure: Failure) => boolean };

// Specific harness causes precede broad provider flags (notably Anthropic 429 usage flags).
const RULES: readonly Rule[] = [
	{ origin: "harness", kind: "steer_collision", matches: f => f.code === "unsupported_native_inflight_message" },
	{
		origin: "harness",
		kind: "rate_limit",
		matches: f =>
			f.code === "turn_rate_limit_exceeded" ||
			(f.status === 429 &&
				/rate_limit_error/i.test(f.text) &&
				(f.message.provider === "anthropic" || /anthropic|"type"\s*:\s*"error"/i.test(f.text))),
	},
	{
		origin: "harness",
		kind: "connection_lifetime",
		matches: f =>
			f.code === "websocket_connection_limit_reached" || /websocket_connection_limit_reached/i.test(f.text),
	},
	{
		origin: "harness",
		kind: "abort",
		matches: f =>
			f.message.stopReason === "aborted" ||
			AIError.is(f.errorId, AIError.Flag.Abort) ||
			/\babort(?:ed)?\b/i.test(f.text),
	},
	{
		origin: "harness",
		kind: "request_invalid",
		matches: f =>
			f.status === 400 && /unsupported|invalid.*(?:value|parameter)|(?:value|parameter).*invalid/i.test(f.text),
	},
	{ origin: "harness", kind: "unknown_model", matches: f => f.status === 404 && /model|not found/i.test(f.text) },
	{
		origin: "provider",
		kind: "usage_limit",
		matches: f =>
			f.code === "usage_limit_reached" ||
			f.status === 402 ||
			/payment required/i.test(f.text) ||
			AIError.is(f.errorId, AIError.Flag.UsageLimit) ||
			/usage.limit.reached/i.test(f.text),
	},
	{
		origin: "provider",
		kind: "model_capacity_limit",
		matches: f =>
			f.status === 413 ||
			AIError.is(f.errorId, AIError.Flag.PayloadRejected) ||
			/request_too_large|payload too large/i.test(f.text),
	},
	{
		origin: "provider",
		kind: "account_policy",
		matches: f =>
			AIError.is(f.errorId, AIError.Flag.AccountPolicy) ||
			/account.{0,40}(?:policy|permission)|policy.{0,40}account/i.test(f.text),
	},
	{
		origin: "provider",
		kind: "refusal",
		matches: f =>
			f.message.stopDetails?.type === "refusal" ||
			f.message.stopDetails?.type === "sensitive" ||
			/refus(?:al|ed|es)|content.filter|safety.classifier/i.test(f.text) ||
			AIError.is(f.errorId, AIError.Flag.ContentBlocked),
	},
	{ origin: "provider", kind: "overloaded", matches: f => f.status === 529 || /overload/i.test(f.text) },
	{
		origin: "provider",
		kind: "server_error",
		matches: f => f.status !== undefined && f.status >= 500 && f.status <= 599,
	},
	{ origin: "provider", kind: "capacity", matches: f => /\bcapacity\b/i.test(f.text) },
	{ origin: "unknown", kind: "idle_timeout", matches: f => /idle.timeout|timed out.*idle/i.test(f.text) },
	{ origin: "unknown", kind: "socket_closed", matches: f => /socket.*clos|connection.*clos/i.test(f.text) },
	{ origin: "unknown", kind: "connection_error", matches: f => /connection|network/i.test(f.text) },
];

export function classifyFallbackCause(message: AssistantMessage, errorId: number): FallbackCause {
	const text = message.errorClassificationMessage ?? message.errorMessage ?? "";
	const code = /\(code=([^\s)]+)\)/i.exec(text)?.[1] ?? /"code"\s*:\s*"([^"]+)"/i.exec(text)?.[1];
	const statusText = /^(?:Request failed:\s*)?\s*(\d{3})\b/i.exec(text)?.[1];
	const status =
		message.errorStatus ??
		extractHttpStatusFromError({ message: text }) ??
		(statusText === undefined ? undefined : Number(statusText));
	const failure: Failure = { message, errorId, text, code, status };
	const rule = RULES.find(rule => rule.matches(failure));
	const cause: FallbackCause = { origin: rule?.origin ?? "unknown", kind: rule?.kind ?? "unclassified" };
	return code === undefined ? cause : { ...cause, code };
}
