# DevSpec Pi — Vision

**Status:** Founding document (2026-08-12). Precedes all code. If code and this
document disagree, either the code is wrong or this document is stale — fix one.

## What this is

A single Pi package (`pi install …`) that turns a stock Pi install into the
most native DevSpec coding-agent experience that exists on any host:

- Install Pi, install this package, log in, work. Two commands, no other
  dependencies, no "install these 10 community packages first".
- Native tools, native slash commands, native auth, native remote-control
  turns, native memory — not MCP-shimmed, not hook-script workarounds.
- The **flagship** DevSpec host. Other plugins (Claude Code, Codex, Cursor,
  OpenCode, Grok, Antigravity) remain fully supported; this repo is where the
  experience we *wish* those hosts allowed gets built.

## Non-goals

- **No fork of Pi.** Ever. Pi upstream improvements, the user's provider/model
  choice, and the user's own Pi customizations are load-bearing product value.
  Everything here is stock-Pi extension surface: tools, commands, events, UI.
- **Not a Claude Code clone.** Pi's minimalism is a feature. We don't recreate
  other harnesses' UX; we build the DevSpec experience Pi makes possible.
- **No shared code with other plugin repos.** See "Contract, not code" below.

## Design principles

### 1. Native over workaround — but verified, not assumed

Other DevSpec plugins grew organically; many of their behaviors (polling
cadences, stall heuristics, mirror paths, timeout values) were accidents of a
find-your-feet development process, not deliberate design. **Nothing is
inherited from another plugin without re-justifying it against Pi's actual
capabilities and the DevSpec contract docs.** When this repo needs a behavior,
the question is "what should this be on Pi?", never "what does OpenCode do?"

### 2. Headless-first

Every feature must work identically with no TUI: `pi -p`, `--mode json`,
`--mode rpc`, and SDK sessions exercise the same code paths as interactive
mode. TUI (overlays, status lines, footers, custom renderers) is progressive
enhancement, never a requirement.

Rationale: a headless Pi worker running this package **is** the cloud-agent
primitive (see "Cloud future"). Getting this rule right now means the cloud
product is a deployment concern later, not a re-architecture.

### 3. Contract, not code

DevSpec's plugin-independence decision (ADR `b98a39a9`,
`docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md` in devspecv2) governs how this
repo relates to the other plugins:

> No plugin is canonical, and no file crosses a repo boundary. What binds the
> plugins together is the contract and the MCP tool surface — never a shared
> file.

Consequences:

- This repo's internal core (client, auth, bonding, turn pump) is **internal
  to this repo**. It is not published for other plugins to consume.
- Improvements that should reach other hosts flow through the **contract docs
  and MCP tool surface** in devspecv2, then are applied per-host by hand.
- The MCP verbs (`register_connection`, `poll_connection`,
  `post_session_message`, `report_pickup/keepalive/complete`,
  `report_progress`, action-item/memory/search/artifact tools) are the
  interop surface of record **today**. We implement against them — and per
  principle 4, we may also prototype their successors here.

### 4. Intent is fixed; mechanics are negotiable

Only the **intent** of DevSpec is settled: multiple people and agents sharing
one session, tools connected everywhere, all of it usable remotely, work
tracked from conversation to verified code. Everything below that — the
delivery contract's principles, long-poll transport, revive windows, even
"agent is the sole content authority" — is a *current best answer*, invented
under pressure while finding our feet. Some of those answers are deliberate
and good; none are sacred.

This repo treats every mechanism as re-derivable from intent. Where we find a
strictly better answer, the strategy is **parallel systems, not breakage**:

- The existing contract keeps working untouched for current hosts — those
  plugins are fragile and hard-won; breaking them is the cardinal sin.
- The better mechanism ships alongside (a v2 verb, a new channel, a changed
  server behavior behind capability flags), this package adopts it first, and
  less capable harnesses migrate only if/when it proves out.
- DevSpec-side changes are explicitly in scope when justified. "The contract
  says so" ends a discussion about *interop today*, never about *what to
  build next*.

