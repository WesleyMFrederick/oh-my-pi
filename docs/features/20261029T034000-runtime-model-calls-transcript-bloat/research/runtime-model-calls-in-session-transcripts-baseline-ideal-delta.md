# Runtime model calls in omp session transcripts: Baseline / Ideal / Delta

Date: 2026-10-29. Branch: `fix/runtime-model-calls-transcript-bloat` (from `origin/wesley/dev` `626061efcb`). Planning only: no code changed.

Where this lives: oh-my-pi had no plan or design folder (`docs/` holds flat topic docs; `git ls-files` shows no `plans/`, `design-docs/` or `docs/features/`). This adopts the cc-workflows-plugin layout `docs/features/<timestamp>-<slug>/{research,design}/`. Raw runs: [evidence-2026-10-29.md](evidence-2026-10-29.md). Design sketches: [design/design-it-twice/](../design/design-it-twice/).

Tags: #OBS observation, #M metric, #C constraint, #A assumption, #H hypothesis, #O outcome, #JTBD job. Sources are `path:line`, a command, or a section of the evidence file.

## In one paragraph

Since 2026-10-25, every model call an omp session makes writes a full copy of the conversation it sent into the session file. That copy is now 77.8% of all transcript bytes on this machine. Long sessions grow about 36 times faster than before. Reopening the 545 MB session costs 1.4 GB of memory; the same session without those copies costs 224 MB. Five sessions are now too large for Paseo to read at all, and one Paseo message to an agent failed because of it. The copies exist so `/export` can show exactly what was sent. The recommended fix keeps that audit but moves the copies into a separate file per session, leaving a small pointer in the transcript. It does not explain or fix the sudden 8 GiB process spikes or the 2026-10-28 kernel panic; their cause is still unknown.

## Baseline

### 1. What writes runtime model calls into transcripts

- #OBS One commit adds it: `e7ed7a2f32` "feat(coding-agent): journal model calls as omp:model-call session entries", 2026-10-26 09:56 -0700. Message: "Record each model call's request context, post-hook payload and response so /export can show everything sent to the model." Source: `git log --all -S 'omp:model-call'` returns only this commit; `git show -s e7ed7a2f32`.
- #OBS It is on the fork only. `upstream/main` (can1357/oh-my-pi) has no `model-call-journal.ts`; `origin/wesley/dev` is 63 commits ahead of `upstream/main`. Source: `git rev-list --count upstream/main..origin/wesley/dev`.
- #OBS Entry type `custom`, `customType: "omp:model-call"`. Source: `packages/coding-agent/src/session/model-call-journal.ts:8`.
- #OBS Four records per call, each a separate transcript line. `request` holds the full app context (system prompt, every message, tool schemas), deep-copied by JSON round trip (`model-call-journal.ts:23-27,48-55,120-122`). `payload` holds the provider request after hooks (`:126-129`). `response` or `error` holds the final message (`:135-153`).
- #OBS Every model call in the session goes through it, not only the main turn. `sdk.ts:4194` wraps the main stream; `sdk.ts:4532-4533` passes the same wrapped function as `sideStreamFn` and `advisorStreamFn`, which compaction, handoff and side turns use.
- #M By model, the journal on this machine holds: claude-opus-5-5 14,897 requests, 13.61 GB; gpt-6.1-sol 5,543, 2.92 GB; fable 1,601, 1.28 GB; claude-sonnet-5-5 1,235, 0.91 GB. These are each session's own agent calls, not the small Jev judge calls. Source: corpus scan, evidence section 3.
- #OBS The journal sits in the path of every model call. `sm.ensureOnDisk()` and the `request` record run before the provider call (`model-call-journal.ts:120-122`); a journal error rejects the call (`:167-176`). #M No journal failure has been logged: `rg 'Model-call journal' ~/.omp/logs` = 0 matches in 89 files.
- #OBS The journal is live in every omp session now: `~/.bun/bin/omp` links to the main checkout, which sits on local `wesley/dev` at `e7ed7a2f32` with uncommitted work (`readlink -f $(which omp)`; `git worktree list`).

### 2. Who reads these entries (the need Ideal must keep)

