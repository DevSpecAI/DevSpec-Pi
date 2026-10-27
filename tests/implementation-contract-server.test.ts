import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	formatImplementationContext,
	loadImplementationContext,
	resetImplementationContractCache,
} from "../extensions/core/implementation-contract.ts";

// The implementation contract the paired DevSpecV2 checkout serves must be read and
// rendered by Pi as served: its hash checks out, no section is left unread, and the
// commit section reaches the model whole whatever clauses it gains (df71ab6c).
const here = fileURLToPath(new URL(".", import.meta.url));
const explicit = process.env.DEVSPEC_V2_ROOT?.trim();
const relative = "packages/core/src/mcp/implementation-contract.ts";
const root = explicit ? resolve(explicit) : [resolve(here, "../../devspecv2"), resolve(here, "../../../devspecv2")].find((r) => existsSync(resolve(r, relative)));

test("Pi accepts and renders the implementation contract the paired server serves", async (t) => {
	if (!root || !existsSync(resolve(root, relative))) {
		if (explicit) assert.fail("DEVSPEC_V2_ROOT does not contain the implementation contract");
		t.skip("paired server checkout unavailable; set DEVSPEC_V2_ROOT"); return;
	}
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const jiti = createJiti(resolve(root, "pi-contract-probe.mjs"), { fsCache: false, moduleCache: false, alias: { "@devspec/core": resolve(root, "packages/core/src"), "@": resolve(root, "apps/web") } });
	const server = await jiti.import(resolve(root, relative)) as { IMPLEMENTATION_CONTRACT: Record<string, unknown> };
	const served = JSON.parse(JSON.stringify(server.IMPLEMENTATION_CONTRACT)) as Record<string, unknown>;
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: { contract_version: String(served.contract_version), resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: {
			async cacheScope() { return "paired-server"; },
			async readResource() { return { contents: [{ uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI, text: JSON.stringify(served) }] }; },
			async readCompatibilityBundle() { throw new Error("not used"); },
		},
	});
	assert.equal(context.source, "resource", context.warning);
	assert.equal(context.warning, undefined);
	assert.equal(context.contractVersion, served.contract_version);
	assert.equal(context.contractHash, served.contract_hash);
	assert.equal(context.unreadSections, undefined, "every served section is one Pi reads");
	assert.deepEqual(context.commitProvenanceContract, served.commit_provenance_contract);
	const rendered = formatImplementationContext(context);
	assert.ok(rendered.includes(JSON.stringify(served.commit_provenance_contract)), "the commit section reaches the model exactly as served");
	const rules = (served.core_implementation_contract as { rules: Array<{ id: string }> }).rules;
	for (const rule of rules) assert.ok(rendered.includes(`[${rule.id}]`), rule.id);
});
