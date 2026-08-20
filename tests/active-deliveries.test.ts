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

test("a local direct delivery clears only after every selected item terminates", () => {
	resetActiveDeliveries();
	const contract = context();
	recordActiveDelivery(buildImplementationKickoff({
		actionItemIds: ["item-a", "item-b"],
		context: contract,
	}), contract);
	assert.deepEqual(getLatestActiveDelivery()?.actionItemIds, ["item-a", "item-b"]);
	assert.equal(Object.hasOwn(getLatestActiveDelivery()!, "executionMode"), false);
	assert.equal(Object.hasOwn(getLatestActiveDelivery()!, "assignmentId"), false);

	assert.equal(consumeDeliveryLifecycle("record_implementation", { action_item_id: "item-a" }), false);
	assert.deepEqual(getLatestActiveDelivery()?.terminalActionItemIds, ["item-a"]);
	assert.equal(consumeDeliveryLifecycle("fail_work_item", { action_item_id: "item-b" }), true);
	assert.equal(getLatestActiveDelivery(), null);
});

test("plural local selections retain independent delivery lifecycle", () => {
	resetActiveDeliveries();
	const contract = context();
	for (const actionItemId of ["item-a", "item-b"]) {
		recordActiveDelivery(buildImplementationKickoff({
			actionItemIds: [actionItemId],
			context: contract,
		}), contract);
	}
	assert.deepEqual(listActiveDeliveries().map((entry) => entry.deliveryKey), ["items:item-a", "items:item-b"]);
	assert.equal(consumeDeliveryLifecycle("record_implementation", { action_item_id: "item-a" }), true);
	assert.deepEqual(listActiveDeliveries().map((entry) => entry.deliveryKey), ["items:item-b"]);
	assert.equal(consumeDeliveryLifecycle("fail_work_item", { action_item_id: "item-b" }), true);
	assert.deepEqual(listActiveDeliveries(), []);
});

test("send-failure rollback restores a displaced local delivery transactionally", () => {
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

test("ordinary remote conversation records no delivery; explicit local selection does", () => {
	resetActiveDeliveries();
	assert.equal(getLatestActiveDelivery(), null);
	const contract = context();
	recordActiveDelivery(buildImplementationKickoff({ actionItemIds: ["item-local"], context: contract }), contract);
	assert.equal(getLatestActiveDelivery()?.deliveryKey, "items:item-local");
	assert.equal(consumeDeliveryLifecycle("release_work_item", { action_item_id: "item-local" }), true);
	assert.equal(getLatestActiveDelivery(), null);
	assert.equal(clearActiveDelivery({ deliveryKey: "missing" }), false);
});
