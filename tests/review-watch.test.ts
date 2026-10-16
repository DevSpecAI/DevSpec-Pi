import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addFlags,
	clearAllFlags,
	extractFlags,
	formatReviewNudge,
	listFlags,
} from "../extensions/core/review-watch.ts";

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
	assert.equal(flags[0].kind, "review_issue");
	assert.equal(flags[0].subject, "mem-12345678");
	assert.equal(flags[0].counterpart, undefined);
	assert.equal(flags[0].signal, "possibly_stale");
	assert.match(flags[0].label, /get_review_queue/);
	assert.doesNotMatch(flags[0].label, /the code it describes changed/, "watches re-fetch prose instead of caching permission-sensitive evidence");
});

// DevSpec finds duplicates with its own check after the write and returns no
// candidate list (fce58a2f round 2), so a create is never an observation.
test("a create result is never a review observation", () => {
	assert.equal(extractFlags("create_action_item", { id: "item-1", title: "New item", outcome: "committed" }).length, 0);
});

test("store dedupes by key; nudge formats and clears", () => {
	clearAllFlags();
	const flags = extractFlags("get_memory", { id: "mem-1", unresolved_disagreements: [{ key: "possibly_stale|memory:mem-1", claimType: "possibly_stale",
		status: "open", issueId: null, subject: { type: "memory", id: "mem-1", title: "Billing pools", readable: true }, counterpart: null,
		evidence: { reason: "the code it describes changed" } }] }, "legacy");
	addFlags(flags);
	addFlags(flags); // again — no dupes
	assert.equal(listFlags().length, 1);
	const nudge = formatReviewNudge(listFlags());
	assert.match(nudge ?? "", /1 unresolved issue observation\(s\)\. These are observations/);
	assert.match(nudge ?? "", /served authority contract/);
	clearAllFlags();
	assert.equal(formatReviewNudge(listFlags()), null);
});
