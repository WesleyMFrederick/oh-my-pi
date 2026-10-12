import { logger } from "@oh-my-pi/pi-utils";

/** Resource-lifecycle actions that leave one `browser.lifecycle` record each. */
export type LifecycleAction = "hold" | "unhold" | "stop" | "release" | "transfer" | "reap" | "refuse";

export type LifecycleResult = "ok" | "noop" | "failed" | "refused";

export interface LifecycleRecord {
	action: LifecycleAction;
	/** What was acted on, e.g. `daemon omp.browser.headless` or `browser pid 123`. */
	resource: string;
	/** Who triggered it (holder id, session id, pid, or `broker`). */
	owner?: string;
	/** Why, e.g. `idle-unheld`, `owner-dead`, `dispose`. */
	reason?: string;
	result: LifecycleResult;
	durationMs: number;
	error?: string;
}

/** Emit exactly one structured record: `error` level when the action failed, `info` otherwise. */
export function logLifecycle(record: LifecycleRecord): void {
	if (record.result === "failed") logger.error("browser.lifecycle", { ...record });
	else logger.info("browser.lifecycle", { ...record });
}

/**
 * Run `task` and log one record with its duration. `task` returns the result
 * (`ok` by default when it returns void); a throw logs `failed` with the error
 * and rethrows.
 */
export async function withLifecycleLog<T>(
	meta: Omit<LifecycleRecord, "result" | "durationMs" | "error">,
	task: () => Promise<T>,
	resultOf: (value: T) => LifecycleResult = () => "ok",
): Promise<T> {
	const started = performance.now();
	try {
		const value = await task();
		logLifecycle({ ...meta, result: resultOf(value), durationMs: Math.round(performance.now() - started) });
		return value;
	} catch (error) {
		logLifecycle({
			...meta,
			result: "failed",
			durationMs: Math.round(performance.now() - started),
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
