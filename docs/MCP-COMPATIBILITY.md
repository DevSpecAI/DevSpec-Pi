# MCP compatibility and release qualification

Requires Pi 1.0+ and Node.js 22.19+. Development and CI qualify against Pi 1.1; 1.0.x hosts remain accepted because 1.1 adds only optional fields and flags this plugin does not read. DevSpec supplies native tools and its own authenticated connection. No MCP adapter is required. Use Pi’s `/mcp` for other services; an existing `pi-mcp-adapter` installation is optional (qualified against 4.0).

## Configuration ownership

- Stock Pi reads its user `mcp.json` and trusted project `.pi/mcp.json`. It does not import Claude’s `.mcp.json` or plugin settings. A Claude-first install therefore needs no shared-file rewrite.
- Native duplicate entries are disabled in their effective Pi-owned source with `enabled: false`. A project definition replaces a same-name user definition. Credentials and unrelated fields stay in place.
- With the adapter loaded, its **public** `pi-mcp-adapter/config` export resolves imports, overrides and custom paths. Its writer persists only the duplicate-disable field in `.pi/mcp-adapter.json`; shared files are never rewritten. The result is read back rather than assuming the write affected the effective configuration.
- A server’s URL identifies a duplicate, not the name `devspec`. Tool suppression also checks the owning extension so a foreign server in another loader is not disabled just because its name matches.
- Pi’s public `session_start` runs the guard after project trust and before the default built-in MCP extension starts. An adapter loaded earlier may have cached tools or an existing connection on the migration run: its resolved-tool approval event denies duplicate calls, while declared duplicate tools are removed from the active set. Reload after updating to refresh its cached declarations/connections. This is duplicate protection, not a sandbox against arbitrary extensions or filesystem edits.

## Conservative legacy migration

Recognized sparse entries containing only adapter `disabled` and/or `protocolVersion` fields move from Pi’s `mcp.json` to the adjacent `mcp-adapter.json`. Full server definitions are not guessed to be adapter configurations. Migration validates source and destination, refuses conflicts and symlinked files, preserves other fields, makes a private backup, writes the destination before removing source entries, and is idempotent. Files that require review produce a warning, not an all-clear. Do not broaden project trust to perform migration.

An adapter’s exclusive/in-memory setup that does not apply file overrides is not reported as successfully suppressed. Use one loader per service. The native DevSpec plugin never becomes an additional externally mounted DevSpec server.

## Checks before release

```sh
npm run check
node scripts/e2e-pi1-mcp.mjs
PI_MCP_ADAPTER_ENTRY=/path/to/pi-mcp-adapter/index.ts node scripts/e2e-pi1-mcp.mjs
python3 scripts/e2e-mcp-guidance.py
npm audit --omit=dev
npm run audit:gate
npm pack --dry-run --ignore-scripts
```

`npm audit --omit=dev` covers what customers install. `npm run audit:gate` (also run by CI) covers the whole tree, development dependencies included, and fails on any high or critical advisory not triaged in `scripts/audit-allowlist.json` with a reason and an unexpired expiry.

The host fixture creates disposable homes and projects, uses a loopback MCP service, and makes no model calls. It checks fresh/Claude-first, native duplicate plus foreign discovery, untrusted project, legacy migration and an optional actual-adapter tool call. The PTY check covers quiet repeated starts and the first-change notice. Unit cases cover malformed/conflicting files, same-name precedence, credentials and idempotence.

To repeat host qualification against an installed tarball, set `DEVSPEC_PI_TEST_ROOT` to the installed package directory. This loads the whole package rather than only the guard and checks that native DevSpec tools are registered. Do not use real account credentials in these fixtures.

Public npm publication remains a separate, coordinated release. Keep the documented pre-release route honest; switch the customer install command to `pi install npm:@devspec/pi-plugin` only after publication and verification of a clean host-managed install. Source, tarball and running-host verification are distinct checks. A running Pi process needs `/reload` or a restart to load updated extension code.
