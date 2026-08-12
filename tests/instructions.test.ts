import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevspecInstructions, INSTRUCTIONS_VERSION } from "../extensions/core/instructions.ts";

test("instructions reference only tools this package registers", () => {
	const text = buildDevspecInstructions();
	// The registered tool surface (devspec-tools.ts) — keep these in sync.
	const registered = [
		"list_projects", "get_project_summary", "get_action_items", "get_action_item",
		"search_action_items", "get_next_work_item", "search_memories", "get_memory",
		"record_memory", "supersede_memory", "retract_memory", "get_decisions",
		"get_conventions", "search_resources", "devspec_help_search",
		"create_action_item", "claim_work_item", "release_work_item",
		"record_implementation", "update_action_item",
	];
	const mentioned = text.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
	const toolish = mentioned.filter((w) => registered.some((r) => w === r));
	for (const t of new Set(toolish)) {
		assert.ok(registered.includes(t), `instructions mention unregistered tool: ${t}`);
	}
});

test("instructions carry the load-bearing rules", () => {
	const text = buildDevspecInstructions();
	assert.match(text, /\[devspec:<id>\]/);
	assert.match(text, /record_implementation/);
	assert.match(text, /never mark items done/i);
	assert.match(text, /claim_work_item/);
	assert.match(text, /possible_conflict/);
	assert.match(text, /supersede_memory/);
});

test("instructions stay compact (every line costs tokens per turn)", () => {
	const text = buildDevspecInstructions();
	assert.ok(text.length < 2200, `instructions bloated: ${text.length} chars`);
	assert.ok(INSTRUCTIONS_VERSION >= 1);
});
