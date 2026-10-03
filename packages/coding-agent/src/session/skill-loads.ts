import { SKILL_PROMPT_MESSAGE_TYPE } from "./messages";
import type { SessionEntry } from "./session-entries";

/** `skill://<name>`, optionally `/SKILL.md` or a `:selector`; reference files under the skill do not count. */
const SKILL_URI = /^skill:\/\/([^/:]+)(?:\/SKILL\.md)?(?::.*)?$/;
/** A skill's own `SKILL.md` read by filesystem path. */
const SKILL_FILE = /[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md(?::.*)?$/;

/** Skill name a `read` path loads, or `undefined` when the path is not a skill's main file. */
function skillReadName(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	return (SKILL_URI.exec(path) ?? SKILL_FILE.exec(path))?.[1];
}

/** Skill names one session entry loads, in order: `/skill:<name>` prompts and `read` calls on a skill's main file. */
function* entrySkillLoads(entry: SessionEntry): Generator<string> {
	if (entry.type === "custom_message") {
		if (entry.customType !== SKILL_PROMPT_MESSAGE_TYPE) return;
		const { details } = entry;
		if (details && typeof details === "object" && "name" in details && typeof details.name === "string") {
			yield details.name;
		}
		return;
	}
	if (entry.type !== "message" || entry.message.role !== "assistant") return;
	for (const block of entry.message.content) {
		if (block.type !== "toolCall" || block.name !== "read") continue;
		const name = skillReadName(block.arguments.path);
		if (name !== undefined) yield name;
	}
}

/**
 * The most recently loaded skill among `names` on the session branch `entries`
 * (oldest first), or `undefined` when none of them was loaded. Reads the
 * persisted branch, so compaction of the model context does not lose loads.
 */
export function lastSkillLoad(entries: readonly SessionEntry[], names: ReadonlySet<string>): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		let last: string | undefined;
		for (const name of entrySkillLoads(entries[i])) {
			if (names.has(name)) last = name;
		}
		if (last !== undefined) return last;
	}
	return undefined;
}
