import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryQueue } from "../extensions/core/delivery-queue.ts";

test("dispatch preparation is ordered without blocking the pump caller", async () => {
	const queue = new DeliveryQueue();
	const events: string[] = [];
	let releaseFirst!: () => void;
	const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	assert.equal(queue.enqueue("assignment-1", async () => {
		events.push("first:start");
		await gate;
		events.push("first:end");
	}, () => assert.fail("first must not fail")), true);
	assert.equal(queue.enqueue("assignment-2", async () => {
		events.push("second");
	}, () => assert.fail("second must not fail")), true);
	assert.equal(queue.enqueue("assignment-1", async () => {}, () => {}), false, "live inbox duplicates are suppressed");

	await Promise.resolve();
	assert.deepEqual(events, ["first:start"], "enqueue returned while contract preparation remained in flight");
	releaseFirst();
	await queue.idle();
	assert.deepEqual(events, ["first:start", "first:end", "second"]);
});

test("a transient delivery failure can be retried from the live inbox", async () => {
	const queue = new DeliveryQueue();
	let failures = 0;
	queue.enqueue("assignment", async () => { throw new Error("temporary"); }, () => { failures++; });
	await queue.idle();
	assert.equal(failures, 1);
	assert.equal(queue.enqueue("assignment", async () => {}, () => {}), true);
	await queue.idle();
});
