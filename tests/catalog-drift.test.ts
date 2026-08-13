import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MCP_CATALOG, MCP_CATALOG_FINGERPRINT } from "../extensions/generated/mcp-catalog.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const V2_ROOT = resolve(HERE, "../../../devspecv2");
const DEFINITIONS = resolve(V2_ROOT, "apps/web/lib/mcp/tool-definitions.ts");

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
	let raw: string;
	try {
		raw = execFileSync("npx", ["tsx", "-e", script], {
			cwd: V2_ROOT,
			encoding: "utf8",
			maxBuffer: 20 * 1024 * 1024,
		});
	} catch (err) {
		t.skip(`could not dump sibling tool surface: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
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
