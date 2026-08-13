import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevspecInstructions, INSTRUCTIONS_VERSION } from "../extensions/core/instructions.ts";
import { GATEWAY_TOOL_NAME, HOT_SET, rareModelVerbs } from "../extensions/core/model-surface.ts";
import { modelFacingCatalog } from "../extensions/devspec-tools.ts";
import { PUMP_VERBS } from "../extensions/generated/mcp-catalog.ts";

test("instructions reference only tools this package registers", () => {
	const text = buildDevspecInstructions();
	const registered = new Set(modelFacingCatalog().map((e) => e.name));
	registered.add(GATEWAY_TOOL_NAME);
	const mentioned = text.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
	for (const word of new Set(mentioned)) {
		if (word === GATEWAY_TOOL_NAME) continue;
		if (!HOT_SET.has(word) && !rareModelVerbs().includes(word)) continue;
		assert.ok(
			registered.has(word),
			`instructions mention a rare/unregistered tool as if it were always-on: ${word}`,
		);
	}
});

test("instructions carry the load-bearing rules", () => {
	const text = buildDevspecInstructions();
	assert.match(text, /\[devspec:<id>\]/);
	assert.match(text, /record_implementation/);
	assert.match(text, /never mark items done/i);
	assert.match(text, /claim_work_item/);
	assert.match(text, /possible_conflict/);
	assert.match(text, /record_memory/);
	assert.match(text, /git_remote/);
	assert.match(text, /extension already knows/i);
});

test("instructions do not dump search-first or the 76-verb map", () => {
	const text = buildDevspecInstructions();
	assert.doesNotMatch(text, /Check DevSpec first/);
	assert.doesNotMatch(text, /When X, call Y/);
	assert.doesNotMatch(text, /never describe→call/);
	assert.doesNotMatch(text, /search_action_items/);
	assert.doesNotMatch(text, /search_resources/);
	assert.doesNotMatch(text, /get_action_items/);
	assert.doesNotMatch(text, /record_criterion_verdicts/);
	assert.doesNotMatch(text, /get_session_transcript/);
	for (const pump of PUMP_VERBS) {
		assert.ok(!text.includes(pump), `instructions leaked pump verb ${pump}`);
	}
	assert.ok(!text.includes("post_session_message"));
});

test("instructions stay compact (every line costs tokens per turn)", () => {
	const text = buildDevspecInstructions();
	assert.ok(text.length < 2200, `instructions bloated: ${text.length} chars`);
	assert.ok(INSTRUCTIONS_VERSION >= 3);
});
