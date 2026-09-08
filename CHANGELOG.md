# Changelog

## Unreleased

### Auto-bond works when you have more than one project

Pi used to send `register_connection` with no folder identity, then retry with
this checkout's git remote if the server asked which project. A later fix stopped
closing the shared MCP client on application errors — and, by treating every
`isError` as "do not retry", also skipped that folder-scope retry. One-project
accounts kept working; a second project made auto-bond (and `/devspec.remote`)
fail with "this call needs a project", while Claude Code still connected because
it sends the git remote on the first register.

The host now sends the git remote and/or `.devspec/project.json` pin on the first
call when it knows the working directory, the same shape as Claude Code. A
project-scope `isError` still retries once with those facts on the same client —
not a reconnect. Other application errors are still one request. Auto-bond
toasts the register error instead of failing silently.

### Tool instructions are no longer cut off mid-sentence

Every DevSpec tool Pi offers carries a one-line description, and the line was
being trimmed to 140 characters (160 when the catalog was generated). That was
short enough to cut real sentences in half: 19 of 84 tool descriptions and 23
parameter descriptions ended in an ellipsis, so the model read half an
instruction and had to guess the rest. Both limits are 320 now, a test fails if
anything ever ships trimmed again, and the always-loaded surface grew from 6,933
to 7,130 tokens of its 8,000 budget to pay for it — a good trade for 42
instructions that now say what they mean.

The clearest example is the one that prompted this: the description for
recording a commit said only "Final commit SHA", while a neighbouring tool
demanded "the FULL 40-character sha". Three agents in one day filled in the
missing characters by inventing them. It now says a short SHA is fine and that
padding one out is wrong.

### The lowest project role is Viewer

DevSpec renamed the lowest project role from "guest" to Viewer (an organisation
Guest is now a different thing: how much of the organisation someone can see,
not what they can do on a project). Pi reads the served write-authority section
by its exact shape, so it now expects the 4.5.0 outcome key `viewer` — without
this, a newer DevSpec would have failed that section and Pi would have fallen
back to its generic rules. The generated MCP catalog is refreshed with it.

### A proposal against a memory now shows up when you search for it

DevSpec lets a colleague propose a change to a decided memory or artifact without
touching it, so what you recall is still the decided text. Searching for one used to
show no sign that a change was waiting on it — only opening the exact record did.
A search result now carries the same "⚠ … awaiting a maintainer" line the record
itself carries, so a proposed change cannot be missed by looking it up.

### A newer DevSpec no longer switches Pi back to its local rules

Pi verifies the product contract it is served. When DevSpec added a new section to
that contract, the whole document failed verification and Pi fell back to five
generic local rules — losing the work-entry, provenance and authority rules it could
read perfectly well. A section this version of Pi does not know about is now noted
("update the plugin to read it") and everything else stays in force. The sections Pi
does implement are still checked exactly, and the contract's own hash still has to
cover the part it cannot read. A contract that fails verification now says so, rather
than reporting DevSpec as unavailable.

### The write-authority summary says what it means for an unattended run

Pi shows the model the three write classes and their outcomes. It now shows the two
rules that qualify them, in DevSpec's own words: that a run nobody is watching
proposes its memories and artifacts rather than recording them, and that closing your
own item is a different act from closing a colleague's.

### The activity trail stops saying a queued write landed

Recording a memory or ruling on a conflict shows as "recorded" or "resolved" in the
trail. When the server queues the write for a maintainer instead of committing it,
the trail now says "proposed" — and "contested" for a conflict ruling, which is what
DevSpec calls a pair nobody has ruled on yet. Plugin 0.3.2.

### Instruction block: stop rationing sentences

The always-on instruction test now fails on genuine bloat (a dumped verb map or a
pasted contract), not on adding a needed sentence. The authority pointer and
queued-write relay are full sentences again, and the memory / record_implementation
wording that was trimmed to fit 2,200 characters on 0.3.0 is restored. Plugin 0.3.1.

### The served contract's authority section, and queued writes relayed

DevSpec contract 4.4.0 adds `authority_contract` — who may change the project's record,
judged per call by the server. Pi verifies the section exactly like the others (an older
Pi read the new document as invalid and fell back to its local safety rules), shows the
model the classes, outcomes, requester rule and proposal outcome, and when a write comes
back `queued_for_review` puts the proposal id and reason at the top of the tool result so
the model relays them and never reports the change as done. The MCP catalog is
regenerated (adds `get_pull_request`).

### Playbooks are now Automations

DevSpec has renamed Playbooks to Automations. This plugin now uses the renamed tools
(`claim_automation_run`, `record_automation_run`, `get_automations` and the rest) and reads
the renamed fields in what the server sends it. It needs a DevSpec server that carries the
same rename; against an older server, automation runs are not picked up.

### Fixed

- `/devspec.remote --session <id>` now ATTACHES an already-bonded agent to that
  session instead of refusing with "already bonded". Interactive Pi auto-bonds on
  session_start, so there was always a bond by the time the command ran, which made
  `--session` unreachable in practice — a resume command, a copied attach line, or a
  person typing it all hit the guard and the room was silently dropped. Naming a
  session is an explicit instruction to be in that room, not a duplicate connect.
  A bare `/devspec.remote` while bonded still says so and does nothing.

### Changed

- `npm test` caps `node --test` at two files at a time (`--test-concurrency=2`) so this suite cannot fork one worker per CPU next to a live agent.

### Added

- Deferred native `search_sessions`: wire-map catalog plus ordinary-language aliases, not in the hot set. Compact session cards, then `get_session_transcript` to read one room.
- Native, schema-complete `manage_poll` on the same attached-bond activation path as `manage_plan`. Votes are not commands and do not keep Working on.
- Strict top-level `session_polls` advisory projection on changed remote packages.

## 0.2.0 — 2026-08-22

### Added

- Native, schema-complete `manage_plan` backed by the generated DevSpec MCP wire map.
- Hidden connection-capability v1 negotiation and transport-header stamping; models never provide trusted connection, session, project, or capability identity.
- Strict canonical remote-ingress 1.3 active-session-plan parsing and deterministic delivery-tail projection for resume, handoff, adoption, completion, and abandonment.
- Narrow plan-tool activation for attached bonds while unrelated deferred schemas remain cold.
- Work-entry contract v2 validation so the canonical implementation contract owns action-item/session-plan selection and the high plan threshold.

### Validation

- Added strict parser, scope/capability, activation, prefix-budget, reconnect, handoff/adoption, no-plan, lossless result, and privacy-safe trail coverage.
- Regenerated and drift-checked the 91-verb server wire catalog.