Example of the distinction: "the agent is the sole content authority" serves
a real intent — the DevSpec UI must never diverge from or invent what the
agent is doing. We honor that intent absolutely. Whether "one
`post_session_message` per turn" is the best *mechanism* for it (vs. streamed
turns, structured progress events, richer transcript types) is an open
design question this repo is allowed to ask.

### 5. Provider freedom is load-bearing

Users pick their own model provider and subscription. DevSpec never requires a
specific model. Features must be model-agnostic (no provider-specific prompt
tricks that silently break on other models).

### 6. Own the first ten minutes

Stock Pi has real discoverability gaps (e.g. thinking level is Shift+Tab or
`/settings`, not a slash command; no MCP or sub-agents built in). This package
owns onboarding: first-run login flow, `/devspec.help`, sensible defaults —
so "install Pi, install package" feels like downloading a purpose-built app.

The end-state is **zero commands**: launch Pi and you're connected capacity —
logged in, bonded, reachable. Commands exist for control and debugging, never
as a requirement to participate.

### 7. Cross-platform parity

Windows, Linux, and macOS are equally first-class. No unix-only assumptions:
paths via `node:path`, file perms best-effort (0600 is meaningful on POSIX, a
no-op on Windows), no shell-specific behavior in code or docs, no `sh`-isms in
spawned processes. If a feature can't be parity, it gates cleanly per-OS — it
never silently half-works.

### 8. Context efficiency and result quality are tested contracts

A smaller payload is not an improvement if it hides the fields needed to choose
the right exact read. A richer payload is not an improvement if it needlessly
repeats whole entities into every later model request. Therefore every new or
changed model-facing tool must deliberately choose a projection family, retain
its selection/action inputs, declare omissions and a recovery path, and remain
inside an explicit model-visible budget. Exact reads stay complete where no
lossless continuation exists.

`npm run check` is the development and CI gate: typecheck, the full contract /
privacy / projection suite, and the deterministic `benchmark:context` fixtures.
The generated wire catalog is additionally fingerprinted against a sibling
DevSpecV2 checkout whenever both repositories are present. Runtime refinement
uses numeric counts plus generated verb identifiers for context-budget
telemetry (static prompt/tools, injected context, result characters); prompt text, instructions,
context contents, arguments, results and provider payloads are never logged.

## Architecture

```
devspec-pi/                        ← this repo, published as one npm package
├── package.json                   ← pi manifest: extensions, skills, themes
├── extensions/
│   ├── core/                      ← INTERNAL client: MCP transport, auth store,
│   │                                bond lifecycle, turn pump, memory engine
│   ├── devspec-auth.ts            ← /devspec.login, token lifecycle, status
│   ├── generated/mcp-catalog.ts   ← WIRE map (item 523f1512), not the initial surface
│   ├── core/model-surface.ts      ← hot set + deterministic deferred-tool search
│   ├── devspec-tools.ts           ← safe verbs registered; rare tools start inactive
│   ├── devspec-remote.ts          ← remote control (see below)
│   ├── devspec-memory.ts          ← proactive recall + capture
│   ├── devspec-onboard.ts         ← first-run experience, /devspec.help
│   └── devspec-ui.ts              ← status line, footer, renderers (TUI-only paths)
├── skills/                        ← few, only where on-demand context wins
├── prompts/                       ← power-user templates
└── themes/                        ← DevSpec brand theme (#0F766E)
```

**Pi extension isolation (learned the hard way):** pi loads every extension
FILE with a fresh jiti module graph (`moduleCache: false`). Module-level
singletons are therefore per-file, not per-process. Any state shared between
our extension files (bond state, the MCP client cache) lives on `globalThis`
— see `core/bond-state.ts` and `core/client.ts`. Per-file state (the remote
pump) is fine as module scope.

### Transport: the MCP contract, spoken natively

The DevSpec MCP endpoint (`https://devspec.ai/api/mcp`) is a **stateless
Streamable HTTP, POST-only, bearer-token** bridge (verified in
`apps/web/app/api/mcp/route.ts`). That is the **wire**. This package embeds
a minimal MCP client and speaks those verb names. What the *model* sees is
a **Pi-shaped surface**, not a 1:1 dump of `tool-definitions.ts`:

