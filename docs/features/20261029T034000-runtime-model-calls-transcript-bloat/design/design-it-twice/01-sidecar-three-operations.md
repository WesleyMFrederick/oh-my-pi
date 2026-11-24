# Design 1 — three operations, immutable phase sidecars

## 1. Interface
Proposed module: `model-call-journal`; its seam is capture / resolve / carry, not arbitrary blob CRUD.
Exactly three entry points; reuse `StreamFn`, `SessionEntry`, `SessionManager`, `SessionStorage`, and existing model-call body types.
```ts
type AuditLocation = { sessionFile: string; storage: SessionStorage };
type AuditOwner = { manager: SessionManager; storage: SessionStorage };
type AuditRef = {
  version: 2; requestId: string;
  model: { provider: string; id: string; api: string };
  phase: "request" | "payload" | "response" | "error";
  key: string; // module-generated immutable phase-object identity, not an arbitrary path
};
type AuditRead =
  | { entryId: string; state: "available"; body: ModelCallJournalData }
  | { entryId: string; state: "unavailable"; reason: "missing" | "invalid" | "io" };
type AuditCarry = { copied: number; unavailableEntryIds: string[] };
function capture(owner: AuditOwner, stream: StreamFn): StreamFn;
function resolve(location: AuditLocation, entries: Iterable<SessionEntry>): AsyncIterable<AuditRead>;
function carry(from: AuditLocation, to: AuditLocation, entries: Iterable<SessionEntry>): Promise<AuditCarry>;
```
`AuditOwner.storage` must be the manager's actual backing storage, supplied by its composition owner; never silently substitute disk storage.
Transcript custom entries remain `omp:model-call`, but contain only `AuditRef`; bodies never enter `appendCustomEntry` or `#entries`.
Each phase occurrence gets a unique key: repeated payload callbacks must not overwrite earlier payloads.
The identity and origin session file are captured at dispatch, before asynchronous work; late phase markers and bodies use that origin.
A request marker precedes invocation; request bytes are captured before the provider can mutate context.
Capture the caller hook's effective payload after awaiting it; return precisely its replacement, including `undefined`.
Preserve every original stream event, result, error, abort signal, and local-work forwarding behavior.
Serialize immediately into owned bytes; persist before releasing those bytes, then release all body references.
No unbounded background queue: phase persistence is awaited, so storage latency remains an explicit cost.
Capture serialization, storage, marker-append, and journal-close failures are logged and swallowed; never replace a provider outcome.
Original hook/provider exceptions still propagate. Missing evidence must be visible as unavailable, never reconstructed as authentic.
A reference is appended even when capture fails where possible; crashes can leave missing bodies or unused objects, not corrupted model inputs.
Do not force `ensureOnDisk()` merely to audit; use the already allocated persistent session path.
For managers without a session file, omit audit markers and report unavailable capture rather than fail the model call.

## 2. Usage example
```ts
// SDK composition owner supplies the same storage used to construct the manager.
const auditedStream = capture({ manager: sessionManager, storage }, streamSimple);
// Keep existing settings/concurrency wrappers and side/advisor use of this stream.

// Private /export only: separate export-owned data, never mutate manager entries.
for await (const result of resolve({ sessionFile, storage }, exportEntries)) {
  exportWriter.addAudit(result); // join by entryId; show unavailable evidence explicitly
}

// Existing session lifecycle code supplies exactly the inherited references.
const result = await carry(sourceLocation, destinationLocation, inheritedEntries);
// Publish the destination transcript after awaiting carry; surface missing evidence.
```
`exportWriter.addAudit` is illustrative caller code, not a fourth journal entry point.
HTML export joins resolved records into export-only custom-entry data, preserving request/payload grouping and all four phases.
It must expose both request context and effective payload, even if payload is the initially expanded disclosure.
Resolve main and embedded child sessions against their own locations; use entry IDs only within their respective export scopes.
Shared export never calls `resolve`; strip audit references before serialization and exclude any private audit map or files.

