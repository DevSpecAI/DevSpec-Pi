import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const from = source.indexOf("function activeInteractionRun(");
const to = source.indexOf("function interactionApplicationDetails(", from);
assert.ok(from >= 0 && to > from);
const actualFunctions = stripTypeScriptTypes(source.slice(from, to), { mode: "transform" });

function fixture() {
	const active = { busy: true, pendingInteractionStarts: new Map(), pendingInteractionReleases: new Map() };
	let aborts = 0;
	const abandoned: unknown[] = [];
	const scope: any = {
		interactionRunsByEvent: new Map(), pendingInteractionConfirmations: new Set(),
		startingInteractionRun: null, turn: { completionNeutral: false },
		interactionDelivery: { abandonMessage: (message: unknown) => abandoned.push(message) },
		armInteractionRetryWake() {},
	};
	vm.createContext(scope); vm.runInContext(actualFunctions, scope);
	const run = (id: string) => ({ active, application: "applied", details: { event: { event_id: id } } });
	return { active, scope, run, abandoned, ctx: { abort() { aborts += 1; } }, aborts: () => aborts };
}

test("orphan receipt bookkeeping is not current foreground ownership", () => {
	const { active, scope, run } = fixture();
	const old = run("old"); scope.interactionRunsByEvent.set("old", old);
	assert.equal(scope.activeInteractionRun(active), undefined);
	scope.turn.interaction = old;
	assert.equal(scope.activeInteractionRun(active), old);
	scope.turn.interaction = undefined;
	assert.equal(scope.activeInteractionRun(active), undefined);
});

test("retirement preserves application/ACK state and cannot delete a newer run", () => {
	const { scope, run } = fixture();
	const old = run("same-event"), newer = run("same-event");
	scope.interactionRunsByEvent.set("same-event", newer);
	scope.startingInteractionRun = newer;
	scope.retireInteractionForeground(old);
	assert.equal(scope.interactionRunsByEvent.get("same-event"), newer);
	assert.equal(scope.startingInteractionRun, newer);
	assert.equal(old.application, "applied");
	scope.retireInteractionForeground(newer);
	assert.equal(scope.interactionRunsByEvent.size, 0);
	assert.equal(scope.startingInteractionRun, null);
	assert.equal(newer.application, "applied");
});

test("attachment change abandons retired pending confirmation without aborting newer owner work", () => {
	const { active, scope, run, ctx, aborts, abandoned } = fixture();
	const old = run("old");
	const message = {};
	scope.pendingInteractionConfirmations.add({ active, run: old, message });
	assert.equal(scope.revokeInteractionForAttachmentChange(active, ctx), true);
	assert.equal(aborts(), 0);
	assert.equal(active.busy, true);
	assert.equal(scope.turn.completionNeutral, false);
	assert.equal(scope.pendingInteractionConfirmations.size, 0);
	assert.equal(abandoned[0], message);
});

test("a genuinely active question still aborts and revokes on attachment change", () => {
	const { active, scope, run, ctx, aborts } = fixture();
	const current = run("current");
	scope.turn.interaction = current;
	scope.interactionRunsByEvent.set("current", current);
	assert.equal(scope.revokeInteractionForAttachmentChange(active, ctx), true);
	assert.equal(aborts(), 1);
	assert.equal(current.application, "released");
	assert.equal(scope.turn.interaction, undefined);
	assert.equal(scope.turn.completionNeutral, true);
	assert.equal(active.busy, false);
});
