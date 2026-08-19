import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	buildImplementationKickoff,
	type ImplementationContractContext,
} from "../extensions/core/implementation-contract.ts";
import {
	clearActiveDelivery,
	consumeDeliveryLifecycle,
	getLatestActiveDelivery,
	listActiveDeliveries,
	recordActiveDelivery,
	resetActiveDeliveries,
	rollbackActiveDelivery,
} from "../extensions/core/active-deliveries.ts";

function context(): ImplementationContractContext {
	return {
		contractVersion: "4.0.0",
		contractHash: "sha256:contract",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource",
		rules: [],
	};
}

test("a delivery is assignment-scoped and clears only after every member terminates", () => {
	resetActiveDeliveries();
	const contract = context();
	const kickoff = buildImplementationKickoff({
		actionItemIds: ["item-a", "item-b"],
		assignmentId: "assignment-1",
		context: contract,
	});
	recordActiveDelivery(kickoff, contract);
	assert.deepEqual(getLatestActiveDelivery()?.actionItemIds, ["item-a", "item-b"]);
	// What is tracked is the delivery, not a mode: no execution mode is stored,
	// because there is none to store (item 6d085535).
	assert.equal(Object.hasOwn(getLatestActiveDelivery()!, "executionMode"), false);

	assert.equal(consumeDeliveryLifecycle("record_implementation", { action_item_id: "item-a" }), false);
	assert.deepEqual(getLatestActiveDelivery()?.terminalActionItemIds, ["item-a"]);
	assert.equal(consumeDeliveryLifecycle("fail_work_item", { action_item_id: "item-b" }), true);
	assert.equal(getLatestActiveDelivery(), null);
});

test("plural queued dispatches retain independent delivery lifecycle", () => {
	resetActiveDeliveries();
	const contract = context();
	for (const [assignmentId, actionItemId] of [["assignment-1", "item-a"], ["assignment-2", "item-b"]]) {
		recordActiveDelivery(buildImplementationKickoff({
			actionItemIds: [actionItemId],
			assignmentId,
			context: contract,
		}), contract);
	}
	assert.deepEqual(listActiveDeliveries().map((entry) => entry.assignmentId), ["assignment-1", "assignment-2"]);
	assert.equal(consumeDeliveryLifecycle("record_implementation", { action_item_id: "item-a" }), true);
	assert.deepEqual(listActiveDeliveries().map((entry) => entry.assignmentId), ["assignment-2"]);
	assert.equal(consumeDeliveryLifecycle("fail_work_item", { action_item_id: "item-b" }), true);
	assert.deepEqual(listActiveDeliveries(), []);
});

test("a batch clears when its LAST member settles, not by an explicit close call", () => {
	// `resolve_assignment` was the explicit close, and it is gone (DevSpec item
	// 1e455001) — a reservation closes itself server-side when its last member
	// settles. That was always the more reliable signal: an agent could forget to
	// call the closing verb, and then the batch stayed open for ever.
	resetActiveDeliveries();
	const contract = context();
	recordActiveDelivery(buildImplementationKickoff({
		actionItemIds: ["item-a", "item-b"],
		assignmentId: "assignment-1",
		context: contract,
	}), contract);

	// The retired verb is inert: no delivery is cleared by naming it.
	assert.equal(consumeDeliveryLifecycle("resolve_assignment", { assignment_id: "assignment-1" }), false);
	assert.ok(getLatestActiveDelivery());

	assert.equal(consumeDeliveryLifecycle("record_implementation", { action_item_id: "item-a" }), false);
	assert.ok(getLatestActiveDelivery(), "one member left, so the batch is still live");
	assert.equal(consumeDeliveryLifecycle("release_work_item", { action_item_id: "item-b" }), true);
	assert.equal(getLatestActiveDelivery(), null);
});

test("send-failure rollback restores a displaced delivery transactionally", () => {
	resetActiveDeliveries();
	const firstContext = context();
	const kickoff = buildImplementationKickoff({ actionItemIds: ["item-local"], context: firstContext });
	recordActiveDelivery(kickoff, firstContext);
	const first = getLatestActiveDelivery();
	assert.ok(first);
	const replacementContext = { ...firstContext, contractHash: "sha256:new" };
	const replacement = recordActiveDelivery(kickoff, replacementContext);
	assert.equal(getLatestActiveDelivery()?.contractHash, "sha256:new");
	assert.equal(rollbackActiveDelivery(replacement), true);
	assert.equal(getLatestActiveDelivery()?.generation, first.generation);
	assert.equal(getLatestActiveDelivery()?.contractHash, first.contractHash);

	const stale = recordActiveDelivery(kickoff, replacementContext);
	const newestContext = { ...firstContext, contractHash: "sha256:newest" };
	recordActiveDelivery(kickoff, newestContext);
	assert.equal(rollbackActiveDelivery(stale), false, "stale rollback must not clobber a newer record");
	assert.equal(getLatestActiveDelivery()?.contractHash, "sha256:newest");
});

test("ordinary remote conversation records no delivery; explicitly selected work does", () => {
	resetActiveDeliveries();
	assert.equal(getLatestActiveDelivery(), null);
	const contract = context();
	recordActiveDelivery(buildImplementationKickoff({ actionItemIds: ["item-local"], context: contract }), contract);
	// A sessionless local selection is keyed by its items, not by an assignment.
	assert.equal(getLatestActiveDelivery()?.deliveryKey, "items:item-local");
	assert.equal(getLatestActiveDelivery()?.assignmentId, undefined);
	assert.equal(consumeDeliveryLifecycle("resolve_assignment", { assignment_id: "unrelated" }), false);
	assert.ok(getLatestActiveDelivery());
	assert.equal(consumeDeliveryLifecycle("resolve_assignment", {}), false);
	assert.equal(consumeDeliveryLifecycle("release_work_item", { action_item_id: "item-local" }), true);
	assert.equal(getLatestActiveDelivery(), null);
	assert.equal(clearActiveDelivery({ deliveryKey: "missing" }), false);
});
