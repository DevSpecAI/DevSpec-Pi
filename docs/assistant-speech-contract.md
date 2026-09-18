# Foreground speech: isolated Pi primitives

Work item: d729bc38-44e8-430f-a3c3-bea257906128.

**Not activated.** The production controller/hooks and semantic speech classifiers
are unchanged. These primitives do not establish terminal/room parity. Publication
and full-feature approval remain blocked on the server contract and integration.

## Capture and ordering

The future production path must call `beginAssistantSpeechSource` **before
asynchronous provider work**, binding the model invocation's consumed input and
source authority. It must carry that token through assistant start/stream/end;
newly queued owner input or a changed current bond must never relabel old output.
The UUID is available immediately for diagnostic correlation, without guessing a
Pi leaf/entry ID. Hook placement is not implemented or proven by these primitives.

`source.finalize(message)` captures only assistant text blocks in array order,
without trimming or changing accepted formatting/Unicode. Non-assistant events
return null without sealing the token. The first assistant finalization seals the
exact raw text, including empty/default-ignorable-only text (which yields no
bubble). The same raw text returns the same frozen record/null; any different raw
text thereafter throws a content-free conflict error, even if only whitespace
changed. A later model response after an abort needs a **new** begin token.
Thinking, tool results and custom/system messages do not become speech.

Independent identical messages receive distinct IDs. Explicit retry reuses the
original token/record. There is no automatic replay, durable restart association,
or persistence in this slice. `captureAssistantSpeech` remains only a one-shot
convenience for already-stable inputs/tests: it cannot reconstruct pre-provider
authority by reading current state at message_end and must not be the future
production hook path.

The copied/frozen source retains raw text, expected source room, connection,
protected server UUID epoch, full-precision attachment stamp, local pump
generation, nonsecret command/interaction correlation IDs and model. Missing
scope becomes `unsupported/missing_scope`; a malformed UUID epoch becomes
`unsupported/invalid_scope`. Existing notice/unknown-origin reasons stay
unsupported. No missing field is inferred or upgraded from current state.

The serializable token/record excludes connection capabilities, access tokens and
interaction claim tokens, even if passed in structurally wider input objects.
The future caller must separately preserve exact ephemeral transport authority in
its private closure (including original interaction claim token), without
journaling/logging it or rereading replacement credentials. Correlation IDs alone
are **not** transport authorization. No new credential store or change to existing
exact-input private journal semantics is provided. Local pump generation is only
a stale-callback check, not a server-side attachment fence.

`ProjectionPostQueue` accepts thunks, not started requests. The future controller
must enqueue both speech and competing trail-pointer writes through one instance,
and check captured authority before transport. Failure is propagated without
replay, and later sources can proceed. `drain` includes writes enqueued while it
waits. The queue itself neither stores a durable outbox nor supplies authorization.

## Intended source-aware ABI (not deployed by this slice)

Ordinary speech request additions agreed at checkpoint:

- `assistant_source_id`: captured source UUID.
- `expected_session_id`: captured source-room UUID, a checked precondition through
  the locked write, **not** a routing override.
- `expected_runtime_generation`: the protected capability row's opaque UUID
  authority epoch, validated as UUID-shaped and preserved verbatim. It rotates on
  attachment transitions **and** credential changes. It is not a counter,
  timestamp or local pump generation. A frozen secret alone cannot pin old scope.
- `expected_attached_at`: original server attachment timestamp string with full
  precision, never rounded through JavaScript `Date`.
- Existing `phase: "answer"`, `turn_kind: "agent"`, `complete_turn: false`.
- Existing exact command/interaction fences must remain intact.

Reuse existing request-key storage/index, deriving identity from immutable
connection + expected source room + source UUID, never text or mutable execution.
Same-key readback must verify the original source binding and raw content; any
mismatch must fail explicitly. The late-answer helper must not collapse distinct
sources by trimmed equal content.

### Exact opt-in Pi receipt expectation

When `parsePostSessionReceipt` receives an `assistantSourceId` expectation, a
successful unwrapped response must have this shape (shown with example values):

```json
{
  "connection_id": "captured-connection-uuid",
  "session_id": "captured-source-room-uuid",
  "phase": "answer",
  "turn_kind": "agent",
  "assistant_source_id": "captured-assistant-source-uuid",
  "message_id": "persisted-message-uuid",
  "delivery": {
    "status": "stored",
    "message_id": "persisted-message-uuid"
  }
}
```

`delivery.status` may also be `idempotently_stored`. Both row IDs must match;
connection, session, phase, requested kind and **top-level** assistant_source_id
must match their expectations. Typed `delivery` is mandatory in source-aware
mode. Missing/wrong echoes or row IDs are `malformed`; explicit errors are
`rejected`; noop/skipped results never confirm storage. Transport success alone
is insufficient. The parser supports existing MCP text-JSON and structured
wrappers. Without an assistantSourceId expectation, legacy behavior is unchanged.
No production caller opts in yet.

## Future source-aware atomic budget (not deployed)

`preflightAssistantSpeech(text)` tests the parent-approved future maximum of
**100,000 Unicode code points AND 512,000 UTF-8 bytes of JSON-encoded text**.
The byte measurement is `Buffer.byteLength(JSON.stringify(text), "utf8")`,
including enclosing quotes and JSON escapes; combining code points count
separately, and astral characters count once rather than as UTF-16 pairs.

Results contain only `within_budget`/`over_budget` plus both measurements.
Neither result means sent/stored, grants publishing authority, or mutates/truncates
the complete captured source. A rejection leaves the full frozen record available.
No chunk assembly or partial-source acknowledgement is supported.

These approved **future source-aware** maxima do not activate a higher bound in
current transport or change legacy callers. The existing **2,500,000-byte whole
SQL JSONB-input ceiling** remains separately server-enforced; this utility does
not measure that envelope, the final merged row or serialized Broadcast payload.
Actual MCP HTTP, complete Broadcast payload/configuration, desktop/mobile
rendering and readback at boundaries still require qualification. The reported
Pro Broadcast service allowance is not verification of the actual configuration,
and a storage receipt is never evidence of Broadcast/browser delivery.

## Cutover dependencies and remaining verification

- Parent-confirmed server implementation/deployment of this ABI, including locked
  expected-room checks, source/content conflicts, late-helper source deduplication
  and source-aware typed receipts.
- Existing runtime writer's protected epoch/scope metadata availability and frozen
  transport authority verification: compare expected epoch to authenticated current
  generation and recheck expected room/stamp/epoch under write-time locks. Do not
  replace an old callback's epoch or invent a parallel epoch/availability flag.
- Server support and actual envelope/transport/Broadcast qualification of the
  future atomic budget above; preflight alone does not establish deliverability.
- Controller hook wiring, semantic classifier removal, source retention with
  explicit non-delivery results, complete speech/trail serialization, safe
  unsupported-origin handling, and production-controller integration tests.
- Server/browser tests for independent identical sources, retry/conflict paths,
  envelope rejection without losing unsent text, stale reattach, ordering and
  immutable long-message rendering. These are not proven by primitive tests.

Execution settlement/admission, background Working, default Stop/preempt and
continuous-run follow-up execution identity are outside this isolated slice.
