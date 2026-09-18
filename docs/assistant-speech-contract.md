# Assistant speech source delivery (d729bc38)

Pi authors normal assistant messages. The extension delivers every non-invisible
assistant text, including text accompanying tools and partial error/abort output.
Custom/user/tool/thinking content is not converted into speech. Input origin and
background ownership do not classify assistant wording.

## Producer boundary

Installed Pi emits `turn_start` before initial/steered user message events. The
`context` hook is therefore the source boundary: consumed input identity is known,
but asynchronous provider work has not started. Each response gets a new UUID.
The hook synchronously freezes connection, room, verbatim `attached_at`, server
`speech_attachment_id`, capability, command or exact interaction identity, and
model. Binding is acquired once per consumed input (cached across response rounds)
through host-only `report_pickup { speech_scope: true, ...scope }`. It returns an
exact `attempt_id`. The resolved bearer and original capability remain private;
subsequent posts do not fetch replacement credentials or adopt a newer scope.

A partial command tuple, missing interaction identity, missing attachment scope,
failed binding, stale scope, or structurally unsupported system-notice run cannot
fall back to the legacy text/settlement path. Raw output remains in Pi JSONL, with
an explicit unconfirmed-storage warning. No model instructions require a posting
ritual.

## Wire and storage

`post_session_message` selects the isolated lane by `assistant_source_id`:

- `connection_id`, `expected_session_id`, `expected_attached_at`,
  `expected_attachment_id`, `attempt_id` are mandatory.
- Command sources carry both command turn/message ids; local sources declare
  `local_turn: true`; interactions retain event, response-or-question, and claim.
- `message` is unchanged concatenated assistant text blocks.
- `complete_turn: false`; speech cannot finalize/adopt/release a trail pointer,
  complete an attempt, or change Working/Pending.

Migration 933 adds a source UUID unique per connection and two service-only RPCs.
Attachment writes rotate a separate server-generated speech attachment UUID even
when room/timestamp values repeat; unrelated heartbeat/status writes do not.
Both RPCs lock/recheck connection attachment, capability, bearer token ownership,
and exact attempt/source. Open superseded generations reject. Closed A may append
to its original still-attached room while B owns the pointer. Retries return the
same durable row; changed bytes or binding with the same source reject. Independent
identical texts remain independent rows, with their own occurrence clock.

Speech does not split the execution turn. Existing activity/trail settlement owns
completion. `agent_settled` cannot post a second copy of source-managed speech.
Each append independently checks the remote-control feature gate. Receipt acceptance
requires an exact source UUID echo and a typed stored/idempotent receipt with a
consistent row ID; legacy receipt compatibility is not used for this lane.

The source row retains the captured command reply parent, mentions and full sender
label. Normal participation, reply/mention notifications and title/discussion
followups share the legacy post helpers without invoking its lifecycle effects.
A retry uses the original durable metadata and message-ID notification keys, not
freshly derived quotes; a deleted source cannot be rebroadcast as a new message.

## Bounds and evidence

Atomic delivery accepts at most 100,000 Unicode codepoints and 512,000 UTF-8 bytes
of `JSON.stringify(text)`, including quotes/escaping. No truncation or chunk broker.
NUL and lone UTF-16 surrogates cannot be represented by PostgreSQL text and reject
explicitly. PostgreSQL `to_json(text)` applies equivalent escaping on representable
text; tests exercise the exact 512,000-byte control-character boundary. The existing
2,500,000-byte envelope ceiling remains. Invisible-only detection is an emptiness
predicate, never a transformation of delivered text.

`devspec-assistant-speech` custom JSONL entries preserve raw source text and
nonsecret correlation; receipt entries record storage confirmation and attempt id.
They are not model-context injections and not a restart replay outbox. Broad reload
restoration remains separate work (568cf99f).

Deployment order: migration, backend, then plugin. Generated DB types and plugin
catalog refresh belong to deployment. Browser/Broadcast qualification of larger
messages and live common-case replay remain required; local SQL/transport tests do
not prove those surfaces. Legacy hosts without `assistant_source_id` retain their
existing finalizer and 12,000-character behavior.