- #OBS One reader, not yet committed: the `/export` HTML viewer in the main checkout's uncommitted `packages/coding-agent/src/export/html/template.js` (about lines 41, 357-396, 639, 1055, 1435) renders model-call records as "Text sent to LLM". Source: `git -C <main checkout> status --short` lists `template.js` modified.
- #OBS Committed code on `wesley/dev` reads them only in a test: `packages/coding-agent/test/model-call-journal.test.ts:76`. Model context building skips them (B545 replay builds 58 context messages with or without bodies, evidence section 1).
- #OBS No reader in cc-workflows-plugin `src/`, in the stats package, or in Paseo (Paseo only reads the whole file; evidence section 4). Sharing strips custom-entry data (`packages/coding-agent/src/export/share.ts:317-318`). Source: the earlier consumer map (`/tmp/omp-model-call-storage-review.md`, "Downstream consumer map") plus exact search in this session.
- #OBS Need, in Wesley's commit words: "/export can show everything sent to the model". #M How often `/export` has been run since 2026-10-26: unknown. No export log exists, and a file search for exported HTML was refused by the research-scope guard.

### 3. The earlier fix attempt

- #OBS The only code fix is inside `e7ed7a2f32` itself. Its message: runtime tool objects "wrote about 10 MB per call (a 608 MB session replays to 44 MB with the projection)". It cut tool schemas to model-facing fields (`model-call-journal.ts:29-55`). It did not change the full copy of messages per call, which is what grows now.
- #OBS A second attempt on 2026-10-29 was research only. Session `01a18474-86a2`: Wesley reported an unexpected shutdown (L8), then a 536 MB transcript Paseo could not load (L215). The agent traced it to `e7ed7a2f32` (L310). Wesley proposed: "store runtime seperrate... the transcript can reference them. However, would need to find what downstream consumers use those model calls" (L330). Two advisors, Fable (`01a1848e-4e02`) and Astra (`01a1848e-4239`), agreed: separate immutable files plus small references, never load bodies on open, no silent omission in exports. Output: `/tmp/omp-model-call-storage-review.md`.
- #OBS Where it stopped: at the advisor summary (L637, "No code or sessions changed"). No branch, stash, worktree or plan doc carries it (`git branch -a`, `git stash list`, `git worktree list`). Reason it stopped: unknown; the transcript ends at the summary with no next step recorded.
- #OBS A separate mitigation exists: the agent-process memory guard on cc-workflows-plugin branch `feat/agent-process-memory-guard` (unmerged, runs from its worktree). It logs Paseo child processes and stops any above 8 GiB. It does not touch transcripts.

### 4. Transcript size on this machine (2026-10-29)

- #M 7,415 transcripts, 24.55 GB. Journal entries: 19.10 GB = 77.8% of bytes, but 71,765 lines = 5.3% of lines. 674 files contain them. By phase: request 12.97 GB, payload 5.98 GB, response 0.15 GB, error 0.002 GB. First journal entry 2026-10-25T20:08:22Z. Source: corpus scan, evidence section 3.
- #M Session size before the journal (first entry 2026-10-22 to 2026-10-25T20:08Z, n=649): median 251 KB, p90 1.64 MB, p99 11.0 MB, max 82.9 MB.
- #M Sessions with the journal (n=667): median 2.70 MB, p90 62.2 MB, p99 508 MB, max 1,268.6 MB. Without the journal bytes the same sessions have median 292 KB, close to the pre-journal median.
- #M Growth rate, sessions running at least 1 hour: before, n=114, median 0.32 MB/h, p90 1.97 MB/h, max 2.98 MB/h. After, n=94, median 11.4 MB/h (36x), p90 81.2 MB/h, max 532 MB/h.
- #M This analysis session measured itself: 108.6 MB after 21.8 minutes, 98.4% journal. The three 3-minute design subagents wrote 3.6 to 5.4 MB each, 88% to 94% journal. Source: evidence section 5.
- #M Largest: 1,268.6 MB `01a17914-f393` (browser-verification-resource-fix, 99.9% journal); 633.6 MB `01a17914-e15c`; 612.2 MB `01a182af` (hardy-crocodile, 98.2%, 684 requests over 25 h); 560.1 MB `01a1839a` (glossary-page-hardening); 545.3 MB `01a184a8` (hardy-crocodile).
- #M Why it grows so fast: each request record re-copies the whole conversation. In `01a182af` the median request record is 559 KB (max 1.37 MB), and journal bytes are 61.9 times the conversation's own message bytes. In `01a184a8`, 615 of 630 calls repeat the previous call's messages as a prefix (evidence section 2).
- #M Size bands: 50 sessions over 100 MB, 23 over 256 MB, 5 over 536,870,888 bytes (the largest string Node can hold); 0 in each band before the journal. Evidence section 3.

### 5. Memory

