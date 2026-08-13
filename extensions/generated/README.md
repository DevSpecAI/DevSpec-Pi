This file is the **wire map**, not the model surface.

Generated from DevSpecV2 `apps/web/lib/mcp/tool-definitions.ts`. The embedded
client speaks these verb names on `/api/mcp`. What the model sees is the
Pi-shaped hot set in `extensions/core/model-surface.ts` (item `7de79db6`).
Do not regenerate this catalog and register all 76 verbs again.

Do not edit `mcp-catalog.ts` by hand. Regenerate:

```
npm run generate:catalog
# or, without a sibling checkout:
node scripts/generate-mcp-catalog.mjs --from /path/to/devspec-mcp-tools.json
```

The drift test (`tests/catalog-drift.test.ts`) fails when a sibling DevSpecV2 checkout's verb list no longer matches this file.
