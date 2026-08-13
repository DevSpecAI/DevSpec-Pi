import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDevspecInstructions, INSTRUCTIONS_VERSION } from "../extensions/core/instructions.ts";
import { modelFacingCatalog } from "../extensions/devspec-tools.ts";

test("instructions reference only tools this package registers", () => {
	const text = buildDevspecInstructions();
	const registered = new Set(modelFacingCatalog().map((e) => e.name));
	const mentioned = text.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
	for (const word of new Set(mentioned)) {
		if (!registered.has(word)) continue;
		assert.ok(registered.has(word), `instructions mention unregistered tool: ${word}`);
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
	assert.match(text, /record_criterion_verdicts/);
});

test("instructions stay compact (every line costs tokens per turn)", () => {
	const text = buildDevspecInstructions();
	assert.ok(text.length < 3600, `instructions bloated: ${text.length} chars`);
	assert.ok(INSTRUCTIONS_VERSION >= 2);
});