- #OBS An open session keeps every journal entry in memory for the life of the process. `appendCustomEntry` (`session-manager.ts:3340-3344`) calls `#recordEntry`, which pushes to `this.#entries` (`:1912`) and appends to the file. Resume reads every line into the same array (`session-loader.ts:303-313`).
- #M Replay through the real `SessionManager.open` (evidence section 1). The 545 MB session: open 2,071 ms, heap 1,392 MB, RSS 1,429 MB, peak footprint 1.56 GB. Same file with journal bodies cut to a small stub (10.6 MB): 46 ms, heap 58 MB, RSS 224 MB, peak 179 MB. The 171 MB session: heap 476 MB vs 23 MB. Context building takes 2 to 4 ms either way.
- #M Live at 10:46Z: 18 omp processes held 9.52 GB RSS together; swap 9.14 of 10.24 GB used; 5 processes at 1.0 to 1.5 GB RSS had 168 to 439 MB transcripts (`ps`, `sysctl vm.swapusage`). How much of each live process's memory is journal bodies: unknown; not measured in a running process.

### 6. Crash and failure evidence

- #OBS Paseo lost a message because of transcript size. 2026-10-29T09:47:49Z, agent `f6c35432` (session `01a184a8`, 545 MB): "Failed to hydrate provider history" then "Agent message batch dispatch failed", both `RangeError: Invalid string length` in `readActiveOmpEntryChain` (`~/.paseo/20261029-0304-01-daemon.log:8905-8906`). The user-reported 560 MB `01a1839a` failure (session `01a18474-86a2` L215) matches; its daemon log has rotated away.
- #OBS Kernel panic 2026-10-28 14:37:12 -0700, compressor pool exhausted. Top processes: bun 14.84 GiB, Python 42.06 GiB. Source: `/Library/Logs/DiagnosticReports/panic-full-2026-10-28-143712.0002.panic`, summarized in the memory-guard baseline doc. #A This panic is not tied to the journal; risk if wrong: the fix is under-rated.
- #OBS The memory guard stopped two omp agents on 2026-10-29: pid 39690 at 9.44 GB (10:37:19Z) and pid 24835 at 8.75 GB (10:38:11Z, session `01a1848c`, 329 MB transcript). Both sat flat near 1.2 GB for hours, then rose to over 8 GiB in 7 to 13 seconds after a grep tool result. Source: `~/.omp/logs/agent-process-guard.jsonl`, `omp.2026-10-29.24835.log` ("Session exit recorded reason sigterm pendingToolCalls 2").
- #H These spikes are not explained by the journal. The journal adds about 0.5 to 1.4 MB per call and is retained steadily; a 7 GB jump in seconds does not fit that. Falsify by: reproduce the spike with the journal off; if it no longer happens, the journal is implicated. Not run.
- #OBS Bun crash reports (SIGTRAP, SIGQUIT) exist before and after 2026-10-25; jetsam events on 2026-10-22 to 10-25 killed only daemons. Not attributable.

### Causal chain status

| Link | Status | Evidence |
|---|---|---|
| Model calls are written to transcripts | #OBS confirmed | `model-call-journal.ts:113,120-142`; 19.10 GB on disk |
| That makes transcripts much larger | #M confirmed | median 251 KB to 2.70 MB; 11.4 vs 0.32 MB/h |
| Larger transcripts make omp processes hold more memory | #M confirmed on open; #OBS by code for live append | 1,392 vs 58 MB heap; `session-manager.ts:1912` |
| Larger transcripts break Paseo history and messages | #OBS confirmed | `daemon.log:8905-8906` |
| That memory causes the crashes and 8 GiB kills | #H not shown | spikes are sudden, not gradual; panic top was a 42 GiB Python |

## Ideal

Laddered down from Wesley's job, Baseline and Ideal side by side. Each rung below the job is an #H bridge to the rung above.

| Rung | Baseline | Ideal (-er) |
|---|---|---|
| #JTBD | Wesley runs long agent sessions to get work done without watching the machine. | *(stable)* |
| Business #O | Work gets interrupted: the machine slows, agents get stopped at 8 GiB, one Paseo message was lost. | Fewer interrupted or lost agent sessions. |
| Product/User #O | Sessions get heavier the longer they run; five are too big for Paseo to open; reopening a large one takes over 1.4 GB. `/export` can show every call. | Long sessions stay lighter as they run and reopen faster in omp and Paseo, and `/export` still shows every call. |
| #M (Z) | (a) Heap after reopening the 545 MB session: 1,392 MB. (b) Long-session growth: 11.4 MB/h median. (c) Sessions over 536,870,888 bytes: 5 in 4 days. (d) Calls `/export` can show fully: 630 of 630 in that session. | (a) Lower: at most 116 MB (2x the 58 MB floor with bodies removed). (b) Lower: back near the 0.32 MB/h pre-journal median. (c) Fewer: 0 new. (d) Same: 630 of 630. |