- always-on hot set (~15 everyday verbs) with short snippets and slimmed schemas
- safe rare verbs registered as real, initially inactive Pi tools with slimmed schemas
- one tiny `search_devspec_tools` loader additively activates relevant rare tools
- extension stamps `git_remote` / project / session / bond ids — the model is never asked
- target initial prefix for DevSpec tools + workflow block: **2–8k tokens**, not ~60k

The generated catalog (`523f1512`) stays the wire map + drift test, not the
initial active model surface.

This is the crucial middle path:

- We are **not** dependent on a third-party MCP adapter or a second process.
- We are **not** inventing a parallel REST surface that devspecv2 must
  maintain. The MCP tool surface stays the single binding contract.
- The same embedded client can optionally mount the **user's own MCP servers**
  (e.g. Supabase) from a standard config — one install, their servers work,
  headless workers included. (Prototype early; de-risks the one-package promise.)
- A `devspec` entry in project `.mcp.json` (the file other hosts use) is **not**
  a second connection. The extension detects DevSpec's own origin and writes
  `{ disabled: true }` to the Pi-local overlay (`.pi/mcp.json`) so the adapter
  never registers those verbs. The shared file is left untouched. Foreign
  servers stay.

### Instructions without skill-sprawl

The model still needs instructions; the delivery is native now:

1. **Always-on core instructions** → injected via `before_agent_start`
   (system-prompt chaining), versioned with this package. Cannot drift,
   cannot fail to load.
2. **Workflows** → real slash commands (`pi.registerCommand`) with argument
   completion and real logic (e.g. `/devspec.work` tab-completes open items
   and validates before spending a turn).
3. **On-demand heavy context** → the only legitimate remaining use for skills
   (plan-review references, architecture primers). Keep few.

### Memory: better here than anywhere else

DevSpec memory is the memory system — Pi just lets it breathe. But the
framing is bigger than memory: **the intelligence layer is ONE system** —
memories, action items, artifacts, hybrid search across all three, and
conflict detection/settling between them. What already lives server-side
(build WITH it, never rebuild it):

- recall-gated `record_memory`/`supersede_memory` (hybrid recall on write)
- `create_action_item` related_candidates + background conflict checks
- review signals, `unresolved_conflicts`, queue holds,
  `preview_conflict_resolution` (what a verdict WOULD do),
  `resolve_action_item_conflict` with the supersedes-escalation rules
- work items already carry `relevant_memories` + `relevant_artifacts`

What Pi opens up (mechanical, zero-token, no model compliance):

- **Recall before thought** (shipped): every substantive turn's prompt is
  searched against project memory BEFORE the turn starts; new hits inject
  into the system prompt with binding semantics marked; session-deduped.
  The model no longer has to remember to remember.
- **Conflict surfacing** (shipped): payload signals become structural flags
  with a per-turn nudge while open + `/devspec.conflicts`. Never silent
  settling — supersedes escalates per the server rules.
- **Structured settling UI** (next): pi's custom overlays can walk the human
  through a conflict pair (both items side by side, preview_conflict_resolution
  consequence, verdict picker) — "user involvement when appropriate" with a
  real interface, not a wall of JSON. Nothing like this is possible on other
  hosts.
- **Capture** (shipped: guidance + gates; next: proposals): the extension
  observes turns and proposes record_memory at decision moments —
  user-confirmed interactively, `in_discussion` when autonomous.
- **Compaction survival** (next): the active DevSpec context (claimed items,
  bond, recalled memories) is re-injected after compaction so long sessions
  don't lose the plot.

### Remote control: native-runtime family, done right

**Context — autopilot is dead, capacity is the model.** The old Claude-Code-only
"autopilot" (unattended work via special skills/commands) has been retired
server-side in favor of the connection-native remote system: agents are simply
*available capacity*. There is no interactive/unattended distinction at all — not
a separate system, not separate verbs, and not (as an earlier draft of this
section had it) an instruction-tier difference. DevSpec item `6d085535` deleted
the execution mode outright and replaced it with nothing: whether to ask is a
judgement from the item's intent and acceptance criteria. This package inherits none of the autopilot machinery — it is
designed for the capacity model from the start, and is the place to push it
further than the current contract does.

