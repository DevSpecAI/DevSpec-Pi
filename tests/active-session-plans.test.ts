import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACTIVE_PLAN_AUTHORITY_NOTE,
	ACTIVE_PLAN_CLEAR_TOMBSTONE,
	ACTIVE_PLAN_MAX_PLANS,
	activePlanAwarenessHash,
	activePlanTailForDelivery,
	activePlanTransitionTail,
	appendActivePlanTail,
	authoritativeActivePlanTransitionTail,
	clearActivePlanAwareness,
	markActivePlanAwareness,
	parseActiveSessionPlansProjection,
	resetActivePlanAwarenessForTests,
	serializeActiveSessionPlansProjection,
} from "../extensions/core/active-session-plans.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { activePlanProjection, canonicalPoll, IDS, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

test("strict 1.4 ingress preserves the complete active plan inventory and no-plan state", () => {
	const withPlan = parsePollPayload(canonicalPoll({ activePlans: activePlanProjection() }), TEST_CONNECTION);
	assert.equal(withPlan.canonicalState, "valid");
	assert.equal(withPlan.activeSessionPlans?.plans[0]?.id, IDS.plan);
	assert.equal(withPlan.activeSessionPlans?.plans[0]?.revision, 7);

	const withoutPlan = parsePollPayload(canonicalPoll(), TEST_CONNECTION);
	assert.equal(withoutPlan.canonicalState, "valid");
	assert.equal(withoutPlan.activeSessionPlans, null, "omission is authoritative no active plans, not an unknown legacy shape");
});

test("active plan parser fails the entire ingress atomically on shape, bounds, and progress drift", () => {
	const mutations: Array<(projection: ReturnType<typeof activePlanProjection>) => void> = [
		(value) => { value.version = 2; },
		(value) => { value.advisory = false; },
		(value) => { value.authority_note = "model may mutate"; },
		(value) => { value.inventory.returned = 2; },
		(value) => { value.inventory.truncated = true; },
		(value) => { value.plans[0]!.revision = 0; },
		(value) => { value.plans[0]!.progress.total = 99; },
		(value) => { value.plans[0]!.steward.connection_id = "not-a-uuid"; },
		(value) => { (value.plans[0] as unknown as Record<string, unknown>).extra = true; },
		(value) => { value.plans[0]!.steps[0] = { ...value.plans[0]!.steps[0]!, status: "failed" } as never; },
	];
	for (const mutate of mutations) {
		const projection = clone(activePlanProjection());
		mutate(projection);
		const payload = canonicalPoll({ activePlans: projection });
		const parsed = parsePollPayload(payload, TEST_CONNECTION);
		assert.equal(parsed.canonicalState, "invalid");
		assert.equal(parsed.cursorV2, undefined, "invalid projection cannot advance the canonical cursor");
		assert.equal(parsed.ownerBundle, undefined, "invalid projection cannot partially deliver its command");
	}

	const oversized = clone(activePlanProjection());
	oversized.plans = Array.from({ length: ACTIVE_PLAN_MAX_PLANS + 1 }, () => clone(oversized.plans[0]!));
	oversized.inventory.returned = oversized.plans.length;
	oversized.inventory.total_known = oversized.plans.length;
	assert.throws(() => parseActiveSessionPlansProjection(oversized), /1\.\.64 plans/);
});

test("delivery-tail serialization distinguishes own resume, handoff/adoption, and room read-only plans", () => {
	const projection = parseActiveSessionPlansProjection(activePlanProjection({ orphaned: true, secondRoomPlan: true }));
	const rendered = serializeActiveSessionPlansProjection(projection, IDS.connection);
	assert.match(rendered, /^== ACTIVE SESSION PLANS ==/);
	assert.ok(rendered.includes(ACTIVE_PLAN_AUTHORITY_NOTE));
	assert.match(rendered, /\[OWN\].*plan_id=.*revision=7/);
	assert.match(rendered, /resume the in_progress step step_id=/);
	assert.match(rendered, /hand off for adoption/);
	assert.match(rendered, /\[ROOM · READ-ONLY\].*Room observer plan/);
	const roomSection = rendered.slice(rendered.indexOf("[ROOM · READ-ONLY]"));
	assert.doesNotMatch(roomSection, /Own-plan guidance/);

	const reconnect = serializeActiveSessionPlansProjection(
		parseActiveSessionPlansProjection(clone(activePlanProjection({ orphaned: true, secondRoomPlan: true }))),
		IDS.connection,
	);
	assert.equal(reconnect, rendered, "reconnect serialization is byte-stable for the same authoritative revisions");
	assert.equal(serializeActiveSessionPlansProjection(null, IDS.connection), "", "no plan emits no boilerplate");
});

