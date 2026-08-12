# DevSpec Pi

The native DevSpec experience for the [Pi](https://pi.dev) coding agent.

```bash
npm install -g @earendil-works/pi-coding-agent
pi install npm:@devspec/pi-plugin
pi   # /devspec.login and you're in
```

One package: native tools, native auth, native remote control, native memory.
No MCP adapter, no hook scripts, no other packages required.

**Read [VISION.md](./VISION.md) first** — it is the founding design document
and binds all implementation decisions in this repo.

## Status

Pre-implementation. See the phasing plan in VISION.md.

## Relationship to other DevSpec plugins

Independent implementation, per the plugin-independence ADR
(`b98a39a9`). What binds all DevSpec plugins is the remote-control contract
and the MCP tool surface — never shared files.
