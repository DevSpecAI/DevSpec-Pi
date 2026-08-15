import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MCP_CATALOG, MCP_CATALOG_FINGERPRINT } from "../extensions/generated/mcp-catalog.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const EXPLICIT_V2_ROOT = process.env.DEVSPEC_V2_ROOT?.trim() || null;
const DEFAULT_V2_ROOTS = [
	resolve(HERE, "../../devspecv2"),
	resolve(HERE, "../../../devspecv2"),
];
const V2_ROOT = EXPLICIT_V2_ROOT
	? resolve(EXPLICIT_V2_ROOT)
	: DEFAULT_V2_ROOTS.find((candidate) => existsSync(resolve(candidate, "apps/web/lib/mcp/tool-definitions.ts")))
		?? DEFAULT_V2_ROOTS[0]!;
const DEFINITIONS = resolve(V2_ROOT, "apps/web/lib/mcp/tool-definitions.ts");
const TSX_BIN = resolve(V2_ROOT, "node_modules/.bin/tsx");

function fingerprint(tools: Array<{ name: string; inputSchema: unknown }>): string {
	const h = createHash("sha256");
	for (const t of tools) {
		h.update(t.name);
		h.update("\0");
		h.update(JSON.stringify(t.inputSchema ?? {}));
		h.update("\n");
	}
	return h.digest("hex");
}

test("checked-in catalog matches the sibling DevSpecV2 verb surface when present", (t) => {
	if (!existsSync(DEFINITIONS)) {
		if (EXPLICIT_V2_ROOT) assert.fail(`DEVSPEC_V2_ROOT was supplied but tool definitions are missing: ${DEFINITIONS}`);
		t.skip("sibling DevSpecV2 checkout not present — CI without the pair is allowed");
		return;
	}
	const script = `
import { getMcpAllTools } from ${JSON.stringify(DEFINITIONS)};
const tools = getMcpAllTools();
process.stdout.write(JSON.stringify(tools.map((t) => ({
  name: t.name,
  inputSchema: t.inputSchema ?? { type: "object", properties: {} },
}))));
`;
	assert.ok(existsSync(TSX_BIN), `paired DevSpecV2 checkout is missing its local tsx binary: ${TSX_BIN}`);
	const raw = execFileSync(TSX_BIN, ["--tsconfig=apps/web/tsconfig.json", "-e", script], {
		cwd: V2_ROOT,
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
	});
	const live = JSON.parse(raw) as Array<{ name: string; inputSchema: unknown }>;
	const liveNames = live.map((t) => t.name).sort();
	const catalogNames = MCP_CATALOG.map((t) => t.name).sort();
	assert.deepEqual(
		catalogNames,
		liveNames,
		"extensions/generated/mcp-catalog.ts is stale — run node scripts/generate-mcp-catalog.mjs --devspec-v2 <path>",
	);
	assert.equal(fingerprint(live), MCP_CATALOG_FINGERPRINT);
});