test("active-to-none emits one current-tail tombstone while never-had-plan stays silent", () => {
	const activeTail = serializeActiveSessionPlansProjection(
		parseActiveSessionPlansProjection(activePlanProjection()),
		IDS.connection,
	);
	assert.equal(activePlanTransitionTail("", ""), "", "never-had-plan emits no boilerplate");
	assert.equal(activePlanTransitionTail("", activeTail), activeTail, "reconnect resumes with the authoritative plan");
	assert.equal(activePlanTransitionTail(activeTail, ""), ACTIVE_PLAN_CLEAR_TOMBSTONE);
	assert.equal(activePlanTransitionTail("", ""), "", "repeated none does not re-emit the tombstone");
	assert.match(ACTIVE_PLAN_CLEAR_TOMBSTONE, /Authoritative current inventory: none/);
	assert.match(ACTIVE_PLAN_CLEAR_TOMBSTONE, /earlier active-session-plan projection.*stale/);

	assert.equal(activePlanTailForDelivery(false, activeTail, ""), "", "ordinary later rounds do not replay unchanged plans");
	assert.equal(activePlanTailForDelivery(true, activeTail, "older pending"), activeTail, "queued owner delivery uses newest active projection");
	assert.equal(activePlanTailForDelivery(true, "", ACTIVE_PLAN_CLEAR_TOMBSTONE), ACTIVE_PLAN_CLEAR_TOMBSTONE, "queued owner delivery clears a removed plan");
	assert.equal(activePlanTailForDelivery(false, "", ACTIVE_PLAN_CLEAR_TOMBSTONE), ACTIVE_PLAN_CLEAR_TOMBSTONE, "next local tail consumes the one-shot clear");
});

test("stop/reload/rebond preserves only awareness hash so reconnect-none clears once", (t) => {
	resetActivePlanAwarenessForTests();
	t.after(resetActivePlanAwarenessForTests);
	const localSessionId = "pi-local-session-reload-1";
	const activeTail = serializeActiveSessionPlansProjection(
		parseActiveSessionPlansProjection(activePlanProjection()),
		IDS.connection,
	);

	assert.equal(authoritativeActivePlanTransitionTail(localSessionId, "", ""), "", "never-had-plan reconnect remains empty");
	const digest = markActivePlanAwareness(localSessionId, activeTail);
	assert.match(digest ?? "", /^[a-f0-9]{64}$/);
	assert.equal(digest?.includes("Ship shared plans"), false, "store retains no plan content");
	assert.equal(activePlanAwarenessHash(localSessionId), digest);

	// stopPump / module replacement deliberately do not clear the global marker.
	const afterRebond = authoritativeActivePlanTransitionTail(localSessionId, "", "");
	assert.equal(afterRebond, ACTIVE_PLAN_CLEAR_TOMBSTONE, "authoritative reconnect-none clears prior injected awareness");
	assert.equal(activePlanAwarenessHash(localSessionId), digest, "scheduling alone does not clear awareness");
	assert.equal(activePlanTailForDelivery(true, "", afterRebond), ACTIVE_PLAN_CLEAR_TOMBSTONE, "queued owner turn carries the reconnect tombstone");
	assert.equal(clearActivePlanAwareness(localSessionId), true, "actual tombstone injection clears the marker");
	assert.equal(activePlanAwarenessHash(localSessionId), null);
	assert.equal(authoritativeActivePlanTransitionTail(localSessionId, "", ""), "", "later no-plan polls emit no duplicate tombstone");
});

test("active plans append after immutable typed delivery bytes and only the tail changes", () => {
	const prefix = "stable system/history prefix\n\ntyped owner command and canonical context";
	const before = Buffer.byteLength(prefix);
	const firstTail = serializeActiveSessionPlansProjection(
		parseActiveSessionPlansProjection(activePlanProjection()),
		IDS.connection,
	);
	const first = appendActivePlanTail(prefix, firstTail);
	assert.ok(first.startsWith(`${prefix}\n\n== ACTIVE SESSION PLANS ==`));
	assert.equal(first.slice(0, prefix.length), prefix);

	const advanced = clone(activePlanProjection());
	advanced.plans[0]!.revision = 8;
	advanced.plans[0]!.steps[0]!.status = "completed";
	advanced.plans[0]!.steps[1]!.status = "in_progress";
	advanced.plans[0]!.progress = { terminal: 1, total: 2, completed: 1, skipped: 0 };
	const second = appendActivePlanTail(prefix, serializeActiveSessionPlansProjection(
		parseActiveSessionPlansProjection(advanced),
		IDS.connection,
	));
	assert.equal(second.slice(0, prefix.length), prefix);
	assert.notEqual(first.slice(prefix.length), second.slice(prefix.length));
	assert.equal(Buffer.byteLength(first) - before, Buffer.byteLength(`\n\n${firstTail}`), "before/after bytes account only for the negotiated tail");
});
