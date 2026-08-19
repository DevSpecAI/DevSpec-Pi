import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryQueue, nextDeliveryRetryDelayMs } from "../extensions/core/delivery-queue.ts";
import { revalidateDispatchRetry } from "../extensions/core/dispatch-retry.ts";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	buildImplementationKickoff,
	type ImplementationContractContext,
} from "../extensions/core/implementation-contract.ts";
import {
	listActiveDeliveries,
	recordActiveDelivery,
	resetActiveDeliveries,
} from "../extensions/core/active-deliveries.ts";

test("delivery retry backoff is bounded and deterministic", () => {
	assert.equal(nextDeliveryRetryDelayMs(1), 5_000);
	assert.equal(nextDeliveryRetryDelayMs(2), 10_000);
	assert.equal(nextDeliveryRetryDelayMs(5), 60_000);
	assert.equal(nextDeliveryRetryDelayMs(20), 60_000);
});

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

test("canonical-contract outage delivers with fail-open guidance instead of blocking work", async () => {
	resetActiveDeliveries();
	const queue = new DeliveryQueue();
	const messages: string[] = [];
	let failures = 0;
	const fallback: ImplementationContractContext = {
		contractVersion: "pi-local-fail-open-v1",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "local_safety_fallback",
		rules: [],
	};
	const deliver = async (lease: { assertCurrent(): void }) => {
		lease.assertCurrent();
		const kickoff = buildImplementationKickoff({
			actionItemIds: ["item-offline"],
			assignmentId: "assignment-offline",
			context: fallback,
			contractReference: {
				contract_version: "4.0.0",
				resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
			},
		});
		recordActiveDelivery(kickoff, fallback);
		messages.push("assignment-offline");
	};

	assert.equal(queue.enqueue("assignment-offline", deliver, () => { failures++; }), true);
	await queue.idle();
	assert.equal(failures, 0);
	assert.deepEqual(messages, ["assignment-offline"]);
	assert.deepEqual(listActiveDeliveries().map((delivery) => delivery.assignmentId), ["assignment-offline"]);
});

test("authoritative withdrawal revokes same-key preparation already re-enqueued by polling", async () => {
	resetActiveDeliveries();
	const queue = new DeliveryQueue();
	const key = "assignment-withdrawn";
	const messages: string[] = [];
	const statuses: string[] = [];
	const notifications: string[] = [];
	let retries = 0;

	queue.enqueue(key, async () => { throw new Error("temporary delivery failure"); }, () => { retries++; });
	await queue.idle();
	assert.equal(retries, 1, "the initial transient failure schedules exact revalidation");
	retries = 0;

	let releasePreparation!: () => void;
	let markStarted!: () => void;
	const preparationStarted = new Promise<void>((resolve) => { markStarted = resolve; });
	const preparationGate = new Promise<void>((resolve) => { releasePreparation = resolve; });
	const context: ImplementationContractContext = {
		contractVersion: "4.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource",
		rules: [],
	};
	assert.equal(queue.enqueue(key, async (lease) => {
		markStarted();
		await preparationGate;
		lease.assertCurrent();
		const kickoff = buildImplementationKickoff({
			actionItemIds: ["item-withdrawn"],
			assignmentId: key,
			context,
		});
		recordActiveDelivery(kickoff, context);
		messages.push(key);
		statuses.push("working");
		notifications.push("delivered");
	}, () => {
		retries++;
		notifications.push("retry");
	}), true, "a normal poll may re-offer the key after the transient failure");
	await preparationStarted;
	assert.equal(queue.enqueue("assignment-unrelated", async (lease) => {
		lease.assertCurrent();
		messages.push("unrelated-delivery");
	}, () => assert.fail("key-specific withdrawal must not revoke unrelated work")), true);

	const outcome = await revalidateDispatchRetry({
		key,
		loadCurrentInbox: async () => ({ dispatches: [], identityComplete: true }),
		identity: (dispatch: { id: string }) => dispatch.id,
		withdrawCurrent: () => queue.invalidateKey(key),
		enqueueCurrent: () => assert.fail("withdrawn authority cannot enqueue"),
	});
	assert.equal(outcome, "withdrawn");

	releasePreparation();
	await queue.idle();
	assert.deepEqual(messages, ["unrelated-delivery"]);
	assert.deepEqual(listActiveDeliveries(), []);
	assert.deepEqual(statuses, []);
	assert.deepEqual(notifications, []);
	assert.equal(retries, 0, "stale preparation cannot schedule another retry");

	assert.equal(queue.enqueue(key, async (lease) => {
		lease.assertCurrent();
		messages.push("genuine-redispatch");
	}, () => assert.fail("a future genuine redispatch must remain deliverable")), true);
	await queue.idle();
	assert.deepEqual(messages, ["unrelated-delivery", "genuine-redispatch"]);
});

test("stopping and rebonding revokes paused preparation before every delivery side effect", async () => {
	resetActiveDeliveries();
	const generationOne = new DeliveryQueue();
	const generationTwo = new DeliveryQueue();
	const messages: string[] = [];
	const statuses: string[] = [];
	const context: ImplementationContractContext = {
		contractVersion: "4.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource",
		rules: [],
	};
	let releaseContract!: () => void;
	const contractGate = new Promise<void>((resolve) => { releaseContract = resolve; });

	generationOne.enqueue("assignment-old", async (lease) => {
		statuses.push(`old:prepare:${lease.generation}`);
		await contractGate;
		lease.assertCurrent();
		const kickoff = buildImplementationKickoff({
			actionItemIds: ["item-old"],
			assignmentId: "assignment-old",
			context,
		});
		recordActiveDelivery(kickoff, context);
		messages.push("assignment-old");
		statuses.push("assignment-old");
	}, () => assert.fail("revoked generation must not report a live delivery error"));
	let queuedOldStarted = false;
	generationOne.enqueue("assignment-queued", async () => {
		queuedOldStarted = true;
	}, () => assert.fail("queued stale delivery must not report an error"));
	await Promise.resolve();

	generationOne.invalidate();
	assert.equal(generationOne.enqueue("assignment-after-stop", async () => {}, () => {}), false);
	generationTwo.enqueue("assignment-old", async (lease) => {
		lease.assertCurrent();
		const kickoff = buildImplementationKickoff({
			actionItemIds: ["item-new"],
			assignmentId: "assignment-new",
			context,
		});
		recordActiveDelivery(kickoff, context);
		messages.push("assignment-new");
		statuses.push(`new:delivered:${lease.generation}`);
	}, () => assert.fail("new generation must deliver"));
	await generationTwo.idle();

	releaseContract();
	await generationOne.idle();
	assert.equal(queuedOldStarted, false, "queued work from the stopped generation never started");
	assert.deepEqual(messages, ["assignment-new"], "the stopped generation injected no user message");
	assert.deepEqual(listActiveDeliveries().map((delivery) => delivery.assignmentId), ["assignment-new"], "the stopped generation recorded no delivery");
	assert.deepEqual(statuses, ["old:prepare:1", "new:delivered:1"], "the stopped generation recorded no work status");
});
