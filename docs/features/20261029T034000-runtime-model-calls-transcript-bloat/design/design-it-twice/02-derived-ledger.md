# Design 2 — Transcript-backed derivation ledger

## 1. Interface: an exact derivation, not another conversation archive
**Proposal:** the module records a persistent expression DAG describing each actual captured value using transcript references, earlier DAG references, and only genuinely new literals. `/export` evaluates the DAG; it never reruns hooks or today's context builder.
Baseline: full request snapshots and post-hook payloads repeat history (`session/model-call-journal.ts:48-55,119-142`). Ideal: zero duplicate conversation bodies, with explicit proof of reconstruction. Delta hypothesis: persist provenance plus irreducible changes instead of snapshots; falsify with captured-versus-reconstructed mismatches or repeated unchanged message bytes in storage.
Paths below are relative to `packages/coding-agent/src/` unless marked otherwise. This is a design proposal, not implemented or runtime-verified.

```ts
type AuditOwner = { sessionId: string; ledgerId: string; leafId: string | null };
type CallId = string;
type ValueId = string;
type AuditStage = "context" | "postHook" | "sentBody" | "response" | "error";
type AuditStatus = "complete" | "incomplete" | "corrupt" | "unsupported";
interface DerivedCallJournal {
  wrap(owner: () => AuditOwner, source: TranscriptSource, stream: StreamFn): StreamFn;
  calls(owner: AuditOwner): AsyncIterable<CallSummary>;
  reconstruct(call: CallId, stage: AuditStage, attempt?: number): Promise<AuditValue>;
}
interface AuditValue { status: AuditStatus; value?: JsonValue; expectedHash?: string; reason?: string; }
interface TranscriptSource {
  persisted(entryId: string): Promise<PersistedEntryView>;
  revisions(owner: AuditOwner): AsyncIterable<PersistedEntryView>;
}
```
`CallSummary`, `PersistedEntryView` and `JsonValue` are concrete named types; views carry entry identity, persisted revision hash and blob resolvers. This source adapter reads the exact persisted projection, not merely the live `message` object.
Internal expression vocabulary: `entry(entryId, revisionHash, JSON-pointer)`, `blob(contentHash)`, `slice(value,start,end)`, ordered `array/record`, `concat`, fixed versioned `encode`, and `literal`. Content-address each expression; reuse maximal subtrees/string spans and compress ordered unchanged ranges. No executable callbacks in saved recipes.
A literal may contain only unmatched material after consulting the transcript/blob dictionary and prior expressions. New system prompts and tool schemas are content-addressed once per change, but use transcript references wherever those values already exist. Content hashes verify equality; compare candidate bytes before deduplication.
Capture all ordinary JSON-visible request fields, including inactive tools, in original array order with absent/null distinguished; keep record insertion order for display/serialization when relevant. Tool projection retains the existing schema whitelist, never runners/back-references (`model-call-journal.ts:29-54`).
Owner is frozen at dispatch. Records carry call ID, attempt sequence, stage, model identity, capture hash, expression root, and completeness. Provider retries can produce multiple post-hook/sent-body roots; no last-write-wins payload.
Ordering: open call → capture final app context before provider invocation → capture each post-hook value → capture actual serialized body/frame at dispatch → terminal event → finalize. Capture immutable evidence before passing mutable objects onward; never mutate model input or invoke a hook twice.
Audit failures are caught and reported through logger plus export status, never substituted into provider results. A crash can leave an incomplete call. A missing start record must be reported as an audit coverage gap, not silently interpreted as no calls.
This cannot simultaneously guarantee durable evidence under disk failure and never fail a model call: fail-open capture preserves model behavior and explicitly marks the evidence gap. No complete/exact badge without all required stages and verified roots.

## 2. Usage example
```ts
const stream = journal.wrap(() => sessionAuditOwner(sm), transcriptSource, streamSimple);
// Existing SDK main, advisor, compaction and side-request callers keep using stream.
// Provider adapters additionally capture the immutable final serialized body/frame
// through the call-scoped capture handle propagated in stream options.
for await (const call of journal.calls(exportOwner)) {
  const context = await journal.reconstruct(call.id, "context");
  const payloads = await reconstructAttempts(journal, call);
  exportWriter.writeCall(call, context, payloads);
}
```
Export resolves evidence in its host process and supplies the existing renderer's context/payload/message shapes as export-only rows. Browser HTML receives no filesystem resolver or executable recipe. Keep app context, post-hook payload, and actual sent body separately labeled; show response/error and gaps. The live renderer suppresses request rows when payload exists (`.../oh-my-pi/packages/coding-agent/src/export/html/template.js:357-384`); change that presentation so evidence stages remain accessible.
Sharing takes a separate path: do not resolve audit roots, embed recipes, copy sidecars, or attach literals. Existing share custom-entry stripping is at `export/share.ts:317-318`; extend exclusion before hydration.

