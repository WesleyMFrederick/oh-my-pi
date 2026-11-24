# session_info

> Report non-sensitive metadata about the session that owns the calling agent.

## Source

- Entry: `packages/coding-agent/src/tools/session-info.ts`
- Registration: `packages/coding-agent/src/tools/index.ts` (`session_info` factory) and `packages/coding-agent/src/tools/builtin-names.ts`

## Input and availability

`session_info` takes no arguments (extra keys are rejected). It is a read-approved, discoverable built-in tool that is on by default.

## Behavior

- Returns the metadata as pretty-printed JSON text and as structured `details`.
- Fields: `sessionId`, `sessionName`, `sessionFile`, `cwd`, `modelProvider`, `modelId`, `thinkingLevel`, `approvalMode`, `contextUsage` (tokens, context window, percent), `messageCounts` (user, assistant, tool calls, tool results, total), `tokenCounts` (input, output, cache read, cache write, total), `cost`, `streaming`, and `compaction` (whether compaction is active and the speculation state).
- A field the host session cannot report is `null`, not omitted.
- No credentials, prompts, or message contents are returned.
