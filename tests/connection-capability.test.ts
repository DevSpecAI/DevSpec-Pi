import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionCapabilityFromResult, setBond } from "../extensions/core/bond-state.ts";
import { readFileSync } from "node:fs";

const CAPABILITY = `dvsc_${"A".repeat(43)}`;

test("connection capability is accepted only from negotiated hidden MCP metadata", () => {
	const raw = {
		content: [{ type: "text", text: JSON.stringify({ connection_id: "public", connection_capability_version: 1 }) }],
		_meta: { devspec: { connection_capability: { version: 1, value: CAPABILITY } } },
	};
	assert.equal(connectionCapabilityFromResult(raw), CAPABILITY);
	assert.equal(connectionCapabilityFromResult({ ...raw, _meta: undefined }), undefined);
	assert.equal(connectionCapabilityFromResult({ ...raw, _meta: { devspec: { connection_capability: { version: 2, value: CAPABILITY } } } }), undefined);
	assert.equal(connectionCapabilityFromResult({ ...raw, _meta: { devspec: { connection_capability: { version: 1, value: "connection-id" } } } }), undefined);
});

test("native manage_plan sends no model-authored identity and stamps capability only as a transport header", () => {
	const tools = readFileSync(new URL("../extensions/devspec-tools.ts", import.meta.url), "utf8");
	const client = readFileSync(new URL("../extensions/core/client.ts", import.meta.url), "utf8");
	const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
	assert.match(remote, /connection_capability_version: 1/);
	assert.match(remote, /connectionCapabilityFromResult\(regRaw\)/);
	assert.match(tools, /name === PLAN_TOOL_NAME && bond\?\.connectionCapability/);
	assert.match(tools, /stampKnownScope\(params, name\)/);
	assert.match(client, /"x-devspec-connection-capability": connectionCapability/);
	assert.doesNotMatch(tools, /connection_capability\s*:/);
	assert.doesNotMatch(client, /arguments:[^\n]*connectionCapability/);
	setBond(null);
});
