# Who reads runtime model-call entries in transcripts (2026-10-29)

Question from Wesley on card A1: "What downstream consumers use transcript runtime entries?" His hint: "probably mostly used by cc workflows plugin context display and other serving HTML type pages."

## Answer

- #OBS One reader uses the bodies: omp's own `/export` HTML viewer, and only in the main checkout's uncommitted `template.js`. Everything else either carries the entries unchanged or reads and parses them, then throws them away.
- #OBS The cc-workflows-plugin context display does not read them. It has its own recorder that writes a second copy of every model request to `~/.omp/capture-sessions/`, outside the transcript, kept 2 days. So each request body is stored twice today.
- #OBS The cost falls on readers that parse the whole transcript: the Paseo daemon, the plugin transcript reader and its callers, workflow telemetry, cache-break counting, and the unmerged mission-control portal.

## Method

Four searches, then reading every hit at its line.

| Search | Tool | Scope | Result |
| --- | --- | --- | --- |
| Meaning search | semble agent `SembleConsumers` | omp worktree, omp main checkout, cc-workflows-plugin, Paseo app bundle | 1 semantic reader (the viewer) plus carriers and cost payers |
| References | LSP agent `LspConsumers` (`typescript-language-server` JSON-RPC, because `xd://lsp` was not available to the subagent) | references of `MODEL_CALL_CUSTOM_TYPE`, `ModelCallJournalData`, `CustomEntry`, `appendCustomEntry`, `getEntries`, `getBranch`, fork and copy APIs | declaration, writer, test; no other semantic reference |
| Exact text | grep agents `GrepOmpRepos`, `GrepExternal` | omp repos, stats, Paseo | same set |
| Exact text, all branches | this session | cc-workflows-plugin: all 157 local and remote refs (`git grep -E 'model-call\|modelCallJournal\|ModelCallJournal' <ref> -- src src-claude scripts`), plus the working tree of all 61 plugin worktrees (`rg -F 'omp:model-call' <worktree>/src`) | 0 readers of `omp:model-call`; every `model-call` hit is an unrelated name (below) |

## A. Uses the body (needs it)

| Reader | Where | What it does | Status |
| --- | --- | --- | --- |
| omp `/export` HTML viewer | `oh-my-pi` main checkout `packages/coding-agent/src/export/html/template.js:41,357-364,383-396,639-642,1055,1435-1443` | Matches `entry.customType === 'omp:model-call'`, shows `call.payload ?? call.context ?? call.message ?? call.error` as "Text sent to LLM", indexes the bodies for search, hides a `request` when a `payload` for the same `requestId` exists | Uncommitted in the main checkout |
| omp export builder | same checkout `packages/coding-agent/src/export/html/index.ts:198-205` | Embeds `sm.getEntries()` (bodies included) as base64 in the HTML file | Feeds the viewer |
| Journal test | this worktree `packages/coding-agent/test/model-call-journal.test.ts:73-80,123-129,155-158` | Reads `entry.data` and asserts `context`, `context.tools`, `payload` | Test only |

Also in the same viewer: `omp:user-submission` and `omp:prompt-submission` bodies (`template.js:1446`). Those are user text, not model requests; out of scope here.

## Not readers: the plugin context display and HTML pages

| Surface | What it reads | Evidence |
| --- | --- | --- |
| Context cost page and omp context overview page (`src/serving-html/src/pages/context-cost/`, `omp-context-overview/`) | `~/.omp/capture-sessions/<session>/capture.jsonl` | `src/context-proxy/src/read-omp-context-overview.ts:26` (`CAPTURE_FILE_NAME = "capture.jsonl"`); `src/context-proxy/context-cost-cli.ts:172,197` (`resolveOmpCaptureFile`, `readCaptureRecords`) |
| Who writes that file | The plugin's own omp extension, on every `before_provider_request` | `src/context-proxy/omp-context-capture.ts:2` ("captures every main-loop model call into `~/.omp/capture-sessions/`"), `:17` (`RETENTION = Duration.days(2)`); hook `src/context-proxy/src/omp-context-capture-hook.ts:270`; loaded through `src/omp-extension-bundle/entries.json:20` |
| How it touches the native transcript | First 16 KB only, to find a helper session's parent | `read-omp-context-overview.ts:28` (`TRANSCRIPT_HEAD_BYTES = 16_384`), `:316-339` |
| Size on this machine, 2026-10-29 | 434 session folders, 4.1 GB | `ls ~/.omp/capture-sessions \| wc -l`; `du -sh ~/.omp/capture-sessions` |
| Unrelated `model-call` names | convert-pdf timeline segment kind; prose-rewriter timing | `src/serving-html/src/pages/pdf-conversion-timeline-data.ts:136`, `src/tools/convert-pdf/infrastructure/timeline-projection.ts:549`, `src/prose-rewriter/test/model-call-timing.test.ts` |

#A The capture record holds the request after hooks, the same content as the journal's `payload` record. Source: hook doc `omp-context-capture-hook.ts:4` ("snapshot each request body ... on `before_provider_request`"). Record-by-record equality not checked.

