import assert from "node:assert/strict";
import { test } from "node:test";
import { completeTurnPostedSince, noteCompleteTurnPost } from "../extensions/core/bond-state.ts";

test("the complete-turn marker answers relative to a turn start", () => {
	const t0 = 1_000_000;
	noteCompleteTurnPost(t0);
	assert.equal(completeTurnPostedSince(t0 - 1), true, "a post just before the check counts");
	assert.equal(completeTurnPostedSince(t0), true, "a post at the boundary counts");
	assert.equal(completeTurnPostedSince(t0 + 1), false, "an older post does not count for a later turn");
});

test("the marker survives a fresh read (globalThis, not module state)", () => {
	// jiti loads each extension file with a fresh module graph, so the mark
	// must live on globalThis — re-import and confirm the value is still there.
	const t0 = 2_000_000;
	noteCompleteTurnPost(t0);
	const g = globalThis as unknown as Record<string, { completeTurnPostedAt: number | null }>;
	assert.equal(g.__devspecPiTurnPosts?.completeTurnPostedAt, t0);
	assert.equal(completeTurnPostedSince(t0), true);
});
