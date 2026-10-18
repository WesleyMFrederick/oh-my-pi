import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { SessionContext } from "../session/session-context";
import { nextActionableTask } from "../tools/todo";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "./settings";
import type { GoalModeState } from "./state";

export type GoalRunMode = "interactive" | "rpc";

/** Delay between a turn ending and its auto-continuation being submitted. */
const CONTINUATION_DELAY_MS = 800;

/** Host side of auto-continuation. Absent host => continuation unsupported (ACP). */
export interface GoalContinuationHost {
	readonly runMode: GoalRunMode;
	/**
	 * Host-only gates. `"schedule"` runs when the continuation is armed (typically inside the
	 * `agent_end` handler, where the session may still report itself as busy); `"fire"` runs when
	 * the timer expires and the turn is about to be submitted.
	 */
	canAutoSubmit(phase: "schedule" | "fire"): boolean;
	/** Start one hidden continuation turn (customType "goal-continuation", display false). */
	submitContinuation(prompt: string): void | Promise<void>;
	/** enabled/paused changed (TUI: status line + render). */
	onStatusChanged?(): void;
}

/** Model-visible tool activity, excluding call IDs and timestamps that differ on every turn. */
function goalContinuationActivity(messages: AgentMessage[]): string {
	const digests: string[] = [];
	const record = (value: unknown): void => {
		const serialized = stableStringifyJson(value);
		digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") record(["call", block.name, block.arguments]);
			}
		} else if (message.role === "toolResult") {
			record(["result", message.toolName, message.content, message.isError === true]);
		}
	}
	return digests.join(":");
}

function goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * Host-agnostic goal-mode state machine: tool snapshot, restore, session events and the
 * auto-continuation loop. TUI, RPC and ACP each own one; hosts add only their gates and submit path.
 */
export class GoalModeController {
	#enabled = false;
	#paused = false;
	#previousTools: string[] | undefined;
	#timer: NodeJS.Timeout | undefined;
	/** Submitted continuation turns awaiting their asynchronously delivered `agent_end`. */
	#pendingTurns = 0;
	#previousActivity: string | undefined;
	#suppressNext = false;

	constructor(
		readonly session: AgentSession,
		readonly host?: GoalContinuationHost,
	) {}

	get enabled(): boolean {
		return this.#enabled;
	}

	set enabled(value: boolean) {
		this.#enabled = value;
	}

	get paused(): boolean {
		return this.#paused;
	}

	set paused(value: boolean) {
		this.#paused = value;
	}

	/** Host present AND `goal.continuationModes` includes the host's run mode. */
	get continuationEnabled(): boolean {
		const host = this.host;
		if (!host) return false;
		const modes: readonly string[] = cfgGoalContinuationModes.get(this.session.settings);
		return modes.includes(host.runMode);
	}