**The zero-command target.** The ambient end-state: the user launches Pi and
never types a command. **Shipped (interactive sessions):** on `session_start`
in TUI mode the extension resolves the token and bonds automatically
(`/devspec.remote auto off` opts out persistently). Headless modes never
auto-bond — scripts, one-shots, and cloud workers bond explicitly.

Pi sits in the contract's "native runtime" family (in-process, like OpenCode)
but with better primitives. Binding rules from the delivery contract are
honored, not ported around:

- **Bond:** `register_connection` with the Pi **session id as `local_id`**
  (Pi mints stable session ids; bond on conversation id, never cwd/shell).
  Server-side revive within the 24h `BOND_REVIVE_WINDOW_MS` is relied upon —
  we always pass the same `local_id`.
- **Tick:** one held `poll_connection` long-poll per bond, negotiating numeric
  `ingress_version: 1`. Canonical semantics are served at
  `devspec://product/remote-ingress-contract`; this document does not restate
  mutable server policy.
- **Ingress:** owner commands arrive as **real user messages** via
  `pi.sendUserMessage()` — with correct steer/followUp semantics while busy,
  appearing in the transcript as if typed. Slash-command text is never
  injected as a prompt.
- **Egress:** the DevSpec UI must never diverge from or invent what the
  agent is doing — that intent is non-negotiable. Today's mechanism: the
  agent answers via `post_session_message({ connection_id })`, with turn
  mirroring only as the contract's sanctioned last-resort. We ship that —
  while treating richer egress (streaming, structured progress) as an
  open design space per principle 4. Chrome stays terminal-only.
- **Authority:** canonical `ingress` is the only conversational command/context
  source after negotiation; legacy top-level arrays are ignored by Pi.
- **Permissions:** stock Pi has no permission popups, so the approval-hook
  machinery other hosts need is unnecessary. Our own destructive-command gate
  applies to every run, since no run can claim someone is watching it.
- **Headless:** all of the above runs under `pi -p` / RPC / SDK unchanged.

### Auth

Today: `/devspec.login` accepts an account-wide token pasted from the DevSpec
Connections page (`/settings/connections`), verified via
`verify_agent_connection` and stored at `~/.pi/agent/devspec/auth.json`
(0600, best-effort on Windows). `DEVSPEC_MCP_TOKEN` env wins for CI/cloud.
No env-var wrangling as the primary path.

Environments are first-class: development targets **staging.devspec.ai** (dev
Clerk + Supabase), production is **devspec.ai**. `DEVSPEC_ENV=staging` or a
full `DEVSPEC_MCP_URL` override selects the endpoint; login guidance points at
the matching Connections page automatically.

Later (DevSpec-side work): OAuth device-code flow so login is a browser
confirmation, not a token paste — designed per-environment from the start.

Tokens are account-wide; **project resolution is the server's job** (per-call
project scope, git-remote matching). Our tools pass `git_remote` through where
the verb accepts it and otherwise stay project-agnostic.

## Cloud future (door held open, not built now)

The non-technical-user dream: DevSpec clones their repo into a cloud sandbox
and works on it directly. This architecture is chosen so that product is a
deployment of existing pieces:

- **Worker** = `createAgentSession()` (Pi SDK) + this package, in a container.
  Guaranteed by the headless-first principle.
- **Provider keys:** Pi natively supports OpenRouter / Vercel AI Gateway — a
  DevSpec-managed gateway key gives any-model access with per-key spend
  limits; BYOK as escape hatch. No hardcoded provider.
- **Third-party auth (DBs, Axiom, etc.):** per-project encrypted secret store
  in DevSpec, injected as env vars into the sandbox; the agent uses CLIs like
  a developer. Capability classes: *headless-ready* vs *needs-human-bootstrap*
  (interactive OAuth). Never promise the latter silently.
