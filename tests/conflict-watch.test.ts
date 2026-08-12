import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addFlags,
	clearAllFlags,
	extractFlags,
	formatConflictNudge,
	listFlags,
} from "../extensions/core/conflict-watch.ts";

test("extractFlags finds unresolved item conflicts", () => {
	const flags = extractFlags("get_action_item", {
		unresolved_conflicts: [{ conflicting_item_id: "abcdef12-3456", reason: "overlapping change" }],
	});
	assert.equal(flags.length, 1);
	assert.equal(flags[0].kind, "item_conflict");
	assert.match(flags[0].label, /…f12-3456/);
	assert.match(flags[0].label, /overlapping change/);
});

test("extractFlags finds the memory recall gate and potential conflicts", () => {
	const flags = extractFlags("record_memory", {
		reconcile_required: true,
		closest_match: { id: "mem-99998888" },
		potential_conflicts: [{ id: "mem-11112222" }],
	});
	assert.deepEqual(flags.map((f) => f.kind).sort(), ["memory_conflict", "memory_reconcile"]);
});

test("related_candidates only flag from create_action_item", () => {
	const payload = { related_candidates: [{ id: "item-12345678" }] };
	assert.equal(extractFlags("create_action_item", payload).length, 1);
	assert.equal(extractFlags("search_action_items", payload).length, 0);
});

test("store dedupes by key; nudge formats and clears", () => {
	clearAllFlags();
	const flags = extractFlags("record_memory", { reconcile_required: true, closest_match: { id: "m-1" } });
	addFlags(flags);
	addFlags(flags); // again — no dupes
	assert.equal(listFlags().length, 1);
	const nudge = formatConflictNudge(listFlags());
	assert.match(nudge ?? "", /1 open signal/);
	assert.match(nudge ?? "", /supersede/);
	clearAllFlags();
	assert.equal(formatConflictNudge(listFlags()), null);
});
