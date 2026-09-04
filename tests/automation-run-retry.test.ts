import assert from "node:assert/strict";
import { test } from "node:test";
import { revalidateAutomationRunRetry } from "../extensions/core/automation-run-retry.ts";

interface AutomationRun {
	kind: "automation_run";
	run_id: string;
	revision?: string;
}

const identity = (run: AutomationRun) => run.run_id;
const run = (id: string, revision?: string): AutomationRun => ({
	kind: "automation_run",
	run_id: id,
	...(revision ? { revision } : {}),
});

test("authoritatively withdrawn automation run revokes same-key authority", async () => {
	const enqueued: AutomationRun[] = [];
	const events: string[] = [];
	const outcome = await revalidateAutomationRunRetry({
		key: "run-a",
		loadCurrentInbox: async () => ({ dispatches: [], identityComplete: true }),
		identity,
		withdrawCurrent: () => events.push("revoked"),
		enqueueCurrent: (value) => enqueued.push(value),
	});
	assert.equal(outcome, "withdrawn");
	assert.deepEqual(events, ["revoked"]);
	assert.deepEqual(enqueued, []);
});

test("retry uses the current exact automation envelope, never captured authority", async () => {
	const captured = run("run-a", "captured-before-failure");
	const current = run("run-a", "current-server-authority");
	const enqueued: AutomationRun[] = [];
	const outcome = await revalidateAutomationRunRetry({
		key: captured.run_id,
		loadCurrentInbox: async () => ({ dispatches: [current], identityComplete: true }),
		identity,
		enqueueCurrent: (value) => enqueued.push(value),
	});
	assert.equal(outcome, "enqueued");
	assert.deepEqual(enqueued, [current]);
	assert.notEqual(enqueued[0], captured);
});

test("unconfirmed absence remains retryable and cannot revoke authority", async () => {
	let revoked = false;
	const outcome = await revalidateAutomationRunRetry({
		key: "run-outside-window",
		loadCurrentInbox: async () => ({ dispatches: [], identityComplete: false }),
		identity,
		withdrawCurrent: () => { revoked = true; },
		enqueueCurrent: () => assert.fail("unconfirmed absence cannot enqueue"),
	});
	assert.equal(outcome, "retry");
	assert.equal(revoked, false);
});

test("a different run cannot satisfy an exact retry", async () => {
	const enqueued: AutomationRun[] = [];
	const outcome = await revalidateAutomationRunRetry({
		key: "run-a",
		loadCurrentInbox: async () => ({ dispatches: [run("run-b")], identityComplete: false }),
		identity,
		enqueueCurrent: (value) => enqueued.push(value),
	});
	assert.equal(outcome, "retry");
	assert.deepEqual(enqueued, []);
});

test("source failure and pump revocation never enqueue", async () => {
	await assert.rejects(
		revalidateAutomationRunRetry({
			key: "run-a",
			loadCurrentInbox: async () => { throw new Error("automation source unavailable"); },
			identity,
			enqueueCurrent: () => assert.fail("failed reads cannot enqueue"),
		}),
		/source unavailable/,
	);

	let current = true;
	let enqueued = false;
	await assert.rejects(
		revalidateAutomationRunRetry({
			key: "run-a",
			loadCurrentInbox: async () => {
				current = false;
				return { dispatches: [run("run-a")], identityComplete: true };
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