## 3. Depth: implementation hidden behind the seam
The module hides transcript indexing, structural/string diffing, persistent sequence sharing, blob deduplication, expression evaluation, integrity verification, append recovery, ownership, and export hydration. Callers learn capture/read, not compaction policy or provider encodings.
Do **not** implement reconstruction as `buildSessionContext(savedLeaf)` followed by current `convertToLlm`: those functions are useful provenance producers at capture, not trustworthy historical replay engines. Save their observed selections and actual value differences as a data-only recipe.
Precise divergence points and detection:
- **Persistence is not identity.** `appendMessage` records a message entry (`session-manager.ts:3165-3176`), but persistence truncates oversized strings, strips `jsonlEvents`, and externalizes image URLs (`session-persistence.ts:171-220`). Diff against that persisted representation; save only missing suffixes/fields and blob references. Verify the entry revision hash during export.
- **Branch/compaction/clear differ from display.** Context follows parent links, filters retry/empty errors and some custom rows, materializes branch summaries, chooses the latest compaction/reset, and may replay native remote history rather than visible kept messages (`session-context.ts:264-273,380-402,446-605`). Record selected entry/range expressions plus synthetic wrappers/native-history references. Never infer the call's history from the export's current leaf. Capture context hash catches any omitted selection or wrapper.
- **Conversion changes shape.** File mentions split developer/user roles; custom/hook messages convert; interrupted thinking is removed based on the next message; tool names canonicalize (`messages.ts:1034-1130,1203-1208`). Persist observed shape edits and constants, not a promise to rerun `convertToLlm` after upgrades. Hash the final captured context, not an intermediate conversion.
- **Hooks and settings are live.** Extension context hooks, steering wrappers, refusal filters and secret obfuscation run before capture (`sdk.ts:4063-4088`). Diff actual outputs against persisted sources; never replay a hook, consult current settings, or require old secret mappings. Unique transformed bytes are irreducible evidence, not duplicated plaintext history.
- **More transforms follow conversion.** Provider normalization, append-only context, intent/tool-description changes, provider-context transforms, in-band tool dialects and inactive tools alter the context (`packages/agent/src/agent-loop.ts:1871-1924`). Capture at the final journal StreamFn seam and derive the recipe from that actual context; upstream provenance is an optimization, never proof.
- **Images are not paths.** SDK can block images, rasterize snapcompact text, clamp/drop images, transcode, decorate broker URLs, and inject date/cwd (`sdk.ts:4063-4074,4126-4143`). Reference immutable persisted image bytes when identical; save changed bytes once and actual URL string separately. Capture broker-served bytes and their hash at serving time, including lazy frames. Never re-read a mutable source path or re-rasterize during export. Missing/unobserved remote fetched content is explicitly unknown; exact sent URL does not prove what the provider fetched.
- **Post-hook is not necessarily sent.** Existing journal captures immediately after `onPayload` (`model-call-journal.ts:126-129`); Anthropic subsequently strips compaction parameters, fits Bedrock and repairs Unicode (`packages/ai/src/providers/anthropic.ts:2276-2283`). Responses can change reasoning effort on retry (`packages/ai/src/providers/openai-responses.ts:660-672`); Codex builds chained/steered websocket requests (`packages/ai/src/providers/openai-codex-responses.ts:1814-1908`). Observe final serialized body/frame in each transport adapter and store differences from the captured post-hook value. Compare serialized-byte hash at dispatch and reconstruction. An uninstrumented transport is unsupported, not exact.
- **Responses are not always transcript messages.** Persistence skips some empty/refusal turns (`agent-session.ts:3303-3333`), and side calls may never become conversation entries. Link ordinary terminal responses to their persisted entry plus raw-to-persisted delta; store side/absent responses once as unique evidence. Preserve thrown errors and partial/aborted terminals independently.
A capture-time evaluator reconstructs every root and compares it to the observed value before marking it complete; export repeats hash checks without trusting current converters. Body evidence excludes keys/headers like today's journal; it proves dispatched content, not provider receipt or server-side interpretation.

