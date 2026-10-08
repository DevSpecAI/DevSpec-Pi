import assert from "node:assert/strict";
import { test } from "node:test";
import { collectModelCatalog } from "../extensions/core/model-catalog.ts";

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

test("an unavailable registry or auth read is not an empty successful catalogue", () => {
	assert.throws(() => collectModelCatalog({}), /registry unavailable/);
	assert.throws(() => collectModelCatalog({ modelRegistry: { getAvailable: () => [{ provider: "p", id: "m" }], hasConfiguredAuth: () => { throw new Error("auth unavailable"); } } }), /auth unavailable/);
	assert.deepEqual(collectModelCatalog({ modelRegistry: { getAvailable: () => [] } }).models, []);
});

test("a malformed host entry cannot silently hide part of the list", () => {
	assert.throws(() => collectModelCatalog({ modelRegistry: { getAvailable: () => [{ provider: "p" }] } }), /Invalid host model/);
});

test("collectModelCatalog preserves the full available list", () => {
	const available = Array.from({ length: 1201 }, (_, i) => ({
		provider: "p",
		id: `m${i}`,
	}));
	const snap = collectModelCatalog({
		modelRegistry: { getAvailable: () => available, hasConfiguredAuth: () => true },
	});
	assert.deepEqual(snap.models, available);
	assert.equal(snap.truncated, undefined);
});
