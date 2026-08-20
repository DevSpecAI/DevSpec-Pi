import assert from "node:assert/strict";
import { test } from "node:test";
import { isCallableModelVerb, modelFacingSurface } from "../extensions/core/model-surface.ts";
import { modelFacingCatalog } from "../extensions/devspec-tools.ts";
import {
	CATALOG_COUNTS,
	MCP_CATALOG,
	MODEL_VERB_NAMES,
	NEVER_MODEL_VERBS,
	PUMP_VERBS,
} from "../extensions/generated/mcp-catalog.ts";

test("catalog classifies the 12 pump verbs as non-model", () => {
	for (const name of PUMP_VERBS) {
		const entry = MCP_CATALOG.find((e) => e.name === name);
		assert.ok(entry, `missing pump verb ${name}`);
		assert.equal(entry.kind, "pump");
		assert.ok(!MODEL_VERB_NAMES.includes(name as (typeof MODEL_VERB_NAMES)[number]));
	}
	assert.equal(CATALOG_COUNTS.pump, PUMP_VERBS.length);
});

test("post_session_message is never a model-facing tool", () => {
	assert.ok(NEVER_MODEL_VERBS.includes("post_session_message"));
	assert.ok(!modelFacingCatalog().some((e) => e.name === "post_session_message"));
	assert.ok(!isCallableModelVerb("post_session_message"));
});

test("catalog remains the complete wire map", () => {
	const required = [
		"record_criterion_verdicts",
		"resolve_action_item_conflict",
		"get_session_transcript",
		"get_action_item_history",
		"classify_criterion",
		"verify_action_item",
	];
	for (const name of required) {
		assert.ok(MODEL_VERB_NAMES.includes(name as (typeof MODEL_VERB_NAMES)[number]), `missing wire verb ${name}`);
		assert.ok(isCallableModelVerb(name), `${name} must stay callable`);
	}
	assert.ok(modelFacingSurface().some((e) => e.name === "record_criterion_verdicts"));
	assert.ok(modelFacingSurface().some((e) => e.name === "get_session_transcript"));
	assert.ok(!modelFacingSurface().some((e) => e.name === "get_action_item_history"));
	assert.ok(!modelFacingSurface().some((e) => e.name === "classify_criterion"));
});

test("connection catalog describes playbook-only delivery with no work routing", () => {
	const transcript = MCP_CATALOG.find((entry) => entry.name === "get_session_transcript");
	const inbox = MCP_CATALOG.find((entry) => entry.name === "get_connection_dispatch");
	const register = MCP_CATALOG.find((entry) => entry.name === "register_connection");
	const poll = MCP_CATALOG.find((entry) => entry.name === "poll_connection");
	assert.ok(transcript && inbox && register && poll);
	assert.match(inbox.description, /PLAYBOOK RUNS ONLY/);
	assert.match(inbox.description, /owner-scoped/);
	assert.match(poll.description, /owner-scoped waiting playbook runs only/);
	assert.match(register.description, /never assigns? or routes?|does not assign or route/);
	const catalogText = JSON.stringify(MCP_CATALOG);
	assert.doesNotMatch(catalogText, /local_agent_dispatch|exact assignment id|ready to receive connection-native work dispatches|assignment routing hints/i);
});

test("every catalog entry has a schema and a name", () => {
	assert.ok(CATALOG_COUNTS.total >= 80);
	for (const entry of MCP_CATALOG) {
		assert.ok(entry.name.length > 0);
		assert.equal(typeof entry.inputSchema, "object");
		assert.ok(entry.inputSchema);
	}
});
