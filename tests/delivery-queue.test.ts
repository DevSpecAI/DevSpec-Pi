import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryQueue, nextDeliveryRetryDelayMs } from "../extensions/core/delivery-queue.ts";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URIS,
	buildImplementationKickoff,
	type EffectiveImplementationContext,
} from "../extensions/core/implementation-contract.ts";
import {
	installImplementationMode,
	listImplementationModes,
	resetImplementationMode,
} from "../extensions/core/implementation-mode.ts";

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

test("canonical-contract outage leaves unattended delivery retryable without message or mode", async () => {
	resetImplementationMode();
	const queue = new DeliveryQueue();
	const messages: string[] = [];
	let failures = 0;
	const fallback: EffectiveImplementationContext = {
		executionMode: "unattended",
		contractVersion: "pi-local-safety-v1",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		source: "local_safety_fallback",
		coreRules: [],
		modeRules: [],
	};
	const deliver = (context: EffectiveImplementationContext) => async (lease: { assertCurrent(): void }) => {
		lease.assertCurrent();
		const kickoff = buildImplementationKickoff({
			actionItemIds: ["item-retry"],
			assignmentId: "assignment-retry",
			context,
			contractReference: {
				contract_version: "1.0.0",
				resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
			},
		});
		installImplementationMode(kickoff, context);
		messages.push("assignment-retry");
	};

	assert.equal(queue.enqueue("assignment-retry", deliver(fallback), () => { failures++; }), true);
	await queue.idle();
	assert.equal(failures, 1);
	assert.deepEqual(messages, []);
	assert.deepEqual(listImplementationModes(), []);

	const canonical: EffectiveImplementationContext = { ...fallback, contractVersion: "1.0.0", source: "resource" };
	assert.equal(queue.enqueue("assignment-retry", deliver(canonical), () => assert.fail("recovery must deliver")), true);
	await queue.idle();
	assert.deepEqual(messages, ["assignment-retry"]);
	assert.deepEqual(listImplementationModes().map((mode) => mode.assignmentId), ["assignment-retry"]);
});

test("stopping and rebonding revokes paused preparation before every delivery side effect", async () => {
	resetImplementationMode();
	const generationOne = new DeliveryQueue();
	const generationTwo = new DeliveryQueue();
	const messages: string[] = [];
	const statuses: string[] = [];
	const context: EffectiveImplementationContext = {
		executionMode: "unattended",
		contractVersion: "1.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		source: "resource",
		coreRules: [],
		modeRules: [],
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
		installImplementationMode(kickoff, context);
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
		installImplementationMode(kickoff, context);
		messages.push("assignment-new");
		statuses.push(`new:delivered:${lease.generation}`);
	}, () => assert.fail("new generation must deliver"));
	await generationTwo.idle();

	releaseContract();
	await generationOne.idle();
	assert.equal(queuedOldStarted, false, "queued work from the stopped generation never started");
	assert.deepEqual(messages, ["assignment-new"], "the stopped generation injected no user message");
	assert.deepEqual(listImplementationModes().map((mode) => mode.assignmentId), ["assignment-new"], "the stopped generation installed no mode");
	assert.deepEqual(statuses, ["old:prepare:1", "new:delivered:1"], "the stopped generation recorded no work status");
});
