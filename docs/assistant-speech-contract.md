# Foreground speech: isolated Pi primitives

Work item: d729bc38-44e8-430f-a3c3-bea257906128.

**Not activated.** The production controller/hooks and semantic speech classifiers
are unchanged. These primitives do not establish terminal/room parity. Publication
and full-feature approval remain blocked on the server contract and integration.

## Capture and ordering

`captureAssistantSpeech` captures only assistant text blocks, in array order,
without trimming or changing accepted formatting/Unicode. Invisible-only text
produces no record. Thinking, tool results and custom/system messages do not
become speech. Error/abort/length stops do not discard authored text.

Each invocation creates an extension-owned UUID, not a Pi entry id. Capture must
happen synchronously at finalized `message_end`, before awaits or segment swaps.
The current leaf is not this assistant's persisted entry: host append follows the
hook. Independent identical messages receive distinct IDs. An explicit retry must
reuse the original immutable record. There is no automatic replay or durable
restart association in this slice.

The copied/frozen record retains raw text, expected source room, connection,
capability, local pump generation, exact command/interaction source and model.
Unsupported notice/unknown-origin sources remain captured with an explicit reason;
they receive no local-turn or publishing authority. The controller remains
responsible for supplying trustworthy source authority. Local pump generation is
only a stale-callback check, not a server-side attachment fence.

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

## Cutover dependencies and remaining verification

- Parent-confirmed server implementation/deployment of this ABI, including locked
  expected-room checks, source/content conflicts, late-helper source deduplication
  and source-aware typed receipts.
- Existing runtime writer's attachment-generation metadata and frozen-capability
  verification with write-time lock recheck; do not invent a parallel epoch.
- A reviewed larger atomic content bound plus actual UTF-8/JSON envelope and
  transport/Broadcast behavior. **No numerical replacement bound is approved.**
  Capture retains full >12000-character sources, but does not claim they can be
  sent. No truncation/chunk assembly or partial-source acknowledgement is provided.
- Controller hook wiring, semantic classifier removal, source retention with
  explicit non-delivery results, complete speech/trail serialization, safe
  unsupported-origin handling, and production-controller integration tests.
- Server/browser tests for independent identical sources, retry/conflict paths,
  envelope rejection without losing unsent text, stale reattach, ordering and
  immutable long-message rendering. These are not proven by primitive tests.

Execution settlement/admission, background Working, default Stop/preempt and
continuous-run follow-up execution identity are outside this isolated slice.
