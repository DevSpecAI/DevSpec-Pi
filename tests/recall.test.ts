import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractCards,
	formatRecallBlock,
	recallQuery,
	shouldRecall,
	unseenCards,
} from "../extensions/core/recall.ts";

test("shouldRecall skips trivial prompts and slash commands", () => {
	assert.equal(shouldRecall("ok"), false);
	assert.equal(shouldRecall("yes do it"), false);
	assert.equal(shouldRecall("/devspec.work e10f3ad1 — work this item please"), false);
	assert.equal(shouldRecall("how should we structure the webhook retry logic for failed deliveries?"), true);
});

test("recallQuery flattens and caps the prompt", () => {
	const q = recallQuery("line one\nline   two\n".repeat(100));
	assert.ok(!q.includes("\n"));
	assert.ok(q.length <= 500);
});

test("extractCards handles memories/results/absent shapes", () => {
	assert.equal(extractCards({ memories: [{ id: "a" }] }).length, 1);
	assert.equal(extractCards({ results: [{ id: "b" }] }).length, 1);
	assert.equal(extractCards(null).length, 0);
});

test("unseenCards dedupes by id and caps at 4", () => {
	const cards = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, title: `t${i}` }));
	const seen = new Set(["m0"]);
	const fresh = unseenCards(cards, seen);
	assert.equal(fresh.length, 4);
	assert.ok(!fresh.some((c) => c.id === "m0"));
});

test("formatRecallBlock marks binding semantics", () => {
	const out = formatRecallBlock([{ id: "abc", title: "Two-pool billing", type: "decision", summary: "x" }]);
	assert.match(out, /auto-recall/);
	assert.match(out, /BINDING/);
	assert.match(out, /\[decision\] Two-pool billing \(abc\) — x/);
});
