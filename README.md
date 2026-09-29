# DevSpec Pi

**Build on your team’s best thinking.**

DevSpec helps your team and AI agents turn ideas and experience into better software.

The native DevSpec experience for the [Pi](https://pi.dev) coding agent.

```bash
npm install -g @earendil-works/pi-coding-agent
pi install git:github.com/DevSpecAI/DevSpec-Pi
pi   # /devspec.login and you're in
```

One package: native tools, native auth, native remote control, native memory.
No MCP adapter, no hook scripts, no other packages required.

This package **is** your DevSpec connection. After `/devspec.login`, do not add a
DevSpec MCP server in Pi (`/mcp`, `.mcp.json`, or a Bearer header). That path is
for Claude, Cursor, and OpenCode. If this folder already has a DevSpec entry
because another tool shares it, leave that file — we turn the extra copy off
for Pi. Other MCP servers you use (Supabase, browsers) stay.

Open source: [github.com/DevSpecAI/DevSpec-Pi](https://github.com/DevSpecAI/DevSpec-Pi).
Install it from GitHub as above. It will also be published to npm as `@devspec/pi-plugin` (keyword `pi-package`), but it is not on the npm registry yet, so `pi install npm:@devspec/pi-plugin` does not work today.

**Read [VISION.md](./VISION.md) first** — it is the founding design document
and binds all implementation decisions in this repo.

## Status

**Phase 2 complete**: embedded MCP transport, `/devspec.login` / `/devspec.logout`
/ `/devspec.status`. Everyday DevSpec work is a small active native hot set;
less-common native tools are loaded on demand with `search_devspec_tools`. The
generated MCP catalog is the wire map, not the initial model surface. Shared session
plans and session polls are native: qualifying bonded work activates `manage_plan` and `manage_poll`, and strict
remote-ingress 1.4 adds capacity-gated exact-connection system notices through
an activity-neutral, generation-scoped harness turn, with preserved 1.3 command
intake under notice backpressure. See VISION.md.

### Choosing a project

The native project menu requires package 0.3.33 or later. From 0.3.34, a dedicated DevSpec row below the editor identifies the agent and selected project, separately from BG/MCP statuses. A change on `staging` is not a customer release to `main`, and a repository update does not reload an installed, running Pi session.

Normal startup is unchanged: a unique repository match or usable folder pin connects without a question. If DevSpec returns several matching projects, Pi offers a keyboard picker labelled with both project and organisation. Escape leaves the conversation unconnected.

For a choice you already know:

```text
pi --devspec-project "Client Website"
/devspec.remote --project "Client Website"
/devspec.remote --project <full-project-id> --session <room-id>
```

Names must match an accessible project exactly; duplicate names open the picker. These project options do not change Pi's native `--session`/resume behaviour or the existing Remote room selector. A project choice belongs to this local conversation, including its resume—not every Pi window in the folder. It is applied to normal DevSpec tools as well as the remote connection.

The dedicated row shows **DevSpec: agent · project · session · current work**, leaving Pi's native footer intact. Missing fields are omitted and full titles use the available width. When space is tight, the project name shortens first, then the action item, then the session; the agent name is preserved. From 0.3.35, DevSpec and the agent/session/work names use normal foreground; the project and supporting text stay muted, following your Pi theme. Project IDs, organisation and connection diagnostics stay out of the footer. `/devspec.project` opens a native menu. **Project details** (or `/devspec.project status`) shows the selected project, organisation, full ID, how it was selected and the effective folder default. Pick by the readable project and organisation names; IDs appear in the picker only when those labels would otherwise be identical. Use:

- `/devspec.project choose` to choose explicitly. Changing an established project offers a **fresh local conversation**, without copying the previous model context.
- `/devspec.project remember` to save the choice to `.devspec/project.json`, after showing the file and asking for consent. This is folder configuration, potentially shared or committed—not a private preference. A unique repository match still beats a stale pin.
- `/devspec.project forget` to remove the confirmed effective folder pin. Existing conversations keep their project; future connections resolve again. An inherited default is named before removal. Removing a local pin can reveal another inherited pin, so check Project details afterward.

Choosing defaults to **Use for this conversation**. Remembering is a separate opt-in. Headless/RPC ambiguity returns actionable choices without waiting for a picker; an explicit launch project can scope headless tools without enabling auto-bond. Older servers without structured choices still support explicit selection, but cannot trigger the automatic ambiguity picker.

Reload or restart existing Pi sessions after updating the package. See `node scripts/e2e-project-choice.mjs` for the disposable installed-Pi keyboard/RPC verification (loopback fixture, no model requests or live DevSpec records).

### Recoverable room history

When the server advertises room-context1.6, Pi keeps a private, recoverable room
copy using Node's SQLite support (available in the current stock Pi runtime).
Messages and recovery positions commit together. `read_room_context` offers local
history, search, exact message reads and observed-state snapshots, with explicit
continuation and freshness. When the local copy is ready, compact awareness replaces
repeated background-history dumps; full current commands and speech keep their
existing paths. The online transcript and current-record tools remain available.

The session activity index contains IDs and relationships only. Lifecycle,
supersession and other current record facts must come from the native online
getters. Saved plans, polls and discussion views are explicitly last-observed
snapshots. See [storage, privacy and recovery boundaries](docs/ROOM-CONTEXT.md).

On an older runtime without SQLite, ordinary remote delivery stays on its
supported lane. Existing sessions need a reload to load this feature.

## Development

```bash
npm install
npm run check                 # typecheck + full tests + deterministic context benchmark
npm run benchmark:context     # print the current prefix/result budget baseline
npm run test:room-runtime     # disposable real Pi host, loopback MCP, no model calls
npm run test:room-readers-runtime # scripted-provider host/tool/cutover qualification

# Dogfood against staging (dev Clerk/Supabase) without installing:
export DEVSPEC_ENV=staging                 # or DEVSPEC_MCP_URL=https://api.devspecstaging.com/api/mcp
export DEVSPEC_MCP_TOKEN=<from https://app.devspecstaging.com/settings/coding-agents>
pi -e ./extensions/devspec-auth.ts -e ./extensions/devspec-tools.ts
```

Production (`https://api.devspec.ai/api/mcp`) is the default when no override is set.

### Regression and context-budget workflow

GitHub Actions runs `npm run check` on every pull request and push to `main`.
The suite measures the initial DevSpec surface and plan activation delta. A generous
anti-bloat alarm catches accidental catalogue/contract dumps; useful instructions
and tool access are not sacrificed to meet a token target. It also checks per-family
model-visible result budgets, lossless exact reads,
privacy boundaries, deferred-tool routing,
and provider serialization. A checked-in fingerprint makes every model-facing
schema or projection-family change an explicit review event. `npm run
benchmark:context` exercises every bounded projection family with deterministic
lower/upper ranges and required-field markers, so both payload bloat and silent
information loss fail before a schema, projection, hot tool, or instruction block
can merge.

When the sibling `devspecv2` checkout is present at `../devspecv2`, the full test
suite also fingerprint-checks every generated MCP tool name/schema against the
current server contract. For worktrees or another location, run
`DEVSPEC_V2_ROOT=/path/to/devspecv2 npm run check`. Run that paired check before
merging any server tool change; standalone CI cannot read the separate private
repository and therefore reports this one check as skipped.

Set `DEVSPEC_DEBUG_REMOTE=1` to append privacy-safe runtime diagnostics to
`devspec-remote-debug.log` under the platform's `os.tmpdir()`. Each settled bonded
run writes a `context budget` event containing numeric character/count attribution:
static system/tool footprint, context-file and skill counts/sizes, tail-injected
attach/room/recall/nudge sizes, and model-visible DevSpec result sizes by a fixed
generated verb allowlist. It never records prompt text, instruction bodies,
context-file/skill contents, tool arguments, result bodies, credentials, or
provider payloads. The same aggregate rides the existing `agent_stats` report;
`ctx.getContextUsage()` remains the authoritative overall token/window reading.

## Relationship to other DevSpec plugins

Independent implementation, per the plugin-independence ADR
(`b98a39a9`). What binds all DevSpec plugins is the canonical contract served
at `devspec://product/remote-ingress-contract` and the MCP tool surface — never
shared files.