- **Same transport:** the worker speaks the identical MCP verb surface.

## Distribution & release (when the time comes)

The **real** distribution path is npm — `pi install npm:@devspec/pi-plugin` —
with the `pi-package` keyword so it surfaces on the npmjs pi-package search
and pi's package discovery. The settings-path loading we dogfood with is a
development convenience, never the user story.

Release gates (all must hold before publishing):

1. **Prod domain healthy.** Today `devspec.ai` serves the Traefik default cert
   from at least some networks (found during Phase 2 dogfooding) and
   `staging.devspec.ai` carries the real service. Public install must default
   to a working prod endpoint — the package's default is already prod
   (`DEFAULT_MCP_URL`), with `DEVSPEC_ENV=staging` / `DEVSPEC_MCP_URL` as
   dev-only overrides. Verify TLS + `/api/mcp` on prod before release.
2. **Login guidance matches the domain.** `/devspec.login` already points at
   the Connections page for the *effective* endpoint; OAuth device flow (when
   it lands) must be per-environment too (dev Clerk on staging, prod Clerk on
   prod).
3. **Server knows pi.** `claim_work_item.provider` needs a `'pi'` enum value
   (open question #8) so claims/UI attribute correctly.
4. **Package hygiene:** versioned release from CI, `files` whitelist,
   production-only deps (runtime deps in `dependencies` — pi installs with
   `--omit=dev`), README with the two-command install.

## Relationship to other plugins

- They stay. They work. They are the mainstream path today.
- This repo proves the native patterns; anything worth back-porting goes
  through the contract docs and is applied per-host **by hand** (per the
  plugin-independence ADR), not via shared files or sync tooling.
- If this package succeeds, users are encouraged toward it — as an upgrade
  path, never a forced migration.

## DevSpec-side open questions (for devspecv2, not blockers)

Each of these is a candidate **parallel-system** change: shipped alongside the
current contract, adopted here first, migrated to other hosts only if proven.

1. **Push channel:** the zero-command ambient model basically *answers* this —
   long-poll works, but "launch Pi and you're reachable" wants a server-push
   channel (SSE/WebSocket) that the extension holds open on `session_start`.
   Design as a parallel-system v2: `poll_connection` stays for all current
   hosts; the push channel ships alongside and this package adopts it first.
   Candidate transports: SSE off the Next app (simplest), or Supabase
   Realtime Broadcast (the web UI already uses it for live session updates)
   with an agent-token-scoped channel. Instant ingress, presence rides the
   channel, the 25s holds and the 60 req/min budget math both disappear.
   Our pump is isolated behind one module; transport swap is contained.
2. **Rate limits:** the 60 req/min per-token budget is REAL and shared across
   everything (polls, heartbeats, trail posts, tool calls). Measured live:
   a 1/sec flat trail cadence blew the budget on a multi-minute turn, and
   every later tick retried into the limiter. Mitigations shipped: adaptive
   trail cadence (1s → 2s → 4s → 10s ceiling, ~20 posts/3min turn),
   process-wide cooldown honoring the server's "retry after N" hint, one
   rate-limit retry then fail, one warning per turn. Open: whether failed
   (429) attempts count against the budget — assumed yes (worst case).
3. **Bond revive window:** currently 24h (`BOND_REVIVE_WINDOW_MS`). Is that
   the intended product semantics (vs the historically-mentioned 72h)?
4. **Proactive memory recall:** is per-turn semantic recall acceptable load on
   `search_memories`, or does it need a dedicated lightweight endpoint?
5. **Embedded user MCP servers in cloud workers:** does the secrets store
   design cover MCP server credentials, or only env-var secrets?
6. **OAuth device flow:** new endpoint family per environment (staging dev
   Clerk vs prod). When scheduled, this package is the reference client.
7. **Historical retirement record (answered 2026-08-17):** the former work
   assignment verbs (`get_next_work_item`, `get_assignment`,
   `acknowledge_assignment`, `resolve_assignment`) are gone; `reserve_work_items` +
   `claim_work_item` are the whole acquisition surface. The orchestration
   settings — `enabled`, `poll_interval_seconds`, `idle_detection`,
   `stale_claim_timeout` — are deleted rather than replaced: nothing polls, so
   there is no interval, and DevSpec expires orphaned claims itself rather than
   exposing a window to configure (DevSpec items 1e455001, 8fe6c939).
8. **`provider: 'pi'`:** `claim_work_item.provider` is an enum of known hosts
   (claude_code … opencode) — pi isn't in it, so our claims stamp no provider
   (the active-agents UI shows no logo while we work). Add `pi` server-side.

## Phasing

1. **Scaffold + this document.** ✅
2. **Core transport + auth + native tools** — usable interactive sessions:
   login, action items, search, memory tools with real renderers. ✅
   (embedded MCP client, `/devspec.login|logout|status`, staging/prod.
   Completeness of verbs shipped as a catalog dump in `523f1512`; the
   **product** starts with a Pi-shaped hot set — ~15 always-on tools plus
   deferred rare-tool search, ~2–8k prefix. Custom TUI renderers still TODO)
3. **System-prompt injection + slash commands** — workflows native. ✅
   (`before_agent_start` workflow block is tight: no "Check DevSpec first",
   no 76-verb when-X-call-Y dump. `/devspec.work` with live item completion;
   `/devspec.help`; reactive git_remote project scoping)
4. **Remote control** — bond, pump, ingress/egress per contract. **Slice 1 ✅**
   (`/devspec.remote [--session id] | stop`; register/revive with local_id =
   pi session id; one held 25s `poll_connection` per bond; owner commands →
   real user messages; mechanical egress — the extension delivers the run's
   final assistant message; bonded-mode instruction block incl. the four
   instruction tiers; headless RPC e2e in `scripts/e2e-remote.mjs`.
   Remaining ingress leg — owner message from the web UI — is the human
   acceptance step.)
   **Slice 2 ✅** — the MECHANICAL turn lifecycle (zero tokens, no model
   compliance required):
   - **Trail streaming:** the extension renders a cumulative terminal-style
     trail from pi's events and posts it as `phase:'trail'` (~1/sec throttle
     + settle flush). `message_update` streams live in the TUI; headless
     modes emit no deltas (verified — RPC stdout carries none), so
     `message_end` also feeds the trail (cumulative snapshots, idempotent),
     keeping cloud/headless trails complete.
   - **Mechanical final answer — the ONLY writer (cc9e8c43):** on
     `agent_settled`, posts the run's final assistant message
     (`phase:'answer'` + `complete_turn:true`). The model has no content
     channel at all — no tool post, no complete_turn discipline, no
     precedence/suppression state. Turn state is RUN-scoped (agent_start →
     agent_settled), never recreated per LLM round: per-round state was the
     double-bubble root cause (857d984c's suppression marks died with each
     round's fresh tracker) and truncated the preserved trail to the last
     round. Local-terminal turns mirror the prompt as
     `turn_kind:'local_prompt'` first — two-sided transcript.
   - **Playbook runs:** `dispatches[]` is a transport field for owner-scoped,
     typed playbook runs only. Pi rejects every other shape before queueing or
     model injection. Action-item work never enters this channel: the agent
     reserves already-selected items with `reserve_work_items`, then claims
     them one at a time.
   - Verified: `scripts/e2e-lifecycle.mjs` — model told NOT to post, answer
     still lands in the transcript (external_agent, correct attribution).
     Trail storage is server-side (not exposed by get_session_transcript) —
     the "Show work" bubble is verified in the web UI.
   - `pending_context_wipe`: surfaced as a notification only (never
     auto-wipes). Debug: `DEVSPEC_DEBUG_REMOTE=1` writes privacy-safe metadata
     to `devspec-remote-debug.log` under the platform's temporary directory.
5. **Memory recall/capture engine + compaction survival.**
6. **Onboarding polish, theme, embedded user-MCP support.**
7. **Headless worker CLI** (cloud primitive, dogfooded locally first).

Shipped 2026-08-13 (Fierce Kestrel / Restless Squirrel):
- `d2f4f25c` — mechanically suppress an adapter-mounted DevSpec MCP server.
- `7de79db6` — original Pi-shaped model surface. Superseded by native
  deferred loading for rare tools; the generated catalog remains the wire map.

## Next-up queue (as of 2026-08-13)

Tracked as DevSpec items — this list is a pointer, the items are the truth:

- `274c9f15` — mechanical first-touch: stop telling the model to search first
  (partially landed with `7de79db6`'s instruction rewrite; remaining: do not
  expand recall, attach-agenda is `f9fa2767`)
- `c2cc8679` — control channel: owner-authority CONTROL verbs executed
  in-process (abort mid-turn, set model/thinking, compact, run slash command)
- `2219b653` — greenfield STRUCTURED audit trail: typed turn events end-to-end
  (thinking/text/tool/domain) → timeline UI. Markdown `work_trail` stays the
  fallback for other hosts. Pi posts `trail_events` on the same cadence.
- `bb6a7135` — instruction-tier parity audit (project/personal/agent/style,
  no CLAUDE.md reliance)
- `477a3eae` — composed working+queued UI state (general, not Pi-specific)
- `4462d45d` — cloud auth strategy (secrets store, gateway key, device-code,
  OAuth relay; subscription-token sync needs an explicit decision)
- `3fde909b` — launch-on-send: attach-on-launch flag/env + UI composer targeting
  (aligns with cloud agent-host decisions d61e47c9 / 4bd69fc9, plan f206a2ff)
- `efa7f71b` — Pi provider/logo in devspecv2 (another agent)
- `536f2417` — npm publish + prod domain readiness (release gates)
- Not yet items: conflict-settling TUI overlay; compaction survival;
  capture proposals at decision moments

Shipped 2026-08-12 late (Nimble Eagle):
- `b1fb756a` — delivery boundary = the user message, not just the run end.
  A mid-run followUp injection (owner message, terminal typing, queued
  notification) settles the current segment as its own bubble before the
  new message starts a fresh segment. Fixes the 27-minute one-bubble
  incident: four real answers collapsed into the run's last text because
  followUps extend the run (no agent_settled between them).
- `cc9e8c43` — mechanical-only answer delivery, owner-directed: the model's
  final terminal message IS the DevSpec answer, delivered by the extension at
  settle. Deleted the model-facing post_session_message tool, the toolPosted
  event signal, the globalThis backstop, and the precedence rule — the
  dual-writer failure class (857d984c, three patches, still leaking live)
  is gone by construction. Turn state is run-scoped (agent_start →
  agent_settled), fixing the per-round reset that defeated suppression AND
  truncated the preserved trail to the final round. TrailBuilder is now
  chronological per-round entries; the final render rides the answer at a
  48k cap so the fold's earlier rounds survive the replace.

Shipped 2026-08-12 (Lively Panther):- `8b0c162b` — instant disconnect detection: SSE-close → grace-guarded (10s)
  non-sticky liveness clear server-side; guarded going-away stamp on
  session_shutdown + push-channel reconnect backoff (1s/4s/10s) here.
- `ce5a1432` — adopt server-side attachment every poll lap (the
  bouncing-dots regression: UI-attach after sessionless auto-bond never
  reached the extension, killing the mechanical trail).
- `95db8479` + `9b7455df` — trail correctness: server folds sliding-window
  snapshots on a tail anchor; prefix-stable thinking render; the canonical
  final trail rides the answer post (replace-on-close, `work_trail` param).
  Live-verified end-to-end on staging with headless probes.

## References (devspecv2)

- `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md` — delivery contract (ADR `b98a39a9`)
- `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md` — pickup lease / presence
- `docs/remote-control/remote-control-overview.md` — families + shared rules
- `apps/web/lib/connections/lifecycle.ts` — bond lifecycle, revive window
- `apps/web/app/api/mcp/route.ts` — stateless POST-only MCP transport
- Pi docs: `docs/extensions.md`, `docs/packages.md`, `docs/sdk.md` (in the pi install)
