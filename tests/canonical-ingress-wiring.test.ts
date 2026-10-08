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

test("main Pi poll capacity-gates system notices while control ack cannot claim them", () => {
	const calls = [...source.matchAll(/callDevspec\([^]*?"poll_connection"[^]*?\{([^]*?)\}, \{/gu)];
	assert.equal(calls.length, 4, "expected control ACK, exact interaction ACK, read-only room recovery and main pump poll");
	for (const call of [calls[2]!, calls[3]!]) {
		assert.match(call[1], /ingress_version: 1/);
		assert.match(call[1], /delegated_scope_version: 1/);
		assert.match(call[1], /active_plan_projection_version: 1/);
	}
	assert.match(calls[0]![1], /control_ack_only: true/);
	assert.doesNotMatch(calls[0]![1], /system_notice_version|system_notice_cursor|cursor_v2/, "ackControl must never consume intake");
	// The exact-event ACK is built by interactionEventAckArgs, which emits
	// `interaction_event_ack` for an answer and `question_dismissal_event_ack` for a
	// responder dismissal (debec963). The pin follows the helper call, not one key.
	assert.match(calls[1]![1], /\.\.\.interactionEventAckArgs\(interactionEventAck\(run\.details\.event\)\)/);
	assert.match(calls[1]![1], /catch_up: true/);
	//1.6 requires notice negotiation even on inactive history reads. Recovery
	// obtains its cursor/catch_up pair from the tested read-only coordinator.
	assert.match(calls[2]![1], /room_context_version: 1[^]*\.\.\.args/);
	const recovery = readFileSync(new URL("../extensions/core/room-sync.ts", import.meta.url), "utf8");
	assert.match(recovery, /if \(!cursor\) return[^]*cursor_v2: cursor, catch_up: true/);
	assert.match(recovery, /!pkg\.roomPage\?\.history[^]*pkg\.ownerBundle[^]*pkg\.control[^]*pkg\.systemNotices\.length/);
	assert.doesNotMatch(recovery, /pi_send|sendUserMessage|sendMessage|interactionEventAckArgs/);
	assert.match(calls[3]![1], /\.\.\.\(systemNoticeNegotiated \? \{/);
	assert.match(calls[3]![1], /system_notice_version: 1/);
	assert.match(calls[3]![1], /system_notice_cursor: active\.systemNoticeCursor/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /const systemNoticeNegotiated = hasSystemNoticeBatchCapacity\(active\.systemNoticeKey\)/);
	assert.match(pump, /cursor_v2: active\.cursor/);
	assert.match(pump, /if \(!commandDeliveryFailed && !commandOfferHoldsCursor\)[^]*active\.cursor = pkg\.cursorV2/);
	assert.match(pump, /acceptSystemNotices\(active\.systemNoticeKey, pkg\.systemNotices\)[^]*active\.systemNoticeCursor = pkg\.systemNoticeCursor/);
	assert.doesNotMatch(pump, /active\.cursor\s*=\s*[^;]*next_cursor|\bcursor: active\.cursor/);
});

test("system notices use a fresh harness custom turn and never user/followUp/steer delivery", () => {
	const sender = bodyBetween("pi_systemNoticeSend =", "pi_send =");
	assert.match(sender, /customType: SYSTEM_NOTICE_CUSTOM_TYPE/);
	assert.match(sender, /pi\.sendMessage\(/);
	assert.match(sender, /triggerTurn: true/);
	assert.doesNotMatch(sender, /sendUserMessage|deliverAs|followUp|steer/);

	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /if \(!active\.busy && ctx\.isIdle\(\)\)[^]*deliverQueuedSystemNotices/);
	const started = bodyBetween('pi.on("agent_start"', 'pi.on("agent_settled"');
	assert.ok(started.indexOf("const completionNeutral = occupancy?.kind === \"system_notice\"") < started.indexOf("active.busy = true"));
	assert.match(started, /const activityPolicy = remoteRunActivityPolicy\(completionNeutral\)[^]*else if \(active && activityPolicy\.reportPresence\)[^]*active\.busy = true[^]*beatBusy\(true\)/);
	const settled = bodyBetween('pi.on("agent_settled"', "// ---- Turn lifecycle events");
	// Settle parks presence only while owned background work is outstanding
	// (759f2818 refined, owner direction PM) — never behind the deleted
	// shouldPauseSettle speech gate.
	assert.match(settled, /const activityPolicy = remoteRunActivityPolicy\(completionNeutral\)[^]*if \(pump && activityPolicy\.reportPresence\)[^]*pump\.busy = keepWorking[^]*beatBusy\(keepWorking/);
	assert.match(settled, /pump && !pump\.busy && ctx\.isIdle\(\)[^]*deliverQueuedSystemNotices/);
	assert.match(settled, /!posted && activityPolicy\.reportCompletion[^]*completeTurnActivity\(settlingTurn, "turn_end"/);
	const runtimeStamp = bodyBetween("function scheduleRuntimeStamp", "/** Settle the turn's usage");
	assert.match(runtimeStamp, /const completionNeutralAtSchedule = systemNoticeRunActive \|\| systemNoticeTurnPending/);
	assert.match(runtimeStamp, /if \(!completionNeutralAtSchedule && !systemNoticeRunActive\) void beatBusy/);
	const beat = bodyBetween("async function beatBusy", "function notify");
	assert.match(beat, /if \(!active \|\| active\.stop \|\| systemNoticeRunActive\) return/);

	const split = bodyBetween("function splitTurnAtBoundary", "/**\n * Assert busy presence");
	assert.match(split, /completionNeutral: t\.completionNeutral/);
	const answer = bodyBetween("async function postSegmentAnswer", "async function settleTurn");
	assert.match(answer, /if \(!remoteRunActivityPolicy\(t\.completionNeutral\)\.reportTranscript\) return false/);
	const trail = bodyBetween("function trailTick", "/**\n * Explicitly close");
	assert.match(trail, /if \(!turn \|\| !remoteRunActivityPolicy\(turn\.completionNeutral\)\.reportTranscript\) return/);
	const shutdown = bodyBetween('pi.on("session_shutdown"', 'pi.on("session_start"');
	assert.match(shutdown, /revokeSystemNoticeState\(active\.systemNoticeKey\)/);
	assert.match(shutdown, /if \(openTurn && remoteRunActivityPolicy\(openTurn\.completionNeutral\)\.reportCompletion\)[^]*completeTurnActivity\(openTurn, "process_exit"/);
});

test("same-run real user boundary ends notice neutrality before normal presence and settle", () => {
	const messageStart = bodyBetween('pi.on("message_start"', 'pi.on("message_update"');
	assert.match(messageStart, /transitionToRealUserActivity\(\{[^]*systemNoticeRunActive[^]*segmentCompletionNeutral: turn\.completionNeutral/);
	assert.match(messageStart, /isDeliveryBoundary\(turn\.tracker\) \|\| activityTransition\?\.beginBusyPresence[^]*splitTurnAtBoundary\(\)/);
	const endNeutral = messageStart.indexOf("systemNoticeRunActive = activityTransition?.nextSystemNoticeRunActive");
	const bindTurn = messageStart.indexOf("turn.commandTurnId = incomingCommand?.turnId");
	const trackUser = messageStart.indexOf("turn.tracker.userMessage(text, { customType })");
	const beginBusy = messageStart.indexOf("pump.busy = true", trackUser);
	const beat = messageStart.indexOf("beatBusy(true)", beginBusy);
	assert.ok(endNeutral >= 0 && endNeutral < bindTurn && bindTurn < trackUser && trackUser < beginBusy && beginBusy < beat);
	assert.match(messageStart, /const previousPolicy = activityTransition\?\.previousPolicy[^]*if \(previousPolicy\.reportCompletion\)[^]*completeTurnActivity/);
	assert.match(messageStart, /turn\.occupancy\?\.kind === "system_notice"[^]*runtimeOccupancy\.promote\(turn\.occupancy, "owner"\)[^]*turn\.occupancy = promoted/);

	const split = bodyBetween("function splitTurnAtBoundary", "/**\n * Assert busy presence");
	assert.match(split, /const previousPolicy = remoteRunActivityPolicy\(t\.completionNeutral\)/);
	assert.match(split, /!posted && previousPolicy\.reportCompletion[^]*completeTurnActivity/);
	const settled = bodyBetween('pi.on("agent_settled"', "// ---- Turn lifecycle events");
	assert.match(settled, /const completionNeutral = occupancyAtSettle\?\.kind === "system_notice" \|\| settlingTurn\?\.completionNeutral === true/);
});

test("recoverable server ends revive the same bond instead of spinning on an ended row", () => {
	const recovery = bodyBetween("async function reviveRecoverableBond", "async function pumpLoop");
	assert.match(recovery, /"register_connection"[^]*local_id: localId[^]*connection_capability_version: 1/);
	assert.match(recovery, /if \(!sessionId && prior\.sessionId\)[^]*"attach_connection"[^]*session_id: prior\.sessionId/);
	assert.match(recovery, /active\.bond = bond[^]*setBond\(bond\)[^]*startPushChannel\(active/);
	assert.match(recovery, /planRecoveredConnectionScope\([^]*currentConnectionId: prior\.connectionId[^]*nextConnectionId: connectionId/);
	assert.match(recovery, /active\.generation = recoveredScope\.generation[^]*active\.cursor = recoveredScope\.cursor[^]*active\.systemNoticeCursor = recoveredScope\.systemNoticeCursor[^]*active\.connectionIdentity = recoveredScope\.connectionIdentity/);
	assert.match(recovery, /active\.automationQueue\.invalidate\(\)[^]*active\.automationQueue = new DeliveryQueue\(\)[^]*automationRetryTimers\.clear\(\)[^]*automationRetryAttempts\.clear\(\)/);
	assert.match(recovery, /revokeSystemNoticeState\(active\.systemNoticeKey\)[^]*active\.systemNoticeKey = bindSystemNoticeState/);
	assert.doesNotMatch(recovery, /new SeenOwnerCommands|seenOwnerCommands\s*=/,
		"same-row revival must retain exactly-once command memory");

	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.equal((pump.match(/await reviveRecoverableBond\(active, token, ctx\)/g) ?? []).length, 2,
		"push and long-poll ended paths both revive mechanically");
	assert.match(pump, /push ended recoverable[^]*await reviveRecoverableBond/);
	assert.match(pump, /poll recoverable server response[^]*await reviveRecoverableBond/);
});

test("awaited transcript writes revalidate immutable pump authority before posting", () => {
	const post = bodyBetween("async function postToSession", "function trackTerminalPost");
	// Baseline28b0983 already delegates this guard to capturePostAuthority;
	// pin the real fence, not the obsolete inlined implementation (829394e9).
	const capture = bodyBetween("function capturePostAuthority", "async function postToSession");
	assert.match(capture, /pump === active[^]*active\.generation === generation/);
	assert.match(capture, /getBond\(\)\?\.connectionId === connectionId[^]*getBond\(\)\?\.sessionId === sessionId/);
	assert.match(post, /capturePostAuthority\(\)[^]*await resolveToken\(\)[^]*!isCurrent\(\)/);
	assert.match(post, /beforeSend: \(\) => \{ if \(!isCurrent\(\)\) throw/);
	assert.match(post, /connection_id: authority\.connectionId/);
	const complete = bodyBetween("async function reportComplete", "/**\n * Post a captured segment's answer");
	assert.match(complete, /capturePumpAuthority\([^]*await resolveToken\(\)[^]*isPumpAuthorityCurrent/);
	assert.match(complete, /connection_id: authority\.connectionId/);
});

test("automation retry revalidation cannot cross recovered connection authority", () => {
	const retry = bodyBetween("function scheduleAutomationRetry", "function enqueueAutomationRun");
	assert.match(retry, /capturePumpAuthority\([^]*const authorityIsCurrent/);
	assert.match(retry, /if \(!authorityIsCurrent\(\)\) return[^]*assertCurrent: \(\) => \{[^]*!authorityIsCurrent\(\)/);
	assert.match(retry, /if \(authorityIsCurrent\(\)\) scheduleAutomationRetry/);
});

test("canonical parser output stays independent from automation dispatch and control paths", () => {
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /parsePollPayload\(payload, active\.connectionIdentity, \{ systemNoticeNegotiated, senderStyleNegotiated, roomContextNegotiated, sessionEventsNegotiated: roomContextNegotiated && roomWatch\.session_events_version === 1 \}\)/);
	assert.match(pump, /pkg\.ownerBundle/);
	assert.match(pump, /pkg\.control/);
	assert.match(pump, /for \(const dispatch of dispatches\) enqueueAutomationRun/);
	// The offer controller receives the raw availability sidecar PLUS already-
	// validated pkg commands; it must never read legacy payload.commands itself.
	assert.doesNotMatch(pump, /\bpayload\s*(?:\??\.|\[)\s*["']?commands\b|\(\s*payload\s+as[^)\n]*\)\s*\??\.commands\b|buildRoomDigest|owner_ambient|\.room_context\b/);
	assert.match(pump, /pi_receiveCommandOffer\(payload, active, ctx, pkg\.ownerBundle\?\.commands \?\? \[\]\)/);
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
	assert.match(beforeStart, /appendActivePlanTail\(\s*appendActivePlanTail\(canonicalQueueItem\?\.hiddenContent \?\? "", planTail\),\s*pollTail/s);
	assert.match(beforeStart, /customType: canonicalQueueItem \? REMOTE_INGRESS_CONTEXT_CUSTOM_TYPE : "devspec-active-session-plans"/);
	assert.match(beforeStart, /content: hiddenContent/);
	assert.match(beforeStart, /display: false/);
});

test("attached bonds independently activate native plan and directed-question management", () => {
	const bond = bodyBetween("async function bondNow", "// Late-bound");
	assert.match(bond, /pi_setPlanToolActive\(Boolean\(bond\.sessionId\)\)/);
	assert.match(bond, /pi_setQuestionToolActive\(Boolean\(bond\.sessionId && bond\.connectionCapability\)\)/);
	assert.match(bond, /pi_setPollToolActive\(Boolean\(bond\.sessionId && bond\.connectionCapability\)\)/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /pi_setPlanToolActive\(Boolean\(serverSessionId\)\)/);
	assert.match(pump, /pi_setQuestionToolActive\(Boolean\(serverSessionId && next\.connectionCapability\)\)/);
	assert.match(pump, /pi_setPollToolActive\(Boolean\(serverSessionId && next\.connectionCapability\)\)/);
	assert.match(pump, /pi_setPlanToolActive\(Boolean\(active\.bond\.sessionId \|\| planTail\)\)/);
	assert.match(pump, /authoritativeActivePlanTransitionTail\([^]*active\.awarenessKey[^]*active\.activePlanTail[^]*""/,
		"detach/replacement consults persistent injected awareness");
	assert.match(bond, /awarenessKey: localId/);
	const stop = bodyBetween("async function stopPump", "/** Wake the pump's SSE waiter");
	assert.doesNotMatch(stop, /clearActivePlanAwareness|resetActivePlanAwareness/, "stop preserves injected awareness for rebond");
	const setter = bodyBetween("pi_setPlanToolActive =", 'pi.on("model_select"');
	assert.match(setter, /withPlanToolActive\(pi\.getActiveTools\(\), enabled\)/);
	assert.match(setter, /withDirectedQuestionToolActive\(pi\.getActiveTools\(\), enabled\)/);
	assert.match(setter, /withPollToolActive\(pi\.getActiveTools\(\), enabled\)/);
	assert.doesNotMatch(setter, /MODEL_VERB_NAMES|allModelFacingTools|searchRareModelTools/);
});

test("validated plan projection appends at the canonical delivery tail without rewriting visible owner text", () => {
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /serializeActiveSessionPlansProjection\(pkg\.activeSessionPlans, active\.bond\.connectionId\)/);
	assert.match(pump, /serializeSessionPollsProjection\(pkg\.sessionPolls\)/);
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	assert.match(delivery, /hiddenContent: formatCanonicalDeliveryContext\(hydrated, contexts\)/);
	assert.match(delivery, /pi_send\(formatted/);
	assert.doesNotMatch(delivery, /formatted\s*=\s*appendActivePlanTail|hiddenContent: appendActivePlanTail|event\.systemPrompt/);
	const beforeStart = bodyBetween('pi.on("before_agent_start"', 'pi.on("message_start"');
	assert.match(beforeStart, /activePlanTailForDelivery\([^]*Boolean\(canonicalQueueItem\)[^]*active\?\.activePlanTail[^]*active\?\.pendingActivePlanTail/);
	assert.match(beforeStart, /activePlanTailForDelivery\([^]*Boolean\(canonicalQueueItem\)[^]*active\?\.sessionPollsTail[^]*active\?\.pendingSessionPollsTail/);
	assert.match(beforeStart, /appendActivePlanTail\([^]*appendActivePlanTail\(canonicalQueueItem\?\.hiddenContent \?\? "", planTail\)[^]*pollTail/);
	assert.match(beforeStart, /planTail === ACTIVE_PLAN_CLEAR_TOMBSTONE\) clearActivePlanAwareness\(active\.awarenessKey\)/);
	assert.match(beforeStart, /markActivePlanAwareness\(active\.awarenessKey, planTail\)/);
});

test("auto-bond surfaces a failed register instead of staying silent", () => {
	const start = bodyBetween('pi.on("session_start"', 'pi.on("session_tree"');
	assert.match(start, /const outcome = await projectSelection\.connect\(ctx\)/);
	assert.match(start, /auto-bonded as \$\{outcome\.codename/);
	assert.match(start, /auto-bond failed: \$\{outcome\.error\}/);
	assert.match(start, /outcome\.errorKind === "auth" \? "warning" : "error"/);
});

test("main Pi poll negotiates sender style with system notices and keeps styles in force per LLM call", () => {
	const calls = [...source.matchAll(/callDevspec\([^]*?"poll_connection"[^]*?\{([^]*?)\}, \{/gu)];
	// Sender style rides the same negotiated spread: the server requires
	// system_notice_version: 1 as its prerequisite (item 6a511dab).
	assert.match(calls[3]![1], /system_notice_version: 1[^]*sender_style_version: 1/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /const senderStyleNegotiated = systemNoticeNegotiated/);
	assert.match(pump, /parsePollPayload\(payload, active\.connectionIdentity, \{ systemNoticeNegotiated, senderStyleNegotiated, roomContextNegotiated, sessionEventsNegotiated: roomContextNegotiated && roomWatch\.session_events_version === 1 \}\)/);
	assert.match(pump, /activeCommandStyles\.set\(hydrated\.commandTurnId, deliveredStyles\)/);
	const context = bodyBetween('pi.on("context"', 'pi.on("turn_start"');
	assert.match(context, /senderStyleRepairNeeded\(event\.messages, true\)/);
	assert.match(context, /formatSenderStyleRepair\(styledTurnId, styledCommands\)/);
	const clears = [...source.matchAll(/activeCommandStyles\.clear\(\);/g)];
	assert.equal(clears.length, 4, "style state clears everywhere bindings clear");
	assert.match(source, /activeCommandStyles\.delete\(commandTurnId\)/);
});