- Rung bridge Product to Business, #H: lighter sessions mean fewer slowdowns and lost messages. Falsify by: after the fix, count Paseo `Invalid string length` errors and guard kills over a week; if they do not fall, the bridge is wrong. Risk if wrong: the fix ships and the interruptions continue, because their main cause (the unexplained spikes) is elsewhere.
- Rung bridge Metric to Product, #H: heap on reopen and bytes per hour stand for "lighter sessions". Falsify by: compare live RSS of long sessions before and after; if live RSS does not drop with the transcript, the metric leaked. Risk if wrong: we shrink files but not running processes.
- Read-back: moving (a) to (c) visibly moves "sessions reopen faster and Paseo can open them". It only partly moves "fewer interruptions": the 8 GiB spikes and the kernel panic are not shown to depend on the journal. That part of the ladder leaks and is stated, not hidden.
- Bar note: the 116 MB bar in (a) was written after the delta-encoding replay below was seen; that option's score against it is post hoc.

## Delta

### Problem frame (codebase-design)

Designed with `/Users/wesleyfrederick/Documents/ObsidianVault/0_SoftwareDevelopment/cc-workflows-plugin/.agents/skills/codebase-design/SKILL.md` (module, interface, seam, depth, locality) and its `DESIGN-IT-TWICE.md` (three subagents, each with a different design constraint; brief at [00-brief.md](../design/design-it-twice/00-brief.md)).

- #C Model inputs must not change.
- #C The `/export` audit must keep showing what each call sent (Baseline section 2).
- #C Copy, fork, branch and late writes after a session switch must keep audit records with the right session (`model-call-journal.ts:77-107`).
- #C Sharing must not leak audit bodies (`share.ts:317-318`).
- #C Do not migrate active transcripts or delete logs without Wesley's approval.
- The seam already exists: `createModelCallJournalStream` wraps every `StreamFn` (`sdk.ts:4194,4532-4533`). All designs keep that seam; they differ in where the bodies go and who rebuilds them.

### Options

Measured on the same replay: the 545 MB session `01a184a8`, 630 calls, opened through the real `SessionManager` (evidence sections 1-2). Values marked * come from the bodies-removed stand-in, not from a built writer.

| | D0 Revert | D1 Separate file + pointer | D2 Changes only, in transcript | D3 Off by default | D4 Rebuild from transcript |
|---|---|---|---|---|---|
| What it does | Remove the journal and the uncommitted viewer | Full records go to a per-session folder; transcript keeps a small pointer per phase | Each record stores only messages added since the previous call, plus one copy of each system prompt/tool set | Record nothing unless turned on; when on, works like D1 | Store only what the transcript does not already hold; `/export` rebuilds and hash-checks each call |
| Transcript bytes | 10.6 MB* | 10.6 MB* plus pointer fields (unmeasured) | 41.8 MB | 10.6 MB* off; as D1 on | O(1) per call; unmeasured |
| Heap after reopen (Z a) | 58 MB* | 58 MB* | 116 MB | 58 MB* | unmeasured |
| Open time | 46 ms* | 46 ms* | 144 ms | 46 ms* | unmeasured |
| Extra disk outside transcript | 0 | 535.2 MB (186.6 MB with zlib) | 0 | 0 off; as D1 on | small; unmeasured |
| Calls `/export` can show (Z d) | 0 of 630 | 630 of 630 | 630 of 630 if every earlier record in the chain is kept | 0 of 630 off; 630 on | 630 of 630 when hashes match |
| New ways a model call can fail | none | none if capture errors are only logged | none if capture errors are only logged | none | none if capture errors are only logged |
| Where change lands (locality) | one commit | journal module + copy/fork paths + export | journal module + export rebuild; branch-only forks can drop chain links | as D1 + a setting | journal + every provider transport + persistence |
| Sketch | | [01](../design/design-it-twice/01-sidecar-three-operations.md) | this doc, evidence section 2 | [03](../design/design-it-twice/03-opt-in-capture.md) | [02](../design/design-it-twice/02-derived-ledger.md) |

Not an option but needed with any of them: the 674 existing heavy transcripts keep their cost until a separate, approved offline conversion; and Paseo's whole-file reader is a Paseo bug that only smaller files avoid.

