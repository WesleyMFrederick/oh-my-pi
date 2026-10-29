# Design 3 — Pay only when deliberately recording

## 1. Interface and default
**Default: capture off.** Most sessions never inspect a call audit; they should pay neither snapshot CPU nor audit storage/heap. Enable `audit.capture` before the interesting calls, globally through settings or temporarily with `/audit on`; `/audit off` stops admission of new calls. `/export audit` exports existing evidence, never silently enables capture or replays calls.
This deliberately gives up retrospective exact audits, not merely moves their cost elsewhere. A ring buffer would keep copying every request for the common caller and still lose older evidence; reject it.
The module is `ModelCallAudit`; its seam combines stream admission, private evidence storage and export iteration:
```ts
// Proposed types; existing StreamFn, SessionEntry and Settings types are reused.
type CaptureMode = "off" | "on";
type AuditSession = { id: string; file: string | undefined };
type AuditStatus = "complete" | "partial" | "missing" | "legacy";
interface AuditView {
  requestId: string;
  status: AuditStatus;
  records: readonly ModelCallJournalData[]; // existing phase shape
  problems: readonly string[];
}
interface ModelCallAudit {
  wrap(stream: StreamFn): StreamFn;
  read(session: AuditSession, entries: AsyncIterable<SessionEntry>): AsyncIterable<AuditView>;
  copy(source: AuditSession, target: AuditSession, retainedEntryIds: ReadonlySet<string>): Promise<void>;
}
function createModelCallAudit(deps: {
  currentSession: () => AuditSession;
  capture: () => boolean;
  storage: AuditStorage;
  notice: (text: string) => void;
}): ModelCallAudit;
```
`AuditStorage` is an internal adapter contract for phase write/read and snapshot-copy operations, not a general persistence abstraction callers learn. `ModelCallJournalData` above is the existing record shape, no longer an inline transcript payload.
Register `audit.capture` with `register({ id: "audit.capture", type: "boolean", default: false, ... })` beside the journal module; import it through `config/all-settings.ts`. `/audit on|off` uses the handle's runtime override on the session's Settings, not `.set()` (which persists globally). Reset that override on `/new` and session switches; persistent settings remain the initial policy. Show a recording indicator and the start-of-coverage notice.

**Invariants, ordering, failures**
- Off path is one cached setting read and `return stream(model, context, options)`; no IDs, wrapper event stream, snapshots, payload-hook replacement, session persistence, audit entries or directory checks.
- On admission, freeze session identity/file and mode for the entire call. Turning off or switching sessions never strands an admitted call; new calls sample the new policy. Include side/advisor/compaction calls at the same shared SDK seam.
- A runtime-only session cannot retain durable evidence: issue a notice and run unchanged without capture; never force a transcript onto disk just for auditing.
- Before invoking the provider, snapshot only serializable request context/tool schemas. Preserve all model inputs and the original payload hook's ordering, arguments, return and exceptions. Snapshot its effective replacement payload before forwarding it; snapshot terminal events before consumers can mutate them.
- Phase files are immutable and atomically published. Request precedes payload/terminal within one call; concurrent calls have independent IDs. Preserve multiple payload-hook invocations with phase sequence numbers.
- Audit serialization/I/O failures never reject or alter the model stream. Catch only audit operations, emit one recording-degraded notice and logger warning, and mark partial coverage. Original provider/hook exceptions still propagate unchanged.
- Enabled capture incurs snapshot and publication latency. Await each phase's attempted publication before forwarding its corresponding event; export need not race an unbounded asynchronous write queue. Process death can leave a partial call, never a falsely complete one.
- On admission append one small `omp:model-call-ref` entry with request ID, capture owner/session ID and relative evidence key; no bodies or filesystem-controlled absolute paths. If ref persistence fails, warn: orphan evidence is not advertised as complete.

## 2. Usage
```ts
const audit = createModelCallAudit({
  currentSession: () => ({ id: sm.getSessionId(), file: sm.getSessionFile() }),
  capture: () => cfgAuditCapture.get(settings), storage: localAuditStorage, notice,
});
const stream = audit.wrap(streamSimple); // replaces current journal wrapper in sdk.ts
// /audit on: cfgAuditCapture.override(settings, true)
// /export audit only, never share/ordinary export:
for await (const call of audit.read(sessionIdentity, iterateEntries())) {
  await auditHtml.writeCall(call); // renders available phases and coverage problems
}
// Session copy/fork/branch publication owner, after selecting retained history:
await audit.copy(sourceIdentity, targetIdentity, retainedEntryIds);
```
The local HTML export adapter supplies audit records separately from conversation entries. Update the live template's audit search/filter/render paths (including embedded sub-sessions); do not hydrate bodies into `SessionManager.getEntries()`. Retain all request context and effective provider payload disclosures rather than hiding the former when the latter exists. Ordinary export/share never calls `read`; share additionally drops audit-ref entries so no private evidence references escape.

