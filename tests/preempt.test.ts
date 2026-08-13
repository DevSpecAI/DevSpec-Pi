import assert from "node:assert/strict";
import { test } from "node:test";
import { decideOwnerDelivery } from "../extensions/core/preempt.ts";

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