## 3. Hidden implementation
Store one immutable JSON object per phase at `<session-without-.jsonl>/model-calls/<key>.json`.
Use schema-validated module-generated keys; do not accept traversal, absolute paths, or arbitrary custom-entry file references.
Use `SessionStorage.writeTextAtomic` to publish complete objects; transcript references need no inline fallback.
Request serialization preserves the existing tool-schema projection, including inactive tools, without runtime back-references.
Transport credentials/headers remain excluded; payloads themselves remain sensitive private data.
Retain only compact metadata in SessionManager. Do not maintain a process-global hydrated-body cache.
Keep ordered per-call writes and existing terminal-event/result fallback inside capture.
Late writes can reuse a short-lived origin manager, but it contains only metadata, never body snapshots.
`carry` resolves only referenced objects and copies their immutable bytes; never scan/copy an entire audit directory blindly.
Identical locations are no-ops; repeated carry is idempotent; malformed/missing objects are reported individually.
Forks inherit the selected markers and the phase objects available at the fork snapshot; new calls belong to the new session.
A completion after the fork belongs to its dispatching session, not retroactively to the fork's snapshot.
`cloneCurrentSession` at the same location shares objects; nonpersistent clones retaining inherited references retain their origin lookup location.
`fork`, `forkFrom`, `persistCopy`, branch extraction, and cross-storage copies call carry before publishing inherited references.
Audit carry must run even when `forkFrom({ copyArtifacts: false })` skips ordinary artifacts.
Existing artifact relocation handles disk moves; update the audit origin mapping for active captures before removing the old location.
Session switches do not relocate: active captures retain their original location until terminal cleanup.
Deletion uses existing session-artifact deletion ownership; no global store, refcounts, or cross-session garbage collector.

## 4. Dependencies and adapters
Use the existing `SessionStorage` seam, not a new storage-interface family.
Local disk is the production adapter; `MemorySessionStorage` is the existing in-process adapter for contract checks.
Memory storage naturally retains its bytes; production resume claims apply to the disk adapter, not an intentionally memory-backed store.
SDK threads the owner's storage explicitly; SessionManager lifecycle code already owns both locations and backing adapters.
Reuse existing session artifact layout and movement/deletion utilities, but do not rely on their optional copy behavior for audit correctness.
Bun-backed storage, logger, Snowflake identities, and projected tool schemas remain internal dependencies.

## 5. Scaling and verification measurements
Let N be calls, L maximum serialized input/context length, and assume bounded phase count per call.
Transcript audit bytes: O(1) per call, O(N) total, independent of L; measure JSONL bytes attributable to audit references.
Audit storage: O(NL), still O(N²) when conversation length grows linearly with call count; measure sidecar bytes by phase.
Session resume retained heap: O(N + L) including references and conversation, not O(NL); measure settled heap/RSS after opening the same session.
Capture transient memory: O(L) per active call, not retained history; measure heap across repeated calls and concurrent captures.
`resolve` uses O(L) transient body memory if its caller consumes incrementally; fully embedded HTML may still retain O(NL) export data.
Verify export cost separately; moving bodies does not make a self-contained full-audit export small.
Read-only design assignment: these are proposed acceptance measurements, not executed results.

## 6. Trade-offs, depth, leverage, locality
High leverage: one capture entry point preserves every main/side/advisor path; one resolver serves private exports and migration reads.
Depth comes from hiding ownership, immutable snapshots, phase ordering, corruption handling, and selective copy behind three operations.
Locality improves because audit schema/storage knowledge stays in this module; SessionManager learns only where carry is required.
Thin spot: lifecycle integration remains necessary, and best-effort capture cannot promise evidence under disk failure or process death.
Full bodies still repeat whole contexts: this solves transcript/resume bloat, not total audit disk growth or serialization CPU.
Existing v1 transcripts remain readable: resolve recognizes inline bodies, while a deliberate streaming conversion moves them to objects.
Opening old v1 files without conversion still has their old memory cost; do not claim this interface retroactively fixes them.
Current WIP HTML expects inline data; its server-side export assembly must hydrate only export-owned records before adopting v2.
Existing tests that assert bodies in manager entries must move to resolve and additionally assert metadata-only persisted entries.
Acceptance scenarios: post-hook replacement, input mutation after capture, late completion after switch, fork/copy/delete-source, missing object, write failure, and shared-export exclusion.
