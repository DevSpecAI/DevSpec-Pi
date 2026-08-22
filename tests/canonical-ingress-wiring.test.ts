import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");

function bodyBetween(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing source range ${start}..${end}`);
	return source.slice(from, to);
}

test("every Pi poll negotiates canonical ingress, delegated scope, and active plans while only top-level cursor_v2 drives live progress", () => {
	const calls = [...source.matchAll(/callDevspec\([^]*?"poll_connection"[^]*?\{([^]*?)\}, \{/gu)];
	assert.equal(calls.length, 2, "expected control ack and pump poll only");
	for (const call of calls) {
		assert.match(call[1], /ingress_version: 1/);
		assert.match(call[1], /delegated_scope_version: 1/);
		assert.match(call[1], /active_plan_projection_version: 1/);
	}
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /cursor_v2: active\.cursor/);
	assert.match(pump, /if \(!commandDeliveryFailed\)[^]*active\.cursor = pkg\.cursorV2/);
	assert.doesNotMatch(pump, /active\.cursor\s*=\s*[^;]*next_cursor|\bcursor: active\.cursor/);
});

test("canonical parser output stays independent from playbook dispatch and control paths", () => {
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /parsePollPayload\(payload, active\.bond\.connectionId\)/);
	assert.match(pump, /pkg\.ownerBundle/);
	assert.match(pump, /pkg\.control/);
	assert.match(pump, /for \(const dispatch of dispatches\) enqueuePlaybookRun/);
	assert.doesNotMatch(pump, /payload[^\n]*commands|buildRoomDigest|owner_ambient|room_context/);
});

test("multi-command hydration, send, seen state, and rollback are atomic for the unseen subset", () => {
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	assert.match(delivery, /takeUnseen\(pkg\.ownerBundle\.commands\)/);
	assert.match(delivery, /ownerBundleSubset\(pkg\.ownerBundle, unseen\)/);
	assert.match(delivery, /await hydrateOwnerBundle\(selectedBundle/);
	assert.equal((delivery.match(/\bpi_send\(/g) ?? []).length, 1, "one send site for the unseen subset");
	assert.match(delivery, /pi_send\([^;]+;\s*attachmentLease\.accept\(\);[^]*commitBundle\(unseen\)/);
	assert.match(delivery, /catch \(err\)[^]*attachmentLease\?\.cleanupIfPending\(\)[^]*releaseBundle\(unseen\)/);
	assert.match(delivery, /attachmentRetryAttempts[^]*nextDeliveryRetryDelayMs[^]*commandRetryDelayMs/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /if \(commandRetryDelayMs > 0[^]*await new Promise[^]*setTimeout\(resolve, commandRetryDelayMs\)[^]*signalWake\(active\)/);
	assert.doesNotMatch(delivery, /reportComplete\("delivery_failed"/);
});

test("terminal attachment rejection commits only after report_complete acknowledgement", () => {
	const rejected = bodyBetween("if (pkg.rejectedBundle)", "if (pkg.ownerBundle)");
	assert.match(rejected, /const reported = await reportComplete\("delivery_unavailable"/);
	assert.match(rejected, /if \(reported\)[^]*attachmentRetryAttempts\.delete\(rejected\.commandTurnId\)[^]*commitBundle\(unseen\)/);
	assert.match(rejected, /else[^]*releaseBundle\(unseen\)[^]*commandDeliveryFailed = true/);
	assert.match(rejected, /nextDeliveryRetryDelayMs/);
});

test("attachment failure precedes preemption and no host prose mutates the canonical prompt", () => {
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	const hydrated = delivery.indexOf("await hydrateOwnerBundle");
	const decide = delivery.indexOf("decideOwnerDelivery");
	const abort = delivery.indexOf("pi_abort()");
	const send = delivery.indexOf("pi_send(");
	assert.ok(hydrated >= 0 && hydrated < decide && decide < abort && abort < send);
	assert.doesNotMatch(delivery, /PREEMPT_TAIL|deliveryMessage\s*=|formatted\s*\+=/);
});

test("hydrated file ownership survives formatting and preemption but is cleaned on every pre-send failure", () => {
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	const lease = delivery.indexOf("new AttachmentDeliveryLease");
	const formatted = delivery.indexOf("formatInboundBundleMessage");
	const abort = delivery.indexOf("pi_abort()");
	const send = delivery.indexOf("pi_send(");
	const accept = delivery.indexOf("attachmentLease.accept()");
	const cleanup = delivery.indexOf("attachmentLease?.cleanupIfPending()");
	assert.ok(lease >= 0 && lease < formatted && formatted < abort && abort < send && send < accept);
	assert.ok(cleanup > accept, "the catch owns cleanup for any throw before synchronous send acceptance");
});

test("all send modes use the same visible bundle binding and idle retains hidden typed context", () => {
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	assert.equal((delivery.match(/formatInboundBundleMessage\(/g) ?? []).length, 1);
	assert.match(delivery, /const formatted = formatInboundBundleMessage\(hydrated\)/);
	assert.match(delivery, /pi_send\(formatted, sendMode, hydrated\.commandTurnId, primary\.id, queueItem\)/);

	const sender = bodyBetween("pi_send =", "pi_abort =");
	assert.match(sender, /commandTurnBindings\.remember\(message, commandTurnId, commandMessageId, canonicalQueueItem\)/);
	assert.match(sender, /if \(mode === "steer"\) pi\.sendUserMessage\(message, \{ deliverAs: "steer" \}\)/);
	assert.match(sender, /else if \(mode === "followUp"\) pi\.sendUserMessage\(message, \{ deliverAs: "followUp" \}\)/);
	assert.match(sender, /else pi\.sendUserMessage\(message\)/);
	assert.doesNotMatch(sender, /pi\.sendMessage/);
	assert.match(sender, /catch \(error\)[^]*commandTurnBindings\.forget/);

	const beforeStart = bodyBetween('pi.on("before_agent_start"', 'pi.on("message_start"');
	assert.match(beforeStart, /commandTurnBindings\.peek\(event\.prompt\)/);
	assert.match(beforeStart, /appendActivePlanTail\(canonicalQueueItem\?\.hiddenContent \?\? "", planTail\)/);
	assert.match(beforeStart, /customType: canonicalQueueItem \? "devspec-remote-ingress-context" : "devspec-active-session-plans"/);
	assert.match(beforeStart, /content: hiddenContent/);
	assert.match(beforeStart, /display: false/);
});

test("attached bonds activate only native plan management and detach/stop removes it", () => {
	const bond = bodyBetween("async function bondNow", "// Late-bound");
	assert.match(bond, /pi_setPlanToolActive\(Boolean\(bond\.sessionId\)\)/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /pi_setPlanToolActive\(Boolean\(serverSessionId\)\)/);
	assert.match(pump, /pi_setPlanToolActive\(Boolean\(active\.bond\.sessionId \|\| planTail\)\)/);
	assert.match(pump, /authoritativeActivePlanTransitionTail\([^]*active\.awarenessKey[^]*active\.activePlanTail[^]*""/,
		"detach/replacement consults persistent injected awareness");
	assert.match(bond, /awarenessKey: localId/);
	const stop = bodyBetween("async function stopPump", "/** Wake the pump's SSE waiter");
	assert.doesNotMatch(stop, /clearActivePlanAwareness|resetActivePlanAwareness/, "stop preserves injected awareness for rebond");
	const setter = bodyBetween("pi_setPlanToolActive =", 'pi.on("model_select"');
	assert.match(setter, /withPlanToolActive\(pi\.getActiveTools\(\), enabled\)/);
	assert.doesNotMatch(setter, /MODEL_VERB_NAMES|allModelFacingTools|searchRareModelTools/);
});

test("validated plan projection appends at the canonical delivery tail without rewriting visible owner text", () => {
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /serializeActiveSessionPlansProjection\(pkg\.activeSessionPlans, active\.bond\.connectionId\)/);
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	assert.match(delivery, /hiddenContent: formatCanonicalDeliveryContext\(hydrated, contexts\)/);
	assert.match(delivery, /pi_send\(formatted/);
	assert.doesNotMatch(delivery, /formatted\s*=\s*appendActivePlanTail|hiddenContent: appendActivePlanTail|event\.systemPrompt/);
	const beforeStart = bodyBetween('pi.on("before_agent_start"', 'pi.on("message_start"');
	assert.match(beforeStart, /activePlanTailForDelivery\([^]*Boolean\(canonicalQueueItem\)[^]*active\?\.activePlanTail[^]*active\?\.pendingActivePlanTail[^]*appendActivePlanTail\(canonicalQueueItem\?\.hiddenContent \?\? "", planTail\)/);
	assert.match(beforeStart, /planTail === ACTIVE_PLAN_CLEAR_TOMBSTONE\) clearActivePlanAwareness\(active\.awarenessKey\)/);
	assert.match(beforeStart, /markActivePlanAwareness\(active\.awarenessKey, planTail\)/);
});
