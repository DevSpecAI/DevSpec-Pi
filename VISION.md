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
`docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md` in devspecv2) is binding here:

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
  system of record. We implement against them, we don't route around them.

### 4. Provider freedom is load-bearing

Users pick their own model provider and subscription. DevSpec never requires a
specific model. Features must be model-agnostic (no provider-specific prompt
tricks that silently break on other models).

### 5. Own the first ten minutes

Stock Pi has real discoverability gaps (e.g. thinking level is Shift+Tab or
`/settings`, not a slash command; no MCP or sub-agents built in). This package
owns onboarding: first-run login flow, `/devspec.help`, sensible defaults —
so "install Pi, install package" feels like downloading a purpose-built app.

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

DevSpec memory is the memory system — Pi just lets it breathe:

- **Recall:** `before_agent_start` injects the most task-relevant memories
  automatically (semantic search per turn), instead of relying on the model
  remembering to search.
- **Capture:** the extension observes turns and suggests `record_memory` when
  a durable decision/convention/risk appears (user-confirmed, not silent).
- **Survival:** compaction preserves the active DevSpec context (claimed
  items, bond state, recalled memories) across context windows.
- **Freshness:** stale-memory detection prompts supersede/retract flows.

### Remote control: native-runtime family, done right

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
- **Egress:** the agent is the **sole content authority** — it answers via
  `post_session_message({ connection_id })` like every other host. Turn
  mirroring via extension events exists only as the contract's sanctioned
  last-resort (attached + no direct post since last owner instruction),
  never as the primary path. Chrome stays terminal-only.
- **Authority:** act only on `commands[]` addressed to this `connection_id`
  with owner authority; advisory/room context never wakes or executes.
- **Permissions:** stock Pi has no permission popups, so the approval-hook
  machinery other hosts need is unnecessary. Unattended runs get our own
  destructive-command gate instead.
- **Headless:** all of the above runs under `pi -p` / RPC / SDK unchanged.

### Auth

`/devspec.login` → device-code/browser flow in a TUI overlay (headless: prints
the URL, polls). Token stored in `~/.pi/agent/` with 0600 perms, env var
override (`DEVSPEC_MCP_TOKEN`) honored for CI/cloud. Status surfaced in the
footer. No env-var wrangling as the primary path.

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

## Relationship to other plugins

- They stay. They work. They are the mainstream path today.
- This repo proves the native patterns; anything worth back-porting goes
  through the contract docs and is applied per-host **by hand** (per the
  plugin-independence ADR), not via shared files or sync tooling.
- If this package succeeds, users are encouraged toward it — as an upgrade
  path, never a forced migration.

## DevSpec-side open questions (for devspecv2, not blockers)

1. **Push channel:** should `poll_connection` long-poll evolve into SSE /
   WebSocket for native-runtime hosts? Long-poll works, but a native host can
   hold a socket; server holds the 60 req/min token budget either way.
2. **Rate limits:** the 60 req/min per-token budget shaped the OpenCode
   long-poll redesign. Confirm the budget still matches reality before this
   package picks pump semantics.
3. **Bond revive window:** currently 24h (`BOND_REVIVE_WINDOW_MS`). Is that
   the intended product semantics (vs the historically-mentioned 72h)?
4. **Proactive memory recall:** is per-turn semantic recall acceptable load on
   `search_memories`, or does it need a dedicated lightweight endpoint?
5. **Embedded user MCP servers in cloud workers:** does the secrets store
   design cover MCP server credentials, or only env-var secrets?

## Phasing

1. **Scaffold + this document.** ✅
2. **Core transport + auth + native tools** — usable interactive sessions:
   login, action items, search, memory tools with real renderers.
3. **System-prompt injection + slash commands** — workflows native.
4. **Remote control** — bond, pump, ingress/egress per contract.
5. **Memory recall/capture engine + compaction survival.**
6. **Onboarding polish, theme, embedded user-MCP support.**
7. **Headless worker CLI** (cloud primitive, dogfooded locally first).

## References (devspecv2, binding)

- `docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md` — delivery contract (ADR `b98a39a9`)
- `docs/REMOTE-CONTROL-ACTIVITY-CONFORMANCE.md` — pickup lease / presence
- `docs/remote-control/remote-control-overview.md` — families + shared rules
- `apps/web/lib/connections/lifecycle.ts` — bond lifecycle, revive window
- `apps/web/app/api/mcp/route.ts` — stateless POST-only MCP transport
- Pi docs: `docs/extensions.md`, `docs/packages.md`, `docs/sdk.md` (in the pi install)
