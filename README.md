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
/ `/devspec.status`. Everyday DevSpec work is a small native hot set; less-common
verbs go through one `devspec` gateway. The generated MCP catalog is the wire
map, not what the model sees. See VISION.md.

## Development

```bash
npm install
npm run typecheck
npm test

# Dogfood against staging (dev Clerk/Supabase) without installing:
export DEVSPEC_ENV=staging                 # or DEVSPEC_MCP_URL=https://staging.devspec.ai/api/mcp
export DEVSPEC_MCP_TOKEN=<from https://staging.devspec.ai/settings/connections>
pi -e ./extensions/devspec-auth.ts -e ./extensions/devspec-tools.ts
```

Production (`devspec.ai`) is the default when no override is set.

## Relationship to other DevSpec plugins

Independent implementation, per the plugin-independence ADR
(`b98a39a9`). What binds all DevSpec plugins is the remote-control contract
and the MCP tool surface — never shared files.
