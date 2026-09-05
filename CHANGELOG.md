# Changelog

## Unreleased

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