### Delta hypotheses

**D0 Revert.** #H If we revert `e7ed7a2f32` and drop the uncommitted viewer, then sessions stop writing call copies, which we expect to move heap on reopen to about 58 MB and growth back near 0.32 MB/h, at the cost of the audit (0 of 630 calls).
- Falsify first: replay shows the stand-in at 58 MB heap and 10.6 MB (done). Refuted if a fresh 30-minute session after revert still grows faster than 2 MB/h.
- Risk if wrong: low on memory; the loss is the audit Wesley added on 2026-10-26.

**D1 Separate file plus pointer (recommended).** #H If the journal writes each phase to its own file in a per-session folder and appends only a small pointer entry, then transcripts and the in-memory entry list stop carrying bodies, which we expect to move heap on reopen from 1,392 MB to at most 116 MB and Paseo-unreadable sessions from 5 to 0, while `/export` still shows 630 of 630 calls.
- Falsify first: build it, replay the 545 MB session's calls through the new writer, open with the same script. Refuted if the transcript exceeds 21.2 MB (2x the 10.6 MB stand-in), heap exceeds 116 MB, or `/export` shows fewer than 630 calls with request, payload and response.
- Risk if wrong: copy, fork and branch paths must carry the files; a missed path loses audit records for that copy. Disk use does not fall (19.10 GB in about 4 days; 847 GB free), so the folder grows without a limit until compression or the D2 trick is added behind the same seam.

**D2 Changes only, in the transcript.** #H If each request and payload record stores only the messages added since the previous call plus a pointer to one shared copy of the system prompt and tools, then transcripts shrink without new files, which we expect to move the 545 MB session to about 42 MB and heap to about 116 MB.
- Falsify first: replay done: 41.8 MB, 116 MB heap, 144 ms (evidence section 1). Refuted for the audit if rebuilding any of the 630 calls from its chain fails to match the original byte for byte; that rebuild was not built or run.
- Risk if wrong: each record depends on earlier ones, so a branch-only fork or a lost line breaks every later call's audit; long sessions still grow about 4 times faster than without the journal (41.8 vs 10.6 MB here).

**D3 Off by default.** #H If recording runs only when Wesley turns it on, then normal sessions write and hold nothing extra, which we expect to move heap and growth to the D0 level for every session he does not audit.
- Falsify first: same replay as D0 for the off case. Refuted if most sessions Wesley wants to audit were not turned on beforehand; that count is unknown.
- Risk if wrong: a call he later wants to inspect was never recorded and cannot be recovered.

**D4 Rebuild from transcript.** #H If the journal stores only bytes the transcript lacks and `/export` rebuilds each call with a hash check, then audit storage stays near the conversation's own size, which we expect to move total disk as well as transcript and heap.
- Falsify first: not simulated. The sketch names many places where what was sent differs from what is stored (hooks, compaction, image handling, provider rewrites after the payload hook), each needing its own capture.
- Risk if wrong: large build cost in every provider transport for a storage saving D1 plus later compression may get more cheaply.

### Recommendation

D1. It is the only option that keeps all 630 calls viewable and reaches the measured floor for transcript size and reopen memory. It is also what Wesley proposed on 2026-10-29 and what both advisors backed. The seam stays where it is: one module owns where bodies live, and only the copy and fork paths plus the export viewer learn about it. Take one rule from D3 and the sketches: a journal write failure is logged and never fails the model call. Keep D2's measured 16.9x shrink (this session's records: 535.2 MB to 31.7 MB) as the next step inside the same folder if disk becomes a problem.

### Standard Z for these runs

These runs were replays and simulations, not agent runs, so pass/fail is not applicable (nothing was classified).

| Run | Wall time | Cost USD | Tokens (in / out / cache read / cache write) |
|---|---|---|---|
| Open replays, 5 files | 46 to 2,071 ms each | 0 (local) | 0 |
| Delta simulation | 19.2 s | 0 (local) | 0 |
| Design subagents, 3 | 2m13s to 2m55s each | 0.597 total | 177,474 / 12,097 / 1,209,472 / 0 |
| This analysis session, to 10:59Z | 21.8 min | 7.39 | 272 / 78,819 / 14,677,203 / 359,108 |

Per-role subagent figures: evidence section 5. Source: harness usage records in each session file.

## Next

Wesley picks a delta. Nothing is built before that. After a pick: a spec and tests for the chosen option, then the D1 replay as its first proof, then a separate decision on converting the 674 existing heavy transcripts.
