# Design brief: model-call audit journal without session-transcript bloat

Read-only design work. Do NOT edit, create, or delete any repo file. Write your design only to the local:// file named in your task.

## Repo
- Worktree (committed code, read this): /Users/wesleyfrederick/.paseo/worktrees/2skzpnuo/helpful-parrot (oh-my-pi fork, package packages/coding-agent). Read AGENTS.md "Code Quality" section.
- Live checkout with uncommitted WIP (the only real reader): /Users/wesleyfrederick/Documents/ObsidianVault/0_SoftwareDevelopment/oh-my-pi/packages/coding-agent/src/export/html/template.js lines ~41, 357-396, 639, 1055, 1435 (renders "Text sent to LLM" from omp:model-call entries in /export).

## What exists (verified)
- `packages/coding-agent/src/session/model-call-journal.ts`: `createModelCallJournalStream(sm, stream)` wraps every StreamFn. Per model call it appends custom entries `customType: "omp:model-call"` with data `{version:1, requestId, model, phase}` plus: phase `request` → full `context` (systemPrompt + all messages + tool schemas, JSON deep copy, :48-55,:120-122); phase `payload` → post-hook provider payload (:126-129); phase `response`/`error` → terminal AssistantMessage (:135-153). `sm.ensureOnDisk()` (:121) and the request record run BEFORE the provider call; a journal write failure fails the model call (:167-176). Late writes after a session switch go to the dispatching session's file via a cloned manager (:77-107).
- `packages/coding-agent/src/sdk.ts:4194` wraps the main agent stream; `sdk.ts:4532-4533` side/advisor streams use the same wrapped fn, so compaction, handoff, ephemeral side turns are journaled too.
- `packages/coding-agent/src/session/session-manager.ts`: `appendCustomEntry` (~:3340) → `#recordEntry` (~:1906-1923) pushes the entry to in-memory `#entries` (kept for process life) AND appends a JSONL line. `session-loader.ts:303-313` streams lines but collects every entry into an array on open/resume. Clone/fork/branch/persistCopy paths exist (search `cloneCurrentSession`, `fork`, `persistCopy` in session-manager.ts).
- `packages/coding-agent/src/export/share.ts` ~:317-318 strips custom-entry data before sharing.
- Test: `packages/coding-agent/test/model-call-journal.test.ts`.
- External whole-file readers: Paseo daemon reads the entire .jsonl into one string (`readActiveOmpEntryChain`, fails with RangeError Invalid string length above ~536,870,888 bytes); cc-workflows-plugin transcript-reader also whole-file reads.

## Measured (2026-10-29, this machine, ~/.omp/agent/sessions)
- omp:model-call = 77.8% of all transcript bytes (19.10 of 24.55 GB) but 5.3% of lines. Phase bytes: request 12.97 GB, payload 5.98 GB, response 0.15 GB, error 0.002 GB.
- One 612 MB session: request record median 559 KB, max 1.37 MB; model-call bytes = 61.9x the conversation message bytes. Growth is ~quadratic: each request re-copies the whole conversation.
- Opening a 545 MB transcript with SessionManager.open: RSS 1,425 MB, heap 1,202 MB. Same file with model-call bodies stripped (10.6 MB): RSS 224 MB, heap 51 MB. Model context build is unaffected (model-call entries are excluded from context).

## Need that must survive
Wesley's /export shows everything sent to the model per call (system prompt, messages, tools, post-hook payload, response/error) for auditing. Commit e7ed7a2f32 added the journal "so /export can show everything sent to the model".

## Constraints
- Model inputs must not change. Journal capture must not add a new way for a model call to fail if avoidable.
- Session open/resume and in-memory entry list must not grow with audit bodies.
- Copy/fork/branch and late writes after session switch must keep audit evidence attached to the right session.
- Sharing must not leak audit bodies.
- Follow AGENTS.md code rules (Bun APIs, #private, no inline imports, no any).

## Your output (markdown, <= 120 lines)
1. Interface: types/functions/params plus invariants, ordering, error modes.
2. Usage example: how the journal writer and the /export reader call it.
3. What the implementation hides behind the seam.
4. Dependency strategy and adapters (in-process, local disk, etc.).
5. Scaling: how per-call transcript bytes, total stored bytes, and retained heap on resume scale (O-notation in N calls / L conversation length). No numeric estimates; name the measurement that would verify.
6. Trade-offs: where leverage is high, where thin; what breaks for existing transcripts.
Use the vocabulary: module, interface, seam, adapter, depth, leverage, locality.
