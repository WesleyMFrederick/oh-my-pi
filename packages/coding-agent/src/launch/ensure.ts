/**
 * Quiet daemon-broker ensure helpers shared by broker-owned singleton daemons
 * (shared Chromium, browser relay, LSP mux). Each treats broker/daemon errors
 * as "absent" so ensure loops can retry or adopt a cross-process race winner
 * instead of failing the caller.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import type { DaemonBrokerClient } from "./client";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

/** Snapshot a broker daemon, treating "unknown daemon" and broker errors as absent. */
export async function describeQuietly(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
): Promise<DaemonSnapshot | undefined> {
	try {
		const result = await client.request({ op: "describe", name }, signal);
		return result.op === "describe" ? result.daemon : undefined;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} describe failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** Block until the daemon reports ready; undefined on timeout or pre-ready exit. */
export async function waitReady(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<DaemonSnapshot | undefined> {
	try {
		const result = await client.request({ op: "wait", name, for: "ready", timeoutMs }, signal);
		if (result.op !== "wait" || result.timedOut) return undefined;
		return result.daemon;
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} ready wait failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/** Best-effort stop before replacing a wedged or endpoint-less daemon. */
export async function stopQuietly(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await client.request({ op: "stop", name, timeoutMs: STOP_TIMEOUT_MS }, signal);
	} catch (error) {
		throwIfAborted(signal);
		logger.debug(`${label} stop failed`, {
			name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Stop a daemon that must be gone before a replacement starts. Unlike
 * {@link stopQuietly}, a daemon that survives the stop is an error naming its
 * pid: replacing it anyway would run two processes under one name.
 */
export async function stopOrThrow(
	client: DaemonBrokerClient,
	name: string,
	label: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await client.request({ op: "stop", name, timeoutMs: STOP_TIMEOUT_MS }, signal);
		return;
	} catch (error) {
		throwIfAborted(signal);
		const cause = error instanceof Error ? error.message : String(error);
		// Only a positive answer counts as "gone": the broker snapshotting the daemon as
		// terminal, or naming it unknown. A failed describe (broker unreachable) proves nothing.
		let remaining: DaemonSnapshot | undefined;
		try {
			const result = await client.request({ op: "describe", name }, signal);
			remaining = result.op === "describe" ? result.daemon : undefined;
		} catch (describeError) {
			throwIfAborted(signal);
			const describeMessage = describeError instanceof Error ? describeError.message : String(describeError);
			if (!describeMessage.startsWith("Unknown daemon")) throw error;
		}
		if (!remaining || remaining.state === "exited" || remaining.state === "failed") {
			logger.debug(`${label} stop failed but daemon is gone`, { name });
			return;
		}
		throw new ToolError(
			`${label} (pid ${remaining.pid ?? "unknown"}) could not be stopped and is still ${remaining.state}: ${cause}. Refusing to start a second one under the same name; stop pid ${remaining.pid ?? "?"} manually.`,
		);
	}
}
