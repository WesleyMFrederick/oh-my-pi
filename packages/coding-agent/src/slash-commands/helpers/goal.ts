import { prompt } from "@oh-my-pi/pi-utils";
import { formatGoalDetails, GOAL_TEXT, parseGoalBudget, parseGoalSubcommand } from "../../goals/command-text";
import type { GoalModeController } from "../../goals/mode-controller";
import { cfgGoalEnabled } from "../../goals/settings";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, usage } from "./parse";

const GOAL_SUBCOMMAND_LIST = "set|show|pause|resume|drop|budget";

/** Expose the goal tool for the interview and preserve the toolset restored when the goal exits. */
export async function armGuidedGoal(
	session: AgentSession,
	goalMode: GoalModeController,
	rough: string | undefined,
): Promise<string> {
	const enabledTools = session.getEnabledToolNames();
	goalMode.setPreviousTools(enabledTools.filter(name => name !== "goal"));
	if (!enabledTools.includes("goal")) {
		await session.setActiveToolsByName([...enabledTools, "goal"]);
	}
	return prompt.render(guidedGoalInterviewPrompt, { initial: rough?.trim() || undefined });
}

export async function handleGuidedGoalTextCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { goalMode, session } = runtime;
	const say = async (text: string): Promise<SlashCommandResult> => {
		await runtime.output(text);
		return commandConsumed();
	};
	if (!goalMode) return await say("Goal mode is not available in this mode.");
	if (session.getPlanModeState()?.enabled) return await say("Exit plan mode first.");
	if (session.getVibeModeState()?.enabled) return await say("Exit vibe mode first.");
	if (!cfgGoalEnabled.get(runtime.settings)) return await say(GOAL_TEXT.disabled);
	if (goalMode.enabled) return await say(GOAL_TEXT.alreadyActive);
	if (goalMode.getPausedState()) return await say(GOAL_TEXT.resumeFirst);

	const kickoff = await armGuidedGoal(session, goalMode, command.args);
	if (session.isStreaming) {
		await session.followUp(kickoff, undefined, { synthetic: true });
		return commandConsumed({ agentInvoked: true });
	}
	return { prompt: kickoff, synthetic: true };
}

/** Loud line shown when a goal is running but nothing will keep it going between turns. */
function autoContinueOffLine(goalMode: GoalModeController): string | undefined {
	if (goalMode.continuationEnabled) return undefined;
	const host = goalMode.host;
	if (!host) {
		return "Auto-continue is not supported in ACP mode; the goal only advances when you send a turn.";
	}
	return `Auto-continue is off in ${host.runMode} mode; add it to goal.continuationModes to keep working between turns.`;
}

/**
 * Text-mode (RPC/ACP) `/goal`. Mirrors the TUI command without menus or confirmations: the user
 * typed the subcommand, so `drop` does not ask. Starting or replacing a goal returns the objective
 * as the prompt so the dispatcher sends it as the first turn.
 */
export async function handleGoalTextCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { goalMode, session } = runtime;
	const say = async (text: string): Promise<SlashCommandResult> => {
		await runtime.output(text);
		return commandConsumed();
	};
	if (!goalMode) return await say("Goal mode is not available in this mode.");
	if (session.getPlanModeState()?.enabled) return await say("Exit plan mode first.");
	if (session.getVibeModeState()?.enabled) return await say("Exit vibe mode first.");
	if (!cfgGoalEnabled.get(runtime.settings)) return await say(GOAL_TEXT.disabled);

	const paused = goalMode.getPausedState() !== undefined;
	const hasGoal = goalMode.enabled || paused;
	const state = session.getGoalModeState();

	const start = async (objective: string): Promise<SlashCommandResult> => {
		if (goalMode.enabled) await goalMode.replace(objective);
		else await goalMode.enter({ objective });
		const offLine = autoContinueOffLine(goalMode);
		if (offLine) await runtime.output(offLine);
		if (session.isStreaming) {
			await session.prompt(objective, { streamingBehavior: "steer" });
			return commandConsumed({ agentInvoked: true });
		}
		return { prompt: objective };
	};

	const { sub, rest } = parseGoalSubcommand(command.args);
	switch (sub) {
		case undefined: {
			if (!rest) {
				if (!state?.goal || !hasGoal) return usage(`Usage: /goal <objective> | ${GOAL_SUBCOMMAND_LIST}`, runtime);
				return await say(`${formatGoalDetails(state)}\nSubcommands: ${GOAL_SUBCOMMAND_LIST}`);
			}
			if (goalMode.enabled) return await say(GOAL_TEXT.alreadyActive);
			if (paused) return await say(GOAL_TEXT.resumeFirst);
			return await start(rest);
		}
		case "set": {
			if (!rest) return usage("Usage: /goal set <objective>", runtime);
			if (!goalMode.enabled && paused) return await say(GOAL_TEXT.resumeFirst);
			return await start(rest);
		}
		case "show":
			return await say(state?.goal ? formatGoalDetails(state) : "No goal set.");
		case "pause": {
			if (!goalMode.enabled) return await say(GOAL_TEXT.noGoalToPause);
			await goalMode.pause();
			return await say("Goal mode paused.");
		}
		case "resume": {
			if (!paused) return await say(GOAL_TEXT.noPausedGoal);
			await goalMode.resume();
			await runtime.output("Goal mode resumed.");
			const offLine = autoContinueOffLine(goalMode);
			if (offLine) await runtime.output(offLine);
			return commandConsumed();
		}
		case "drop": {
			if (!hasGoal) return await say(GOAL_TEXT.noGoalToDrop);
			await goalMode.drop();
			return await say("Goal dropped.");
		}
		case "budget": {
			if (!goalMode.enabled) return await say(paused ? GOAL_TEXT.resumeBeforeBudget : GOAL_TEXT.noActiveGoal);
			if (!rest) return usage("Usage: /goal budget <N|off>", runtime);
			if (state?.goal.status === "complete") return await say(GOAL_TEXT.alreadyComplete);
			const parsed = parseGoalBudget(rest);
			if (!parsed) return await say(GOAL_TEXT.invalidBudget);
			await goalMode.setBudget(parsed.budget);
			return await say(
				parsed.budget === undefined ? "Goal budget cleared." : `Goal budget set to ${parsed.budget}.`,
			);
		}
	}
}