## 4. Dependency strategy and adapters
Put the external seam at the existing journal wrapper, with two necessary internal seams: persisted-entry provenance and final transport capture. This is not achievable by changing `model-call-journal.ts` alone.
Use the existing SessionManager/blob facilities through a local-disk adapter. An in-process adapter supports embedded/in-memory sessions with explicitly ephemeral durability, exercising the same expression evaluator. No database/network requirement.
Disk layout: per-session append-only call index plus content-addressed expression/literal objects outside session JSONL. Session header carries one small ledger identity; no per-call custom entry is required. Resume opens no audit objects or indexes; `/export` opens them lazily.
Index the stable persisted message projection when persistence runs. Bind entry IDs to provenance there; raw response capture and persistence finalize together so ordinary response text is not written twice into the durable ledger. Temporary pending evidence is reconciled before a complete commit; crash recovery must finish reconciliation before claiming completeness.
Session mutation is a real dependency: rewriting/deleting referenced message bytes must first preserve the old, now-nonderivable revision in the evidence store, then atomically switch the transcript revision. Otherwise old audits become corrupt. Immutable references cannot point at merely mutable in-memory entries.
Copy/fork/persistCopy computes the selected calls' dependency closure and carries required transcript revisions, expressions and blobs into the destination; remap entry IDs where necessary and verify roots. Branch selection is recorded explicitly. Copy committed evidence at a generation watermark; freeze the old owner for still-running calls, as current late-write code does, without reopening its transcript into heap. Never copy a dangling reference and call it complete.
Process-lifetime ownership handles bind to ledger identity rather than mutable session filename; session moves update storage location centrally. Copy snapshots do not silently promise to acquire future late records; retain the original dispatch owner as authority.

## 5. Scaling and proof measurements
Let N be calls, L total conversation bytes, D total unique non-transcript bytes, and R total unique recipe/index bytes; include changed system/tools, transformed images, and unique responses in D.
Per-call **transcript** growth from auditing: O(1) amortized metadata only; no full request or payload. Total durable data: O(L + D + R), not an unconditional O(N+L) promise.
Normal append-only history shares persistent sequence prefixes: R grows with new selections/edits, typically O(N log N) expression metadata; a pathological hook that rewrites every byte can force D or R = O(NL). Exact auditing cannot make irreducible O(NL) output disappear.
Resume retained heap: O(L) for existing conversation/session behavior, plus O(1) audit metadata; no D/R loading. Export holds one reconstructed call plus bounded caches, not all audit bodies; a self-contained HTML export still necessarily contains its expanded display evidence unless its UI/data format also changes.
Capture still must observe/hash O(current request size) per call, and export must emit that size: storage deduplication does not eliminate processing work. Incremental provenance indexes reduce matching work without weakening final verification; bounded queues may declare a capture incomplete rather than retain unbounded request bodies.
Verify later by measuring transcript bytes/call as history grows, unique literal and recipe bytes, resume RSS/heap with audit present/absent, capture CPU/latency, and reconstructed hash equality across hooks, compaction/reset/rewind, images, retries, side calls, copy and switches. No builds/tests were run for this read-only design assignment.

## 6. Trade-offs, leverage and locality
High leverage: one derived ledger supports exact export without transcript bloat, with context changes represented once; data-only recipes survive converter upgrades. High depth and locality live in one evaluator/differ rather than many export-specific replay rules.
Thin leverage: provider transports must expose actual dispatched bodies; image brokers must expose served bytes; persistence/rewrite/copy paths must preserve provenance. These integrations are substantive and cannot be hidden by a tiny wrapper or hashes alone.
Cost: more capture CPU, a versioned expression interpreter, dependency-safe retention, and tighter persistence integration than a plain sidecar snapshot. No magic linear-space guarantee for arbitrary hooks. An implementation that saves full payloads as a fallback violates this design's constraint.
Existing v1 transcripts remain readable by a legacy import adapter that exposes their inline phases directly. Missing historic sent-body observations cannot be recovered and are labeled post-hook-only. Optional migration derives roots from existing captured values and matching transcript bytes, verifies reconstruction, then removes old bodies only after an atomic verified replacement; never silently rewrite existing sessions on resume.
Recommendation within this assigned design: use the ledger only if zero duplicated conversation content is a hard requirement; otherwise this depth may cost more than its storage leverage. Main unresolved hypothesis: generic derivation can remain cheap enough under long-history image/hook workloads; risk is capture overhead, falsified by dispatch-latency profiling against today's journal with identical inputs.
