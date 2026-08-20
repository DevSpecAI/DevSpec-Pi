import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SeenOwnerCommands,
	resolveAttachedAtMs,
	sendModeAtSendTime,
	shouldCompleteSync,
	splitCatchUpCommands,
} from "../extensions/core/owner-inject.ts";

test("shouldCompleteSync waits for a cursor or historical commands", () => {
	assert.equal(shouldCompleteSync({ ownerCommands: [] }), false);
	assert.equal(shouldCompleteSync({ cursor: "cur-1", ownerCommands: [] }), true);
	assert.equal(
		shouldCompleteSync({ ownerCommands: [{ text: "old", id: "m1" }] }),
		true,
	);
});

test("sync-lap commands are recorded and skipped later", () => {
	const seen = new SeenOwnerCommands();
	seen.remember([{ text: "already answered", id: "m-old", userName: "Ali" }]);
	const next = seen.takeUnseen([
		{ text: "already answered", id: "m-old", userName: "Ali" },
		{ text: "new instruction", id: "m-new", userName: "Ali" },
	]);
	assert.deepEqual(next.map((c) => c.id), ["m-new"]);
	assert.equal(seen.has("m-old"), true);
	assert.equal(seen.has("m-new"), false, "reservation is not replay commitment");
	assert.equal(seen.isInFlight("m-new"), true);
	seen.commit(next[0]);
	assert.equal(seen.has("m-new"), true);
});

test("in-flight commands cannot duplicate, while failed delivery can retry transactionally", () => {
	const seen = new SeenOwnerCommands();
	const command = { text: "hi", id: "m1" };
	const first = seen.takeUnseen([command]);
	const duplicateWhileInflight = seen.takeUnseen([command]);
	assert.equal(first.length, 1);
	assert.equal(duplicateWhileInflight.length, 0);
	seen.release(command);
	assert.deepEqual(seen.takeUnseen([command]).map((item) => item.id), ["m1"]);
	seen.commit(command);
	assert.equal(seen.takeUnseen([command]).length, 0);
});

test("multi-command reservation, rollback, and commit are all-or-none", () => {
	const seen = new SeenOwnerCommands();
	const bundle = [{ id: "m1" }, { id: "m2" }];
	assert.equal(seen.reserveBundle(bundle), "reserved");
	assert.equal(seen.reserveBundle(bundle), "conflict");
	seen.releaseBundle(bundle);
	assert.equal(seen.reserveBundle(bundle), "reserved", "failed send releases every id");
	seen.commitBundle(bundle);
	assert.equal(seen.has("m1"), true);
	assert.equal(seen.has("m2"), true);
	assert.equal(seen.reserveBundle(bundle), "seen");
	assert.equal(seen.reserveBundle([{ id: "m2" }, { id: "m3" }]), "conflict", "mixed replay/live bundles fail closed");
});

test("sendMode is never now when not idle", () => {
	assert.equal(sendModeAtSendTime("immediate", false), "steer");
	assert.equal(sendModeAtSendTime("immediate", true), "now");
	assert.equal(sendModeAtSendTime("preempt", false, true), "steer");
	assert.equal(sendModeAtSendTime("preempt", true, true), "now");
	assert.equal(sendModeAtSendTime("queue", false), "followUp");
	assert.equal(sendModeAtSendTime("queue", true), "followUp");
});

const ATTACHED = Date.parse("2026-08-13T14:02:53.420Z");

test("splitCatchUpCommands skips pre-attach history and delivers live first-touch", () => {
	const { historical, live } = splitCatchUpCommands(
		[
			{ id: "old", text: "already answered", createdAt: "2026-08-13T13:53:41.965Z" },
			{ id: "live", text: "can you pick up from here?", createdAt: "2026-08-13T14:02:55.257Z" },
			{ id: "same-instant", text: "at attach", createdAt: "2026-08-13T14:02:53.420Z" },
		],
		ATTACHED,
	);
	assert.deepEqual(historical.map((c) => c.id), ["old"]);
	assert.deepEqual(live.map((c) => c.id), ["live", "same-instant"]);
});

test("splitCatchUpCommands treats missing created_at as live", () => {
	const { historical, live } = splitCatchUpCommands(
		[
			{ id: "old", text: "history", createdAt: "2026-08-13T13:00:00.000Z" },
			{ id: "nots", text: "no timestamp" },
			{ id: "bad", text: "unparseable", createdAt: "not-a-date" },
		],
		ATTACHED,
	);
	assert.deepEqual(historical.map((c) => c.id), ["old"]);
	assert.deepEqual(live.map((c) => c.id), ["nots", "bad"]);
});

test("historical sync-lap ids stay skipped; live ids are still deliverable", () => {
	const seen = new SeenOwnerCommands();
	const split = splitCatchUpCommands(
		[
			{ id: "old", text: "already answered", createdAt: "2026-08-13T13:53:41.965Z" },
			{ id: "live", text: "can you pick up from here?", createdAt: "2026-08-13T14:02:55.257Z" },
		],
		ATTACHED,
	);
	seen.remember(split.historical);
	const delivered = seen.takeUnseen(split.live);
	assert.deepEqual(delivered.map((c) => c.id), ["live"]);
	seen.commit(delivered[0]);
	assert.equal(seen.has("old"), true);
	assert.deepEqual(
		seen.takeUnseen([{ id: "old", text: "already answered" }]).map((c) => c.id),
		[],
	);
});

test("resolveAttachedAtMs prefers a parseable server stamp", () => {
	assert.equal(resolveAttachedAtMs("2026-08-13T14:02:53.420Z", 1), ATTACHED);
	assert.equal(resolveAttachedAtMs("nope", 42), 42);
	assert.equal(resolveAttachedAtMs(undefined, 42), 42);
});
