import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addFlags,
	clearAllFlags,
	extractFlags,
	formatConflictNudge,
	listFlags,
} from "../extensions/core/conflict-watch.ts";

test("extractFlags finds an out-of-date flag on a memory without caching its evidence", () => {
	const flags = extractFlags("get_memory", {
		id: "mem-12345678",
		unresolved_disagreements: [{
			key: "possibly_stale|memory:mem-12345678", claimType: "possibly_stale", status: "open", issueId: null,
			subject: { type: "memory", id: "mem-12345678", title: "Billing pools", readable: true }, counterpart: null,
			evidence: { reason: "the code it describes changed" },
		}],
	});
	assert.equal(flags.length, 1);
	assert.equal(flags[0].kind, "memory_conflict");
	assert.equal(flags[0].subject, "mem-12345678");
	assert.equal(flags[0].counterpart, undefined);
	assert.equal(flags[0].signal, "possibly_stale");
	assert.match(flags[0].label, /get_review_queue/);
	assert.doesNotMatch(flags[0].label, /the code it describes changed/, "watches re-fetch prose instead of caching permission-sensitive evidence");
});

test("related_candidates only flag from create_action_item", () => {
	const payload = { related_candidates: [{ id: "item-12345678" }] };
	assert.equal(extractFlags("create_action_item", payload).length, 1);
	assert.equal(extractFlags("search_action_items", payload).length, 0);
});

test("store dedupes by key; nudge formats and clears", () => {
	clearAllFlags();
	const flags = extractFlags("create_action_item", { id: "item-1", related_candidates: [{ id: "item-2" }] }, "legacy", { title: "New item" });
	addFlags(flags);
	addFlags(flags); // again — no dupes
	assert.equal(listFlags().length, 1);
	const nudge = formatConflictNudge(listFlags());
	assert.match(nudge ?? "", /0 unresolved issue observation\(s\); 1 retrieval suggestion set/);
	assert.match(nudge ?? "", /served authority contract/);
	clearAllFlags();
	assert.equal(formatConflictNudge(listFlags()), null);
});
