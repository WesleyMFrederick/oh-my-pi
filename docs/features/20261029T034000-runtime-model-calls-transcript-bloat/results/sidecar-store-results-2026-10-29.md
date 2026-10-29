# Sidecar store: results (2026-10-29)

Wesley's pick: one separate file per session for the model-call bodies, with a small pointer left in the transcript. Code lives on `feat/model-call-sidecar-store`, based on `origin/wesley/dev` `626061efcb`, with a PR into `wesley/dev`.

## What changed

- The model-call journal (`packages/coding-agent/src/session/model-call-journal.ts`) writes each record to `<session file without .jsonl>/model-calls.ndjson` first, then appends a `custom` `omp:model-call` pointer to the transcript: `{version: 2, key, requestId, phase, model}`. The sidecar line is the pointer plus the body (`context`, `payload`, `message`, `error`).
- The sidecar uses `.ndjson`, not `.jsonl`: the HTML exporter treats every `*.jsonl` in the artifacts directory as a subagent transcript.
- HTML export resolves pointers for the main session and every subagent session (`resolveModelCallEntries`). A pointer whose record is gone shows "Model-call record is missing from model-calls.ndjson". Old version 1 inline records still render.
- Branch, persisted copy and `forkFrom` without artifacts copy the sidecar asynchronously (`copyModelCallRecords`, `fs.promises.copyFile` with clone-on-write when the filesystem supports it); journal appends and export reads wait for a pending copy. Paths that already copy the artifacts directory (`AgentSession.fork`, `forkFrom` with artifacts) do not copy it a second time.
- Each sidecar record goes through the transcript's own persistence step (`truncateForPersistence`): image base64 moves to the shared image store as a blob reference, and strings are capped at 500,000 characters. Export restores the images (`resolveBlobRefsInEntries`) on sidecar records only.
- Before the first append in a process, the writer adds a newline if a crash left the sidecar without one, so a torn tail cannot swallow the next record.
- `omp gc` archive gzips the sidecar to `model-calls.ndjson.gz` along with the transcript and rolls both back on failure. The gc blob sweep also scans sidecars, so blobs referenced only from a sidecar are kept.
- In-memory sessions record nothing (export already refuses them).
- Errors keep the old meaning: a failed sidecar write fails the call, and no pointer is written without its record.

## Bar (set before the runs)

On a replay of the 545 MB session `01a184a8` (hardy-crocodile): transcript at most 21.2 MB, reopen heap at most 116 MB, 630 of 630 calls complete.

## Replay of the 545 MB session

Scripts (throwaway, not in the repo): `/tmp/transcript-bloat/replay-sidecar.ts`, `/tmp/transcript-bloat/verify-sidecar.ts`, `/tmp/transcript-bloat/open-rss-branch.ts` (the section 1 heap script from [the evidence](../research/evidence-2026-10-29.md), pointed at this branch).

Method: every recorded call in a copy of the session was driven through the real writer (`createModelCallJournalStream`) with a fake provider that replays the recorded payload and terminal event. The transcript was then rebuilt line for line with the writer's pointers in place of the inline bodies, and the writer's sidecar placed beside it.

Evidence: [review-fixes-evidence-2026-10-29.txt](review-fixes-evidence-2026-10-29.txt), rerun after the review fixes (lines 6 and 8):

```json
{"sourceBytes":545281269,"sourceJournalBytes":535198522,"calls":630,"replayed":630,"noRequest":0,"convertedBytes":10656044,"sidecarBytes":534996292,"seconds":11.9}
{"sourceCalls":630,"sourceRecords":1890,"convertedPointers":1890,"missingRecords":0,"completeCalls":630,"badCalls":[]}
```

`completeCalls` counts calls whose every record resolves through the export path with a body equal to the original (hash of `context`, `payload`, `message`, `error`).

Reopen through `SessionManager.open` (three runs each, same machine, same hour; evidence lines 14–16 for the original, 18–20 for the new transcript):

| File | Size | Open | Heap after open | RSS after open |
| --- | --- | --- | --- | --- |
| New transcript | 10,656,044 B | 49 / 48 / 47 ms | 57 / 57 / 57 MB | 225 / 226 / 227 MB |
| Original | 545,281,269 B | 2,011 / 1,778 / 2,064 ms | 1,152 / 1,412 / 1,439 MB | 1,661 / 1,655 / 1,653 MB |

