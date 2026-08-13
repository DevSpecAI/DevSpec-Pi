import assert from "node:assert/strict";
import { test } from "node:test";
import { decideOwnerDelivery, sendModeFor, waitUntil } from "../extensions/core/preempt.ts";

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
