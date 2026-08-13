import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CATALOG_COUNTS,
	MCP_CATALOG,
	MODEL_VERB_NAMES,
	NEVER_MODEL_VERBS,
	PUMP_VERBS,
} from "../extensions/generated/mcp-catalog.ts";
import { modelFacingCatalog } from "../extensions/devspec-tools.ts";
import { buildDevspecInstructions } from "../extensions/core/instructions.ts";

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
});

test("previously gateway-only verbs are native model tools", () => {
	const required = [
		"record_criterion_verdicts",
		"resolve_action_item_conflict",
		"get_session_transcript",
		"get_action_item_history",
		"classify_criterion",
		"verify_action_item",
	];
	const native = new Set(modelFacingCatalog().map((e) => e.name));
	for (const name of required) {
		assert.ok(native.has(name), `missing native verb ${name}`);
	}
});

test("every catalog entry has a schema and a name", () => {
	assert.ok(CATALOG_COUNTS.total >= 80);
	for (const entry of MCP_CATALOG) {
		assert.ok(entry.name.length > 0);
		assert.equal(typeof entry.inputSchema, "object");
		assert.ok(entry.inputSchema);
	}
});

test("instructions mention only model-facing verbs", () => {
	const text = buildDevspecInstructions();
	const registered = new Set(modelFacingCatalog().map((e) => e.name));
	const mentioned = text.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
	for (const word of new Set(mentioned)) {
		if (!registered.has(word)) continue;
		assert.ok(registered.has(word), `instructions mention unregistered tool: ${word}`);
		assert.ok(!PUMP_VERBS.includes(word as (typeof PUMP_VERBS)[number]), `instructions leaked pump verb ${word}`);
		assert.ok(word !== "post_session_message", "instructions must not mention post_session_message");
	}
	assert.match(text, /record_criterion_verdicts/);
	assert.match(text, /resolve_action_item_conflict/);
	assert.match(text, /get_session_transcript/);
	assert.match(text, /never describe→call/);
});
