import assert from "node:assert/strict";
import { test } from "node:test";
import { revalidateDispatchRetry } from "../extensions/core/dispatch-retry.ts";

interface Dispatch {
	id: string;
	revision?: string;
}

const identity = (dispatch: Dispatch) => dispatch.id;

test("authoritatively withdrawn work revokes same-key authority before returning", async () => {
	const enqueued: Dispatch[] = [];
	const events: string[] = [];
	const outcome = await revalidateDispatchRetry({
		key: "assignment-a",
		loadCurrentInbox: async () => ({ dispatches: [], identityComplete: true }),
		identity,
		withdrawCurrent: () => events.push("revoked"),
		enqueueCurrent: (dispatch) => enqueued.push(dispatch),
	});
	assert.equal(outcome, "withdrawn");
	assert.deepEqual(events, ["revoked"]);
	assert.deepEqual(enqueued, [], "withdrawn work must produce no delivery side effect");
});

test("retry uses the current exact inbox envelope rather than captured authority", async () => {
	const captured = { id: "assignment-a", revision: "captured-before-failure" };
	const current = { id: "assignment-a", revision: "current-server-authority" };
	const enqueued: Dispatch[] = [];
	const outcome = await revalidateDispatchRetry({
		key: captured.id,
		loadCurrentInbox: async () => ({ dispatches: [current], identityComplete: true }),
		identity,
		enqueueCurrent: (dispatch) => enqueued.push(dispatch),
	});
	assert.equal(outcome, "enqueued");
	assert.deepEqual(enqueued, [current]);
	assert.notEqual(enqueued[0], captured);
});

test("absence from a legacy, bounded, or partial inbox remains retryable", async () => {
	let revoked = false;
	const outcome = await revalidateDispatchRetry({
		key: "assignment-outside-window",
		loadCurrentInbox: async () => ({ dispatches: [], identityComplete: false }),
		identity,
		withdrawCurrent: () => { revoked = true; },
		enqueueCurrent: () => assert.fail("unconfirmed absence cannot enqueue"),
	});
	assert.equal(outcome, "retry");
	assert.equal(revoked, false, "partial absence cannot revoke live preparation");
});

test("a different current identity cannot satisfy an exact retry", async () => {
	const enqueued: Dispatch[] = [];
	const outcome = await revalidateDispatchRetry({
		key: "assignment-a",
		loadCurrentInbox: async () => ({ dispatches: [{ id: "assignment-b" }], identityComplete: false }),
		identity,
		enqueueCurrent: (dispatch) => enqueued.push(dispatch),
	});
	assert.equal(outcome, "retry");
	assert.deepEqual(enqueued, []);
});

test("an exact inbox source failure preserves retry through rejection", async () => {
	await assert.rejects(
		revalidateDispatchRetry({
			key: "assignment-a",
			loadCurrentInbox: async () => { throw new Error("assignment source unavailable"); },
			identity,
			enqueueCurrent: () => assert.fail("failed reads cannot enqueue"),
		}),
		/source unavailable/,
	);
});

test("authority revocation after inbox loading prevents enqueue", async () => {
	let current = true;
	let enqueued = false;
	await assert.rejects(
		revalidateDispatchRetry({
			key: "assignment-a",
			loadCurrentInbox: async () => {
				current = false;
				return { dispatches: [{ id: "assignment-a" }], identityComplete: true };
			},
			identity,
			assertCurrent: () => {
				if (!current) throw new Error("stale pump");
			},
			enqueueCurrent: () => { enqueued = true; },
		}),
		/stale pump/,
	);
	assert.equal(enqueued, false);
});
