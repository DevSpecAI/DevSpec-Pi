import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URIS,
	buildImplementationKickoff,
	type EffectiveImplementationContext,
} from "../extensions/core/implementation-contract.ts";
import {
	clearImplementationMode,
	consumeImplementationLifecycle,
	getActiveImplementationMode,
	installImplementationMode,
	listImplementationModes,
	resetImplementationMode,
	rollbackImplementationMode,
} from "../extensions/core/implementation-mode.ts";

function context(mode: "attended" | "unattended"): EffectiveImplementationContext {
	return {
		executionMode: mode,
		contractVersion: "1.0.0",
		contractHash: "sha256:contract",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS[mode],
		source: "resource",
		coreRules: [],
		modeRules: [],
	};
}

test("unattended mode is assignment-scoped and clears only after every member terminates", () => {
	resetImplementationMode();
	const contract = context("unattended");
	const kickoff = buildImplementationKickoff({
		actionItemIds: ["item-a", "item-b"],
		assignmentId: "assignment-1",
		context: contract,
	});
	installImplementationMode(kickoff, contract);
	assert.deepEqual(getActiveImplementationMode()?.actionItemIds, ["item-a", "item-b"]);
	assert.equal(getActiveImplementationMode()?.executionMode, "unattended");

	assert.equal(consumeImplementationLifecycle("record_implementation", { action_item_id: "item-a" }), false);
	assert.deepEqual(getActiveImplementationMode()?.terminalActionItemIds, ["item-a"]);
	assert.equal(consumeImplementationLifecycle("fail_work_item", { action_item_id: "item-b" }), true);
	assert.equal(getActiveImplementationMode(), null);
});

test("plural queued dispatches retain independent mode lifecycle", () => {
	resetImplementationMode();
	const contract = context("unattended");
	for (const [assignmentId, actionItemId] of [["assignment-1", "item-a"], ["assignment-2", "item-b"]]) {
		installImplementationMode(buildImplementationKickoff({
			actionItemIds: [actionItemId],
			assignmentId,
			context: contract,
		}), contract);
	}
	assert.deepEqual(listImplementationModes().map((entry) => entry.assignmentId), ["assignment-1", "assignment-2"]);
	assert.equal(consumeImplementationLifecycle("record_implementation", { action_item_id: "item-a" }), true);
	assert.deepEqual(listImplementationModes().map((entry) => entry.assignmentId), ["assignment-2"]);
	assert.equal(consumeImplementationLifecycle("fail_work_item", { action_item_id: "item-b" }), true);
	assert.deepEqual(listImplementationModes(), []);
});

test("resolve_assignment clears only the matching assignment envelope", () => {
	resetImplementationMode();
	const contract = context("unattended");
	installImplementationMode(buildImplementationKickoff({
		actionItemIds: ["item-a"],
		assignmentId: "assignment-1",
		context: contract,
	}), contract);
	assert.equal(consumeImplementationLifecycle("resolve_assignment", { assignment_id: "other" }), false);
	assert.ok(getActiveImplementationMode());
	assert.equal(consumeImplementationLifecycle("resolve_assignment", { assignment_id: "assignment-1" }), true);
	assert.equal(getActiveImplementationMode(), null);
});

test("send-failure rollback restores a displaced delivery transactionally", () => {
	resetImplementationMode();
	const firstContext = context("attended");
	const kickoff = buildImplementationKickoff({ actionItemIds: ["item-local"], context: firstContext });
	installImplementationMode(kickoff, firstContext);
	const first = getActiveImplementationMode();
	assert.ok(first);
	const replacementContext = { ...firstContext, contractHash: "sha256:new" };
	const replacement = installImplementationMode(kickoff, replacementContext);
	assert.equal(getActiveImplementationMode()?.contractHash, "sha256:new");
	assert.equal(rollbackImplementationMode(replacement), true);
	assert.equal(getActiveImplementationMode()?.generation, first.generation);
	assert.equal(getActiveImplementationMode()?.contractHash, first.contractHash);

	const stale = installImplementationMode(kickoff, replacementContext);
	const newestContext = { ...firstContext, contractHash: "sha256:newest" };
	installImplementationMode(kickoff, newestContext);
	assert.equal(rollbackImplementationMode(stale), false, "stale rollback must not clobber a newer installation");
	assert.equal(getActiveImplementationMode()?.contractHash, "sha256:newest");
});

test("ordinary remote conversation does not install a mode; explicit attended work does", () => {
	resetImplementationMode();
	assert.equal(getActiveImplementationMode(), null);
	const contract = context("attended");
	installImplementationMode(buildImplementationKickoff({ actionItemIds: ["item-local"], context: contract }), contract);
	assert.equal(getActiveImplementationMode()?.executionMode, "attended");
	assert.equal(consumeImplementationLifecycle("resolve_assignment", { assignment_id: "unrelated" }), false);
	assert.equal(getActiveImplementationMode()?.executionMode, "attended");
	assert.equal(consumeImplementationLifecycle("resolve_assignment", {}), false);
	assert.equal(consumeImplementationLifecycle("release_work_item", { action_item_id: "item-local" }), true);
	assert.equal(getActiveImplementationMode(), null);
	assert.equal(clearImplementationMode({ deliveryKey: "missing" }), false);
});
