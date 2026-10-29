# Sidecar store: results (2026-10-29)

Wesley's pick: one separate file per session for the model-call bodies, with a small pointer left in the transcript. Code lives on `feat/model-call-sidecar-store`, based on `origin/wesley/dev` `626061efcb`, with a PR into `wesley/dev`.

## What changed

- The model-call journal (`packages/coding-agent/src/session/model-call-journal.ts`) writes each record to `<session file without .jsonl>/model-calls.ndjson` first, then appends a `custom` `omp:model-call` pointer to the transcript: `{version: 2, key, requestId, phase, model}`. The sidecar line is the pointer plus the body (`context`, `payload`, `message`, `error`).
- The sidecar uses `.ndjson`, not `.jsonl`: the HTML exporter treats every `*.jsonl` in the artifacts directory as a subagent transcript.
- HTML export resolves pointers for the main session and every subagent session (`resolveModelCallEntries`). A pointer whose record is gone shows "Model-call record is missing from model-calls.ndjson". Old version 1 inline records still render.
- Fork, branch, persisted copy and `forkFrom` copy the sidecar (`copyModelCallRecords`, clone-on-write when the filesystem supports it), so inherited pointers still resolve.
- In-memory sessions record nothing (export already refuses them).
- Errors keep the old meaning: a failed sidecar write fails the call, and no pointer is written without its record.

## Bar (set before the runs)

On a replay of the 545 MB session `01a184a8` (hardy-crocodile): transcript at most 21.2 MB, reopen heap at most 116 MB, 630 of 630 calls complete.

## Replay of the 545 MB session

Scripts (throwaway, not in the repo): `/tmp/transcript-bloat/replay-sidecar.ts`, `/tmp/transcript-bloat/verify-sidecar.ts`, `/tmp/transcript-bloat/open-rss-branch.ts` (the section 1 heap script from [the evidence](../research/evidence-2026-10-29.md), pointed at this branch).

Method: every recorded call in a copy of the session was driven through the real writer (`createModelCallJournalStream`) with a fake provider that replays the recorded payload and terminal event. The transcript was then rebuilt line for line with the writer's pointers in place of the inline bodies, and the writer's sidecar placed beside it.

```json
{"sourceBytes":545281269,"sourceJournalBytes":535198522,"calls":630,"replayed":630,"noRequest":0,"convertedBytes":10656044,"sidecarBytes":534996292,"seconds":16.7}
{"sourceCalls":630,"sourceRecords":1890,"convertedPointers":1890,"missingRecords":0,"completeCalls":630,"badCalls":[]}
```

`completeCalls` counts calls whose every record resolves through the export path with a body equal to the original (hash of `context`, `payload`, `message`, `error`).

Reopen through `SessionManager.open` (three runs on the new transcript, then the original, same machine, same hour):

| File | Size | Open | Heap after open | RSS after open |
| --- | --- | --- | --- | --- |
| New transcript | 10,656,044 B | 55 / 59 / 59 ms | 51 / 54 / 51 MB | 221 / 225 / 222 MB |
| Original | 545,281,269 B | 1,849 ms | 1,445 MB | 1,657 MB |

| Bar | Result | Pass |
| --- | --- | --- |
| Transcript ≤ 21.2 MB | 10.66 MB | yes |
| Heap ≤ 116 MB | 51–54 MB | yes |
| 630/630 calls complete | 630/630 | yes |

The sidecar is about the size of the old inline bodies (535 MB). This change moves the bytes out of the transcript; it does not shrink them. Disk growth per call is unchanged.

## Live run from the branch

`bun packages/coding-agent/src/cli.ts -p --no-tools --model claude-haiku-4-5 "Reply with the single word: pong"` with `PI_CODING_AGENT_SESSION_DIR=/tmp/transcript-bloat/live-sessions`:

- Transcript 9,604 B with three pointers (`request`, `payload`, `response`), no bodies.
- Sidecar `model-calls.ndjson` 39,510 B with three records, keys matching the pointers, bodies `context`, `payload`, `message`.
- `--export` with the sidecar present: all three records resolved; the response text is `pong`.
- `--export` with the sidecar moved away: all three pointers come back marked `unavailable: "missing"`, which the page shows as the missing-record notice.

## Checks

- `bun test test/model-call-journal.test.ts test/export test/session-manager test/export-html-template.test.ts`: 318 pass, 0 fail.
- `bun run check:types`: pass. `oxlint` and `oxfmt --check` on the touched files: clean.
- Package `bun check` still fails on `test/rpc-extension-ui.test.ts` formatting. That file is unchanged since `origin/wesley/dev`; the failure predates this branch.

## Not covered

- Sessions written before this change keep their inline bodies. Nothing migrates them; the five oversized sessions stay oversized.
- Concurrent calls append to one sidecar with one `appendFile` each. A partial write would damage one line; the reader skips damaged lines and the pointer shows as missing.
- Branching copies the whole sidecar, including records the branch does not point at.
- No `SPEC.md` exists for `packages/coding-agent/src/session`; `docs/session.md` is the updated reference.