Heap on the original varies by run with garbage-collector timing; RSS is steady.

| Bar | Result | Pass |
| --- | --- | --- |
| Transcript ≤ 21.2 MB | 10.66 MB | yes |
| Heap ≤ 116 MB | 57 MB | yes |
| 630/630 calls complete | 630/630 | yes |

The sidecar is about the size of the old inline bodies (535 MB). This change moves the bytes out of the transcript; it does not shrink them.

Images: `/tmp/sidecar-pr-check/image.ts` makes three calls carrying one 1.5 MB image. Before the review fix the sidecar held 12,003,285 B of base64. After it, the sidecar is 3,741 B and the transcript 3,039 B, with one 1,500,000 B blob in the shared image store; the old inline transcript for the same calls is 3,318 B with the same blob (evidence lines 3–4). Image bytes are stored once, as before.

Archived sessions: `/export` of a gzipped archived `.jsonl.gz` fails with "the session header is missing or malformed" both on `origin/wesley/dev` `626061efcb` and on this branch (evidence lines 22–25), so archived sessions did not show model calls before this change and still do not.

## Live run from the branch

`bun packages/coding-agent/src/cli.ts -p --no-tools --model claude-haiku-4-5 "Reply with the single word: pong"` with `PI_CODING_AGENT_SESSION_DIR=/tmp/transcript-bloat/live-sessions`:

- Transcript 9,604 B with three pointers (`request`, `payload`, `response`), no bodies.
- Sidecar `model-calls.ndjson` 39,510 B with three records, keys matching the pointers, bodies `context`, `payload`, `message`.
- `--export` with the sidecar present: all three records resolved; the response text is `pong`.
- `--export` with the sidecar moved away: all three pointers come back marked `unavailable: "missing"`, which the page shows as the missing-record notice.

## Checks

- Review fixes, failing first: with the fix's source changes stashed, the four new or changed tests fail (image reference, torn tail, gc sidecar-only blob, gc archive gzip); with them, they pass. The restored `fork` row in the sidecar copy test fails without the `fork()` copy and passes with it.
- `bun test test/model-call-journal.test.ts test/gc-cli.test.ts test/export test/export-html-assistant-ordering.test.ts test/export-html-template.test.ts test/session-manager test/advisor-toggle.test.ts test/agent-session-btw-branch.test.ts`: 439 pass, 1 fail across 42 files. The one failure, `new-session-boundary.test.ts` "skips an explicit /new boundary on a different terminal", did not come back in 20 repeat runs of the same set (10 on this branch: 439 pass, 0 fail; 10 on `origin/wesley/dev`: 425 pass, 0 fail), and it fails in the full suite on `origin/wesley/dev` too.
- Full `packages/coding-agent` suite, compared by test name: `origin/wesley/dev` `626061efcb` 15,922 pass, 40 fail; this branch 15,941 pass, 38 fail, across 1,585 files. The branch adds no failures that repeat. Four names failed once on this branch only. Run alone, `browser-snapshot-plus.test.ts` passed 3 of 3 runs on both trees. `acp-agent.test.ts` fails 5 of 5 runs on both trees with a different set of names each run, and all three ACP names also failed on `origin/wesley/dev`.
- The ported export work records each submission with `appendCustomEntry`. Two input-controller test fakes lacked that method, and the dispatch-race test hard-coded the leaf from before the record existed. The fakes now stub it, and the test checks that the cancelled navigation leaves the leaf unchanged. Export behavior is unchanged.
- `bun run check:types`: pass. `oxlint` and `oxfmt --check` on the touched files: clean.
- Package `bun check` still fails on `test/rpc-extension-ui.test.ts` formatting. That file is unchanged since `origin/wesley/dev`; the failure predates this branch.

## Not covered

- Sessions written before this change keep their inline bodies. Nothing migrates them; the five oversized sessions stay oversized.
- Concurrent calls append to one sidecar with one `appendFile` each. A torn last line is closed off before the next append; the damaged line itself is skipped by the reader and its pointer shows as missing.
- Branching copies the whole sidecar, including records the branch does not point at.
- No `SPEC.md` exists for `packages/coding-agent/src/session`; `docs/session.md` is the updated reference.
