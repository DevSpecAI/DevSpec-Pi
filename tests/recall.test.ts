import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cardKey,
	extractCards,
	formatRecallBlock,
	isAgreed,
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

test("recallQuery flattens the whole prompt without cutting it", () => {
	const prompt = "line one\nline   two\n".repeat(100);
	const q = recallQuery(prompt);
	assert.ok(!q.includes("\n"));
	assert.equal(q, prompt.replace(/\s+/g, " ").trim());
});

test("extractCards handles memories/results/absent shapes", () => {
	assert.equal(extractCards({ memories: [{ id: "a" }] }).length, 1);
	assert.equal(extractCards({ results: [{ id: "b" }] }).length, 1);
	assert.equal(extractCards(null).length, 0);
});

test("unseenCards dedupes identical snapshots and caps at 4", () => {
	const cards = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, title: `t${i}` }));
	const seen = new Set([cardKey(cards[0])!]);
	const fresh = unseenCards(cards, seen);
	assert.equal(fresh.length, 4);
	assert.ok(!fresh.some((c) => c.id === "m0"));
});

test("maintenance timestamps change neither recall identity nor rendered context", () => {
	const before = { id: "memory-a", version: 2, title: "Decision", summary: "Unchanged", updated_at: "before" };
	const after = { ...before, updated_at: "after" };
	const { updated_at: _clock, ...withoutClock } = before;
	assert.equal(cardKey(before), cardKey(after));
	assert.equal(cardKey(before), cardKey(withoutClock), "optional server clocks must not affect identity");
	assert.equal(unseenCards([after], new Set([cardKey(before)!])).length, 0);
	assert.equal(formatRecallBlock([before]), formatRecallBlock([after]));
	assert.doesNotMatch(formatRecallBlock([before]), /updated_at/);
	for (const change of [
		{ id: "memory-b" }, { version: 3 }, { title: "New title" }, { summary: "New meaning" },
		{ state: "decided" }, { tags: ["permissions"] }, { confidence: 0.8 }, { readable: false },
		{ pending_proposals: [{ proposal_id: "p1" }] },
		{ unresolved_disagreements: [{ key: "pair", evidence: { raisedAt: "new assessment" } }] },
	]) assert.notEqual(cardKey(before), cardKey({ ...after, ...change }), "meaningful changes must remain visible");
});

test("formatRecallBlock says ranking is not relevance, and that what applies binds", () => {
	const out = formatRecallBlock([{ id: "abc", title: "Two-pool billing", type: "decision", summary: "x" }]);
	assert.match(out, /auto-recall/);
	assert.match(out, /does not judge that these apply, so decide which do/);
	assert.match(out, /One that applies binds the work/);
	assert.doesNotMatch(out, /BINDING/);
	assert.match(out, /\[decision\] Two-pool billing \(abc\) — x/);
	assert.match(out, /search_memories with your own query shows the rest of the ranking/);
});

// DevSpec decision a9e001e7e: automatic context is agreed-only (5a9eaa57).
test("auto-recall takes only agreed memories and says how many in discussion it left out", () => {
	const decided = { id: "d1", title: "Decided", type: "decision", state: "decided" };
	const discussing = { id: "q1", title: "Still open", type: "decision", state: "in_discussion" };
	assert.equal(isAgreed(decided), true);
	assert.equal(isAgreed(discussing), false);
	assert.equal(isAgreed({ id: "x", title: "No state" }), false);
	const out = formatRecallBlock([decided], 1);
	assert.match(out, /1 more ranked memory is still in discussion and not recalled automatically/);
});

test("a recalled card keeps its state, delivery label and companions", () => {
	const card = {
		id: "m1", title: "Billing", type: "decision", summary: "s", state: "decided", version: 3,
		delivery: { label: "Decided, not yet implemented", task_id: "t1", delivering_item_dropped: false },
		companions: [{ id: "m2", title: "Pricing", kind: "memory", why: "Read together" }],
		tags: [],
	};
	const out = formatRecallBlock([card]);
	assert.match(out, /"state": "decided"/);
	assert.match(out, /Decided, not yet implemented/);
	assert.match(out, /"companions"[\s\S]*Pricing/);
	assert.match(out, /"version": 3/);
	assert.doesNotMatch(out, /"tags"/);
});
