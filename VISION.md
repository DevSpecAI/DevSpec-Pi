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

## Architecture

```
devspec-pi/                        ← this repo, published as one npm package
├── package.json                   ← pi manifest: extensions, skills, themes
├── extensions/
│   ├── core/                      ← INTERNAL client: MCP transport, auth store,
│   │                                bond lifecycle, turn pump, memory engine
│   ├── devspec-auth.ts            ← /devspec.login, token lifecycle, status
│   ├── devspec-tools.ts           ← native pi tools over the MCP verb surface
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
`apps/web/app/api/mcp/route.ts`). That is ideal: this package embeds a
minimal MCP client and surfaces every DevSpec verb as a **native pi tool**
(`pi.registerTool`) with proper schemas, custom TUI renderers, first-class
error handling, and auth integration.

This is the crucial middle path:

- We are **not** dependent on a third-party MCP adapter or a second process.
- We are **not** inventing a parallel REST surface that devspecv2 must
  maintain. The MCP tool surface stays the single binding contract.
- The same embedded client can optionally mount the **user's own MCP servers**
  (e.g. Supabase) from a standard config — one install, their servers work,
  headless workers included. (Prototype early; de-risks the one-package promise.)

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
"autopilot" (unattended work via special skills/commands) is being retired
server-side in favor of the connection-native remote system: agents are simply
*available capacity*, and interactive vs. unattended is an **instruction-tier**
difference (agent_rules vs. custom_instructions), not a separate system with
separate verbs. This package inherits none of the autopilot machinery — it is
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
- **Tick:** one held `poll_connection` long-poll per bond (heartbeat +
  commands + advisory + dispatches), matching the server contract. Multi-bond:
  one pump iterating all bonds in the process.
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
- **Authority:** act only on `commands[]` addressed to this `connection_id`
  with owner authority; advisory/room context never wakes or executes.
- **Permissions:** stock Pi has no permission popups, so the approval-hook
  machinery other hosts need is unnecessary. Unattended runs get our own
  destructive-command gate instead.
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
7. **Autopilot verb retirement:** which MCP verbs/settings die with the old
   autopilot cutover, and what (if anything) replaces `stale_claim_timeout`
   etc. for capacity-model unattended runs?
8. **`provider: 'pi'`:** `claim_work_item.provider` is an enum of known hosts
   (claude_code … opencode) — pi isn't in it, so our claims stamp no provider
   (the active-agents UI shows no logo while we work). Add `pi` server-side.

## Phasing

1. **Scaffold + this document.** ✅
2. **Core transport + auth + native tools** — usable interactive sessions:
   login, action items, search, memory tools with real renderers. ✅
   (embedded MCP client, `/devspec.login|logout|status`, 15 native tools,
   staging/prod environments; custom TUI renderers still TODO)
3. **System-prompt injection + slash commands** — workflows native. ✅
   (`before_agent_start` workflow block; `/devspec.work` with live item
   completion; `/devspec.help`; +5 workflow verbs: create/claim/release/
   record/update; reactive git_remote project scoping)
4. **Remote control** — bond, pump, ingress/egress per contract. **Slice 1 ✅**
   (`/devspec.remote [--session id] | stop`; register/revive with local_id =
   pi session id; one held 25s `poll_connection` per bond; owner commands →
   real user messages; agent-canonical egress via `post_session_message` with
   bond-default connection_id; bonded-mode instruction block incl. the four
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
   - **Mechanical final answer:** on `agent_settled`, posts the final
     assistant message (`phase:'answer'` + `complete_turn:true`) UNLESS the
     model already posted via the tool this turn (tool posts take precedence;
     never dual writers). Local-terminal turns mirror the prompt as
     `turn_kind:'local_prompt'` first — two-sided transcript.
   - **Dispatches:** `dispatches[]` are injected as user messages driving the
     assignment protocol (get_assignment → acknowledge → claim → work →
     record → resolve); the four assignment verbs are native tools.
   - Verified: `scripts/e2e-lifecycle.mjs` — model told NOT to post, answer
     still lands in the transcript (external_agent, correct attribution).
     Trail storage is server-side (not exposed by get_session_transcript) —
     the "Show work" bubble is verified in the web UI.
   - `pending_context_wipe`: surfaced as a notification only (never
     auto-wipes). Debug: DEVSPEC_DEBUG_REMOTE=1 → /tmp/devspec-remote-debug.log.
5. **Memory recall/capture engine + compaction survival.**
6. **Onboarding polish, theme, embedded user-MCP support.**
7. **Headless worker CLI** (cloud primitive, dogfooded locally first).

## References (devspecv2)

- `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md` — delivery contract (ADR `b98a39a9`)
- `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md` — pickup lease / presence
- `docs/remote-control/remote-control-overview.md` — families + shared rules
- `apps/web/lib/connections/lifecycle.ts` — bond lifecycle, revive window
- `apps/web/app/api/mcp/route.ts` — stateless POST-only MCP transport
- Pi docs: `docs/extensions.md`, `docs/packages.md`, `docs/sdk.md` (in the pi install)