## B. Carries the entries unchanged (no use of the body)

All in this worktree's `packages/coding-agent/src/session/session-manager.ts` unless noted.

- Fork, copy, branch: `fork` (`:2252`), `persistCopy` (`:2463`, `structuredClone(this.#entries)`), `cloneCurrentSession` (`:2051`), `createBranchedSession` (`:3620`), `forkFrom` (`:3742-3803`, also copies the session artifact folder unless `copyArtifacts === false`).
- Every rewrite reserializes all entries: `#lineFor`, `rewriteEntries` (`for (const entry of this.#entries) body += this.#lineFor(entry)`).
- Persistence: `session-persistence.ts:108-244` truncates oversized strings and externalizes images for every entry, custom included.
- RPC: `modes/rpc/rpc-mode.ts:1767-1787` returns all entries to RPC clients.
- Maintenance: `session-maintenance.ts` rewrites branch entries; model-call entries pass through.
- Share: `export/share.ts:317-318` (`case "custom": return { ...entry, data: undefined }`) strips them.
- Collab: `collab/host.ts:749-763` snapshots all entries, then drops `custom` from the wire.
- Model context: `session-context.ts:380-403` builds messages only from `message`, `custom_message`, `branch_summary`; model-call entries never reach the model.

## C. Reads and parses them, then drops them (pays the cost)

| Reader | Read | Hot path | What it keeps |
| --- | --- | --- | --- |
| Paseo daemon 0.13.2 `readActiveOmpEntryChain` | `node_modules/@getpaseo/server/dist/server/server/agent/providers/omp/history.js:255-263`: `readFile(sessionFile, "utf8")`, `JSON.parse` on every line, keeps every entry on the active path | History hydrate, todo state, subagent children (`:10,59,99`) | Drops `type === "custom"` from display (`:360`). Fails over 536,870,888 bytes (main doc section 6) |
| omp session loader | `session-loader.ts:303-313` | Every resume | Holds every entry in memory (main doc section 5) |
| omp stats | `packages/stats/src/parser.ts:448` | `omp stats` sync | Messages and `model_usage` only |
| omp session picker | `session-listing.ts:67,73,423-427`: 4 KB head and 32 KB tail only | Every session list | Status comes from the last `message` in the tail; see measure below |
| Plugin transcript reader `parseFile` | `src/transcript-reader/parseTranscript.ts:252` `readFileString`, one event per line, raw fields kept | Called by `run-metrics/src/collect-turn-report.ts:147`, `workflow-run/src/interview-system/sync-interview.ts:125`, `workflow-run/src/prd-system/evidence-cards/transcript-source.ts:71`, `transcript-reader/sessionTree.ts:258,272`, `transcript-reader/src/summarize-helper-model-usage.ts:250` | Messages, usage; model-call events kept raw but unused |
| Workflow telemetry | `src/workflow-run/src/system-run/omp-telemetry-source.ts:114` `readFileString`, parses every line | After each system-run attempt | Assistant messages only |
| Cache-break count, sessions mode | `src/context-proxy/cache-breaks-cli.ts:212-216` streams and decodes every line | On demand | Schema `bucket-session-rebuilds.ts:28-46` reads `custom_message`, not `custom` |
| Mission-control portal (unmerged, branch `feature/mission-control-portal-home`) | `src/serving-html/src/read-thread-writes.ts:288` reads new bytes only; `:183` skips lines without `"name":"write"`, then parses | Every portal refresh | `writePathsFrom` (`:145-155`) keeps only `type === "message"`. #M In session `01a184a8`, 646 of 1,890 model-call lines contain `"name":"write"` (they embed the whole message history), so they pass the filter and are parsed for nothing |
| In-process hooks | `src/omp-hooks/src/browser-artifact-guard.ts:89` (`getBranch()`), `src/omp-hooks/interview-recorder.ts:115` (`getEntries()`) | Hook events | Walk entries in memory, skip `custom` |

#M Session picker status, 2026-10-29, all 7,440 transcripts: status falls to "unknown" (no `message` entry in the last 32 KB) for 57 of 699 sessions with the journal (8.2%) and 326 of 6,741 without it (4.8%). Script: read the last 32,768 bytes, walk lines backwards like `deriveSessionStatus` (`session-listing.ts:162-182`). Small effect; listed for completeness.

## What this means for card A1

- #OBS Only the `/export` viewer needs the bodies. Any change that moves them out of the transcript must teach that one reader to load them; no other reader breaks.
- #OBS Fork and copy paths (section B) carry whatever the entry holds. With a pointer, they must carry or re-point the body file. `forkFrom` already copies the artifact folder, which is one place a body file could live.
- #OBS The plugin already runs a separate-file recorder for the same request bodies (section "Not readers"). That is a second copy today, and evidence that a separate store with retention works for the context display.
- #INFERENCE Every reader in section C gets cheaper with no code change if bodies leave the transcript; none of them gets worse.
- Card A1 options are unchanged by these findings. The card stays open.