	async enter(options: { objective?: string; resume?: boolean }): Promise<void> {
		if (this.#enabled) return;
		const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#previousTools = previousTools;
		this.#paused = false;
		const state = options.resume
			? await this.session.goalRuntime.resumeGoal()
			: await this.session.goalRuntime.createGoal({
					objective: options.objective ?? "",
				});
		await this.session.setActiveToolsByName(goalTools);
		this.session.setGoalModeState(state);
		this.#enabled = true;
		this.resetSuppression();
		this.host?.onStatusChanged?.();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
	}

	async replace(objective: string): Promise<void> {
		const state = await this.session.goalRuntime.replaceGoal({ objective });
		this.session.setGoalModeState(state);
		this.#enabled = true;
		this.#paused = false;
		this.resetSuppression();
		this.host?.onStatusChanged?.();
		if (this.session.isStreaming) {
			await this.session.sendGoalModeContext({ deliverAs: "steer" });
		}
	}

	async exit(options?: { paused?: boolean; reason?: "completed" | "paused" | "dropped" }): Promise<void> {
		const previousTools = this.#previousTools;
		if (this.#enabled && previousTools) {
			await this.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.session.setGoalModeState(undefined);
			this.session.sessionManager.appendModeChange("none");
			this.session.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.#enabled = false;
		this.#paused = options?.paused ?? false;
		this.#previousTools = undefined;
		this.#pendingTurns = 0;
		this.#previousActivity = undefined;
		this.#suppressNext = false;
		this.cancelContinuation();
		this.host?.onStatusChanged?.();
	}

	/** If the goal tool marked the goal complete (`mode: "exiting"`), finish the exit. Returns whether it did. */
	async exitIfCompleted(): Promise<boolean> {
		if (this.session.getGoalModeState()?.mode !== "exiting") return false;
		await this.exit({ reason: "completed" });
		return true;
	}

	async pause(): Promise<void> {
		await this.session.goalRuntime.pauseGoal();
		await this.exit({ paused: true, reason: "paused" });
	}

	async resume(): Promise<void> {
		await this.enter({ resume: true });
		this.scheduleContinuation();
	}

	async drop(): Promise<void> {
		await this.session.goalRuntime.dropGoal();
		await this.exit({ reason: "dropped" });
	}

	async setBudget(budget: number | undefined): Promise<void> {
		await this.session.goalRuntime.onBudgetMutated(budget);
		this.resetSuppression();
		this.scheduleContinuation();
	}

	/** Guided-goal pre-interview toolset snapshot (restored by `exit`). */
	setPreviousTools(tools: string[]): void {
		this.#previousTools = tools;
	}

	getPausedState(): GoalModeState | undefined {
		const state = this.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	/**
	 * Goal half of a session resume/switch. Call `clearTransient()` first when switching away from a
	 * live goal. Handles every outcome for a `goal`/`goal_paused` session mode; for any other mode it
	 * only clears goal accounting.
	 */
	async restoreFromSession(context: SessionContext, options?: { preserveActiveGoal?: boolean }): Promise<void> {
		const isGoalMode = context.mode === "goal" || context.mode === "goal_paused";
		if (!cfgGoalEnabled.get(this.session.settings) && isGoalMode) {
			this.session.goalRuntime.clearAccounting();
			this.session.sessionManager.appendModeChange("none");
			return;
		}
		if (isGoalMode) {
			const goal = goalFromModeData(context.modeData);
			if (!goal) {
				this.session.sessionManager.appendModeChange("none");
				return;
			}
			this.session.setGoalModeState({
				enabled: context.mode === "goal",
				mode: "active",
				goal,
			});
			const restored = await this.session.goalRuntime.onThreadResumed({
				preserveActiveGoal: options?.preserveActiveGoal,
			});
			this.#enabled = restored?.enabled === true;
			this.#paused = restored?.enabled !== true && restored?.goal.status === "paused";
			// sdk.ts excludes "goal" from the initial active tool set unconditionally.
			// Re-add it now so the agent can call resume, complete, or drop on this goal.
			if (restored?.goal) {
				const previousTools = this.session.getEnabledToolNames().filter(name => name !== "goal");
				this.#previousTools = previousTools;
				await this.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
			}
			this.host?.onStatusChanged?.();
			return;
		}
		this.session.goalRuntime.clearAccounting();
	}

	async clearTransient(): Promise<void> {
		if (!this.#enabled && !this.#paused) return;
		if (this.#previousTools !== undefined) {
			await this.session.setActiveToolsByName(this.#previousTools);
		}
		this.session.setGoalModeState(undefined);
		this.#enabled = false;
		this.#paused = false;
		this.#previousTools = undefined;
		this.#pendingTurns = 0;
		this.#previousActivity = undefined;
		this.#suppressNext = false;
		this.cancelContinuation();
		this.host?.onStatusChanged?.();
	}

	async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.cancelContinuation();
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.resetSuppression();
			return;
		}
		if (event.type === "goal_updated") {
			// Handle drop before clearing `enabled` so exit() can still restore the previous tool set.
			if (event.state?.goal?.status === "dropped") {
				await this.exit({ reason: "dropped" });
				return;
			}
			this.#enabled = event.state?.enabled === true;
			this.#paused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (!event.state?.enabled) {
				this.cancelContinuation();
			}
			this.host?.onStatusChanged?.();
			return;
		}
		if (event.type !== "agent_end") {
			return;
		}
		if (this.#pendingTurns > 0) {
			this.#pendingTurns--;
			const activity = goalContinuationActivity(event.messages);
			this.#suppressNext = activity.length === 0 || activity === this.#previousActivity;
			this.#previousActivity = activity;
		} else {
			this.resetSuppression();
		}
		if (await this.exitIfCompleted()) return;
		this.scheduleContinuation();
	}

	/** A non-continuation submission starts a fresh run of continuation turns. */
	noteSubmission(customType: string | undefined): void {
		if (customType !== "goal-continuation") {
			this.#pendingTurns = 0;
		}
	}

	/** A submitted continuation turn was cancelled before it started. */
	noteContinuationCancelled(): void {
		this.#pendingTurns = Math.max(0, this.#pendingTurns - 1);
	}

	resetSuppression(): void {
		this.#suppressNext = false;
		this.#previousActivity = undefined;
	}

	scheduleContinuation(): void {
		this.cancelContinuation();
		const host = this.host;
		if (!host || !this.continuationEnabled) return;
		if (this.session.getPlanModeState()?.enabled) return;
		if (!this.#enabled || this.#paused) return;
		if (this.#suppressNext) return;
		if (this.#openWorkAllBlocked()) return;
		if (!host.canAutoSubmit("schedule")) return;
		const state = this.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			if (!this.#enabled || this.#paused) return;
			// The timer can outlive the idle window that scheduled it: a `/goal set` taken via the
			// streaming branch (or any extension/hook path that starts a turn while we wait) leaves
			// the agent busy. Drop this tick; `handleSessionEvent` reschedules on the next `agent_end`.
			if (!host.canAutoSubmit("fire")) return;
			const latestState = this.session.getGoalModeState();
			if (!latestState?.enabled || latestState.goal.status !== "active") return;
			if (this.#openWorkAllBlocked()) return;
			this.#pendingTurns++;
			void this.#submit(host, prompt);
		}, CONTINUATION_DELAY_MS);
	}

	cancelContinuation(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	dispose(): void {
		this.cancelContinuation();
	}

	async #submit(host: GoalContinuationHost, prompt: string): Promise<void> {
		try {
			await host.submitContinuation(prompt);
		} catch (error) {
			this.noteContinuationCancelled();
			logger.error("Goal continuation submit failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** A blocked-only todo list has no work the agent can advance without another turn. */
	#openWorkAllBlocked(): boolean {
		const phases = this.session.getTodoPhases();
		if (nextActionableTask(phases)) return false;
		for (const phase of phases) {
			for (const task of phase.tasks) {
				if (task.status === "blocked") return true;
			}
		}
		return false;
	}
}
