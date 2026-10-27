This file is the **wire map**, not the model surface.

Generated from the DevSpec MCP tool definitions. The embedded
client speaks these verb names on `/api/mcp`. What the model sees is the
Pi-shaped hot set in `extensions/core/model-surface.ts`.
Do not regenerate this catalog and activate the whole verb set. Every safe model
verb is registered natively, but only the small hot set (plus narrowly activated
`manage_plan` / `manage_poll` for bonded session work) is active without deferred search.

Do not edit `mcp-catalog.ts` by hand. Regenerate:

```
npm run generate:catalog
# or, from an exported tool schema file:
node scripts/generate-mcp-catalog.mjs --from /path/to/devspec-mcp-tools.json
```

The drift test (`tests/catalog-drift.test.ts`) verifies that the generated verb list stays in sync with the server schema.
