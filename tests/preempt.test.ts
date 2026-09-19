import assert from "node:assert/strict";
import { test } from "node:test";
import { decideInteractionDelivery, decideOwnerDelivery, sendModeFor, shouldClearStrandedBusyAfterAbort, waitUntil } from "../extensions/core/preempt.ts";

test("idle owner messages deliver immediately", () => {
	assert.equal(
		decideOwnerDelivery({ idle: true, preemptEnabled: true, hasOwnerCommand: true }),
		"immediate",
	);
});

test("busy + preempt on → abort then deliver", () => {
	assert.equal(
		decideOwnerDelivery({ idle: false, preemptEnabled: true, hasOwnerCommand: true }),
		"preempt",
	);
});

test("busy + preempt off → queue (today's followUp)", () => {
	assert.equal(
		decideOwnerDelivery({ idle: false, preemptEnabled: false, hasOwnerCommand: true }),
		"queue",
	);
});

test("no owner command never preempts (ambient/dispatch stay out)", () => {
	assert.equal(
		decideOwnerDelivery({ idle: false, preemptEnabled: true, hasOwnerCommand: false }),
		"immediate",
	);
});

test("idle question answers apply immediately", () => {
	assert.equal(
		decideInteractionDelivery({ idle: true, preemptEnabled: true, hasEvent: true }),
		"apply",
	);
});

test("busy + preempt on → abort then apply the interaction event", () => {
	assert.equal(
		decideInteractionDelivery({ idle: false, preemptEnabled: true, hasEvent: true }),
		"preempt",
	);
});

test("busy + preempt off → defer until idle (do not claim)", () => {
	assert.equal(
		decideInteractionDelivery({ idle: false, preemptEnabled: false, hasEvent: true }),
		"defer",
	);
});

test("no interaction event never preempts", () => {
	assert.equal(
		decideInteractionDelivery({ idle: false, preemptEnabled: true, hasEvent: false }),
		"defer",
	);
});

test("preempt sends now only after settle; steer if still busy", () => {
	assert.equal(sendModeFor("preempt", true), "now");
	assert.equal(sendModeFor("preempt", false), "steer");
	assert.equal(sendModeFor("queue"), "followUp");
	assert.equal(sendModeFor("immediate"), "now");
});

test("waitUntil resolves when the check passes", async () => {
	let n = 0;
	const ok = await waitUntil(() => ++n >= 3, {
		timeoutMs: 1_000,
		intervalMs: 0,
		sleep: async () => {},
	});
	assert.equal(ok, true);
	assert.ok(n >= 3);
});

test("waitUntil times out when the check never passes", async () => {
	let t = 0;
	const ok = await waitUntil(() => false, {
		timeoutMs: 30,
		intervalMs: 10,
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
	});
	assert.equal(ok, false);
});

test("a pending answer aborts at most once across busy laps, then applies at idle (4221d08e)", async () => {
	// Decision-layer replay of the poll loop (devspec-remote.ts): each lap with a
	// pending event while busy decides preempt; the journal budget allows exactly
	// one abort; application proceeds the moment a lap finds idle.
	const { InteractionEventJournal } = await import("../extensions/core/interaction-events.ts");
	const journal = new InteractionEventJournal();
	const eventId = "99999999-9999-4999-8999-999999999999";
	// Lap 1: answer arrives while busy. Observe (as the poll path does), decide
	// preempt, spend the budget: abort.
	assert.equal(journal.observe({
		version: 1,
		local_session_id: "pi-session",
		connection_id: "44444444-4444-4444-8444-444444444444",
		source_session_id: "55555555-5555-4555-8555-555555555555",
		event: {
			kind: "devspec.interaction_event", version: 1, event_id: eventId,
			response_id: "22222222-2222-4222-8222-222222222222",
			question_id: "33333333-3333-4333-8333-333333333333",
			origin_connection_id: "44444444-4444-4444-8444-444444444444",
			source_session_id: "55555555-5555-4555-8555-555555555555",
			response_kind: "text", answer: "yes",
			answered_at: "2026-09-14T12:00:00.000Z",
			claim_token: "66666666-6666-4666-8666-666666666666",
			lease_expires_at: "2026-09-14T12:00:30.000Z",
		},
	}), "new");
	assert.equal(decideInteractionDelivery({ idle: false, preemptEnabled: true, hasEvent: true }), "preempt");
	assert.equal(journal.notePreemptAbort(eventId), true, "lap 1 aborts");
	// Laps 2..N: still busy (slow settle, background-held occupancy). Same
	// decision, but the budget is spent: no further aborts, keep awaiting idle.
	for (let lap = 2; lap <= 5; lap++) {
		assert.equal(decideInteractionDelivery({ idle: false, preemptEnabled: true, hasEvent: true }), "preempt");
		assert.equal(journal.notePreemptAbort(eventId), false, `lap ${lap} must not re-abort`);
	}
	// Idle lap: no abort needed; the answer path applies (decide says apply).
	assert.equal(decideInteractionDelivery({ idle: true, preemptEnabled: true, hasEvent: true }), "apply");
});

test("unsettled abort with nothing running clears stranded busy (3f07f97b)", () => {
	// Live wedge 2026-09-18: preempt aborted, settle never ran, ctx idle and no
	// occupancy, yet pump busy stayed true — every lap deferred the same event.
	assert.equal(
		shouldClearStrandedBusyAfterAbort({ settled: false, ctxIdle: true, occupancyBusy: false, pumpBusy: true }),
		true,
	);
});

test("stranded-busy clear fires only when busy is provably stale (3f07f97b)", () => {
	// A completed settle owns busy accounting; never second-guess it.
	assert.equal(
		shouldClearStrandedBusyAfterAbort({ settled: true, ctxIdle: true, occupancyBusy: false, pumpBusy: true }),
		false,
	);
	// A still-running model keeps busy, however long the wait ran.
	assert.equal(
		shouldClearStrandedBusyAfterAbort({ settled: false, ctxIdle: false, occupancyBusy: false, pumpBusy: true }),
		false,
	);
	// Held occupancy (a settling run) keeps busy.
	assert.equal(
		shouldClearStrandedBusyAfterAbort({ settled: false, ctxIdle: true, occupancyBusy: true, pumpBusy: true }),
		false,
	);
	// An already-idle pump needs no recovery.
	assert.equal(
		shouldClearStrandedBusyAfterAbort({ settled: false, ctxIdle: true, occupancyBusy: false, pumpBusy: false }),
		false,
	);
});
