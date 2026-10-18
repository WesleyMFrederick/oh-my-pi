import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import type { GoalModeState } from "./state";

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS: Record<GoalSubcommand, true> = {
	set: true,
	show: true,
	pause: true,
	resume: true,
	drop: true,
	budget: true,
};

/** User-facing `/goal` wording shared by the TUI and the text (RPC/ACP) handler. */
export const GOAL_TEXT = {
	alreadyActive: "Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
	resumeFirst: "Resume the current goal first, or drop it before setting a new objective.",
	disabled: "Goal mode is disabled. Enable it in settings (goal.enabled).",
	noActiveGoal: "No active goal.",
	noGoalToPause: "No active goal to pause.",
	noPausedGoal: "No paused goal to resume.",
	noGoalToDrop: "No goal to drop.",
	resumeBeforeBudget: "Resume the goal before adjusting the budget.",
	alreadyComplete: "Goal is already complete.",
	invalidBudget: "Goal budget must be a positive integer or `off`.",
} as const;

export function parseGoalSubcommand(args: string): {
	sub: GoalSubcommand | undefined;
	rest: string;
} {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (Object.hasOwn(GOAL_SUBCOMMANDS, first)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

/** Parses a `/goal budget` argument: a positive integer or `off` (cleared). `undefined` when invalid. */
export function parseGoalBudget(raw: string): { budget: number | undefined } | undefined {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "off") return { budget: undefined };
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
	return { budget: parsed };
}

/** Detail lines for `/goal show`. */
export function formatGoalDetails(state: GoalModeState): string {
	const goal = state.goal;
	const used = goal.tokensUsed.toLocaleString();
	const budgetLine =
		goal.tokenBudget !== undefined
			? `${used} / ${goal.tokenBudget.toLocaleString()} (${Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()} left)`
			: `${used} (no budget)`;
	return [
		`Objective: ${goal.objective}`,
		`Status: ${goal.status}${state.enabled ? "" : " (paused)"}`,
		`Tokens: ${budgetLine}`,
		`Time spent: ${formatCoarseDuration(goal.timeUsedSeconds * 1000)}`,
	].join("\n");
}
