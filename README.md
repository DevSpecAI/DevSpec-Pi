# DevSpec Pi

The native DevSpec experience for the [Pi](https://pi.dev) coding agent.

```bash
npm install -g @earendil-works/pi-coding-agent
pi install npm:@devspec/pi-plugin
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
On npm as `@devspec/pi-plugin` (keyword `pi-package`).

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

## Development

```bash
npm install
npm run check                 # typecheck + full tests + deterministic context benchmark
npm run benchmark:context     # print the current prefix/result budget baseline

# Dogfood against staging (dev Clerk/Supabase) without installing:
export DEVSPEC_ENV=staging                 # or DEVSPEC_MCP_URL=https://api.devspecstaging.com/api/mcp
export DEVSPEC_MCP_TOKEN=<from https://app.devspecstaging.com/settings/connections>
pi -e ./extensions/devspec-auth.ts -e ./extensions/devspec-tools.ts
```

Production (`https://api.devspec.ai/api/mcp`) is the default when no override is set.

### Regression and context-budget workflow

GitHub Actions runs `npm run check` on every pull request and push to `main`.
The suite enforces the 2–8k-token initial DevSpec surface, measured one-tool plan
activation delta, per-family model-visible result budgets, lossless exact reads,
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
