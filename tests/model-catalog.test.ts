import assert from "node:assert/strict";
import { test } from "node:test";
import { collectModelCatalog, MODEL_CATALOG_MAX } from "../extensions/core/model-catalog.ts";

test("collectModelCatalog prefers scopedModels over the full registry", () => {
	const snap = collectModelCatalog({
		scopedModels: [
			{ model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" } },
		],
		modelRegistry: {
			getAvailable: () => [
				{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" },
				{ provider: "openai", id: "gpt-5", name: "GPT-5" },
			],
			hasConfiguredAuth: () => true,
		},
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		now: "2026-08-13T22:00:00.000Z",
	});
	assert.equal(snap.v, 1);
	assert.equal(snap.current, "anthropic/claude-sonnet-4-5");
	assert.deepEqual(snap.models, [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet" }]);
	assert.equal(snap.truncated, undefined);
});

test("collectModelCatalog drops models this process cannot call", () => {
	const snap = collectModelCatalog({
		modelRegistry: {
			getAvailable: () => [
				{ provider: "anthropic", id: "claude-sonnet-4-5" },
				{ provider: "openai", id: "gpt-5" },
			],
			hasConfiguredAuth: (m) => m.provider === "anthropic",
		},
		now: "2026-08-13T22:00:00.000Z",
	});
	assert.deepEqual(snap.models, [{ provider: "anthropic", id: "claude-sonnet-4-5" }]);
});

test("collectModelCatalog caps the stored list and marks truncated", () => {
	const available = Array.from({ length: MODEL_CATALOG_MAX + 3 }, (_, i) => ({
		provider: "p",
		id: `m${i}`,
	}));
	const snap = collectModelCatalog({
		modelRegistry: { getAvailable: () => available, hasConfiguredAuth: () => true },
	});
	assert.equal(snap.models.length, MODEL_CATALOG_MAX);
	assert.equal(snap.truncated, true);
});