## 3. Hidden implementation and ownership
Store a private sibling directory `<session-stem>.audit/`, separate from `ArtifactManager` (whose directory/ID space is adopted by subagents). Each request owns a directory with ordered phase files and a small completion/problem manifest. Lazily create it only for admitted capture. Use Bun I/O and the existing atomic-file publication helper; do not introduce a database, compression or content-addressed store.
A small coverage manifest records recording intervals and failures; it contains no bodies and is opened only for audit export. No directory means no new-format capture. Abrupt termination, missing terminal phases and unreadable files produce explicit partial/missing cards. Coverage-off notices make clear there is no complete call ledger for uncaptured periods; do not invent an exact missed-call count.
The frozen dispatch destination handles late writes directly; no cloned SessionManager and no transcript reload. Captured records retain their original owner even when referenced by copied history.
`copy` streams only evidence named by retained refs into the destination's private directory and publishes a cut-point snapshot; target refs resolve locally, not through the original session path. A pending source call is partial in the copy; later phases remain attached only to its dispatching session. Same-session branch navigation keeps the existing evidence; materialized branches use the retained-entry set. Copy failure leaves an explicit missing/partial view, never drops conversation history or borrows unrelated evidence. Move/rename must move the private directory with the transcript.
These rules must be wired into clone materialization, fork, persistCopy, branch extraction and move paths, not left to individual export callers. An in-memory clone preserving identity can share its immutable locator; a new persistent identity gets a snapshot copy.

## 4. Dependencies and adapters
Production local-disk adapter owns lazy directories, serialization, atomic writes, phase sequencing, manifests and copy snapshots. An in-memory adapter supports SDK embeddings and deterministic interface verification; ephemeral evidence is explicitly non-durable. Disabled capture bypasses both adapters entirely, rather than calling a no-op adapter after constructing snapshots.
The existing StreamFn is the invocation seam; existing settings handles provide policy. The export adapter is a second consumer of the module, not another storage reader. Legacy-inline reading is an adapter inside `read`, not a permanent dual writer. High depth comes from one seam hiding admission, ownership, evidence integrity and loss reporting; locality keeps those rules out of SDK and HTML callers.

## 5. Scaling and verification measurements
Let N be calls, L the largest conversation/request size, K the captured calls, and C total ordinary conversation bytes. Payload size is assumed O(L); include actual provider expansion when measuring.
- Default off: audit transcript bytes O(0) per call and total; audit disk and retained heap O(0). Ordinary session storage/heap remains O(C).
- Enabled: O(1) transcript bytes per captured call, O(K) total ref bytes; body disk O(KL), potentially quadratic when L grows with N. This design does not claim to solve intentional recording's duplication.
- Resume: O(C + K) retained heap, independent of audit-body bytes; no sidecar open or evidence hydration. Active captured calls need O(L) transient snapshot memory each, released per phase; no accumulating body queue.
- Audit export alone reads O(KL) bytes with O(L) server-side working memory; the self-contained HTML/browser may retain O(KL). Do not imply export itself becomes cheap.
- Verify with default-off call CPU/allocation and filesystem-write traces; transcript bytes per call; sidecar bytes versus K and L; resume peak/retained heap with fixed conversation and increasing audit bodies; explicit-export peak heap and output size. No measurements or runtime validation are claimed by this read-only design.

## 6. Losses, migration and trade-offs
When capture was off, a later audit cannot recover exact per-call system prompts, injected/request-only context, tool schema versions, effective post-hook payloads, side-call inputs or raw terminal provider errors/responses omitted from ordinary history. Conversation export remains available, clearly labeled as conversation history, not reconstructed evidence. Enabling now covers only future admitted calls; reproducing a call is a new call, not evidence of the old one.
Existing inline transcripts remain auditable via the legacy reader, but disabling future capture does not shrink them. To satisfy body-independent resume for old files, an explicit streaming conversion extracts inline phases into sidecars and replaces them with refs before normal open; publish verified sidecars before atomically replacing the transcript, retain original entry IDs/parent links, and abort replacement on any extraction failure. This conversion is a separate, user-visible storage migration, not a silent lossy loader filter. Without conversion, old files keep their current memory problem.
The committed journal tests' always-on inline-entry assertions must be replaced by consumer contracts: off does no audit work; opt-in captures mutable inputs/effective payloads; audit failures preserve provider results; toggles and late writes preserve ownership; copied branches remain readable without their source; sharing excludes evidence; migrated legacy audit stays equivalent.
Leverage is highest for ordinary callers: the expensive feature is absent rather than optimized. Leverage is thin for always-recording users: disk duplication and large HTML remain. The USER must opt in before the event, and this changes the current promise of unconditional retrospective audit. That deliberate capability loss is the price of a trivial default, not an implementation accident.
