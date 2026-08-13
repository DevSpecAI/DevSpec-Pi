import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SeenOwnerCommands,
	sendModeAtSendTime,
	shouldCompleteSync,
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
	assert.equal(seen.has("m-new"), true);
});

test("duplicate command ids are not delivered twice", () => {
	const seen = new SeenOwnerCommands();
	const first = seen.takeUnseen([{ text: "hi", id: "m1" }]);
	const second = seen.takeUnseen([{ text: "hi", id: "m1" }]);
	assert.equal(first.length, 1);
	assert.equal(second.length, 0);
});

test("sendMode is never now when not idle", () => {
	assert.equal(sendModeAtSendTime("immediate", false), "steer");
	assert.equal(sendModeAtSendTime("immediate", true), "now");
	assert.equal(sendModeAtSendTime("preempt", false, true), "steer");
	assert.equal(sendModeAtSendTime("preempt", true, true), "now");
	assert.equal(sendModeAtSendTime("queue", false), "followUp");
	assert.equal(sendModeAtSendTime("queue", true), "followUp");
});
