import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryQueue, nextDeliveryRetryDelayMs } from "../extensions/core/delivery-queue.ts";
import { revalidatePlaybookRunRetry } from "../extensions/core/playbook-run-retry.ts";

test("delivery retry backoff is bounded and deterministic", () => {
	assert.equal(nextDeliveryRetryDelayMs(1), 5_000);
	assert.equal(nextDeliveryRetryDelayMs(2), 10_000);
	assert.equal(nextDeliveryRetryDelayMs(5), 60_000);
	assert.equal(nextDeliveryRetryDelayMs(20), 60_000);
});

test("playbook runs remain ordered without blocking the pump caller", async () => {
	const queue = new DeliveryQueue();
	const events: string[] = [];
	let releaseFirst!: () => void;
	const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	assert.equal(queue.enqueue("run-1", async () => {
		events.push("first:start");
		await gate;
		events.push("first:end");
	}, () => assert.fail("first must not fail")), true);
	assert.equal(queue.enqueue("run-2", async () => {
		events.push("second");
	}, () => assert.fail("second must not fail")), true);
	assert.equal(queue.enqueue("run-1", async () => {}, () => {}), false, "live inbox duplicates are suppressed");

	await Promise.resolve();
	assert.deepEqual(events, ["first:start"]);
	releaseFirst();
	await queue.idle();
	assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("a transient send failure can be retried from the live inbox", async () => {
	const queue = new DeliveryQueue();
	let failures = 0;
	queue.enqueue("run-1", async () => { throw new Error("temporary"); }, () => { failures++; });
	await queue.idle();
	assert.equal(failures, 1);
	assert.equal(queue.enqueue("run-1", async () => {}, () => {}), true);
	await queue.idle();
});

test("authoritative withdrawal revokes same-key in-flight delivery only", async () => {
	const queue = new DeliveryQueue();
	const messages: string[] = [];
	let retries = 0;
	let release!: () => void;
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });

	queue.enqueue("run-withdrawn", async (lease) => {
		markStarted();
		await gate;
		lease.assertCurrent();
		messages.push("withdrawn");
	}, () => { retries++; });
	await started;
	queue.enqueue("run-unrelated", async (lease) => {
		lease.assertCurrent();
		messages.push("unrelated");
	}, () => assert.fail("key withdrawal must not revoke another run"));

	const outcome = await revalidatePlaybookRunRetry({
		key: "run-withdrawn",
		loadCurrentInbox: async () => ({ dispatches: [], identityComplete: true }),
		identity: (value: { run_id: string }) => value.run_id,
		withdrawCurrent: () => queue.invalidateKey("run-withdrawn"),
		enqueueCurrent: () => assert.fail("withdrawn authority cannot enqueue"),
	});
	assert.equal(outcome, "withdrawn");
	release();
	await queue.idle();
	assert.deepEqual(messages, ["unrelated"]);
	assert.equal(retries, 0);
});

test("stopping a pump revokes paused and queued playbook delivery", async () => {
	const oldQueue = new DeliveryQueue();
	const newQueue = new DeliveryQueue();
	const messages: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let queuedOldStarted = false;

	oldQueue.enqueue("run-old", async (lease) => {
		await gate;
		lease.assertCurrent();
		messages.push("old");
	}, () => assert.fail("revoked generation must be silent"));
	oldQueue.enqueue("run-queued", async () => { queuedOldStarted = true; }, () => assert.fail("revoked queue must be silent"));
	await Promise.resolve();
	oldQueue.invalidate();
	assert.equal(oldQueue.enqueue("run-after-stop", async () => {}, () => {}), false);
	newQueue.enqueue("run-new", async (lease) => {
		lease.assertCurrent();
		messages.push("new");
	}, () => assert.fail("current generation must deliver"));
	await newQueue.idle();
	release();
	await oldQueue.idle();
	assert.equal(queuedOldStarted, false);
	assert.deepEqual(messages, ["new"]);
});
