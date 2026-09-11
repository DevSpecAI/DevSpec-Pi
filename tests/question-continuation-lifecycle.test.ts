import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { shouldTerminateAfterDirectedQuestionCreate } from "../extensions/devspec-tools.ts";

const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const tools = readFileSync(new URL("../extensions/devspec-tools.ts", import.meta.url), "utf8");

function between(start: string, end: string): string {
	const from = remote.indexOf(start);
	const to = remote.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing ${start}..${end}`);
	return remote.slice(from, to);
}

test("only a receipt-owning successful directed-question create requests Pi termination", () => {
	const receipt = { details: { question: { transcriptMessageId: "11111111-1111-4111-8111-111111111111" } } };
	assert.equal(shouldTerminateAfterDirectedQuestionCreate("manage_directed_question", { action: "create" }, receipt), true);
	assert.equal(shouldTerminateAfterDirectedQuestionCreate("manage_directed_question", { action: "create", keep_turn: true }, receipt), false);
	assert.equal(shouldTerminateAfterDirectedQuestionCreate("manage_directed_question", { action: "create" }, { details: { question: { transcriptMessageId: null } } }), false);
	assert.equal(shouldTerminateAfterDirectedQuestionCreate("manage_directed_question", { action: "create" }, { details: { question: {} } }), false);
	for (const action of ["list", "get", "cancel"]) {
		assert.equal(shouldTerminateAfterDirectedQuestionCreate("manage_directed_question", { action }, receipt), false, action);
	}
	assert.equal(shouldTerminateAfterDirectedQuestionCreate("manage_plan", { action: "create" }, receipt), false);
	assert.equal(shouldTerminateAfterDirectedQuestionCreate("manage_poll", { action: "create" }, receipt), false);
	const successPath = tools.slice(tools.indexOf("const projected = unwrapOrThrow"), tools.indexOf("} catch (err)", tools.indexOf("const projected = unwrapOrThrow")));
	assert.match(successPath, /shouldTerminateAfterDirectedQuestionCreate\(name, args, projected\)[^]*terminate: true/);
	assert.ok(tools.indexOf("const projected = unwrapOrThrow") < tools.indexOf("terminate: true as const"));
});

test("installed Pi termination is batch-safe and stops only an all-terminating tool batch", () => {
	const loop = readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js", import.meta.url), "utf8");
	assert.match(loop, /hasMoreToolCalls = !executedToolBatch\.terminate/);
	assert.match(loop, /finalizedCalls\.length > 0 && finalizedCalls\.every\(\(finalized\) => finalized\.result\.terminate === true\)/);
});

test("exact interaction activity starts before custom persistence and never uses connection-scoped pickup", () => {
	const apply = between("async function applyInteractionEvent", "async function acknowledgeInteractionApplication");
	const exactStartAt = apply.indexOf("await startInteractionContinuation(active, event)");
	assert.ok(exactStartAt >= 0 && exactStartAt < apply.indexOf("interactionDelivery.stage({", exactStartAt));
	const start = between("async function startInteractionContinuation", "async function keepInteractionContinuationAlive");
	assert.match(start, /"report_pickup"[^]*interactionContinuationStartArgs\(event\)/);
	assert.match(start, /connectionCapability: active\.bond\.connectionCapability/);
	assert.doesNotMatch(start, /connection_id: authority\.connectionId\s*\n\s*\}/,
		"report_pickup must carry the event tuple, not connection identity alone");
	assert.match(apply, /startAction === "release"[^]*releaseInteractionBeforePersistence/);
	assert.match(remote, /interaction_pre_persistence_failure: true/);
	assert.equal((remote.match(/async function pumpLoop/g) ?? []).length, 1);
});

test("persisted custom application ACKs mechanically while busy before model settlement", () => {
	const confirmation = between("async function attemptInteractionPersistenceConfirmation", "function confirmInteractionMessageAfterPersistence");
	assert.match(confirmation, /result === "confirmed"[^]*run\.application = "applied"[^]*await acknowledgeInteractionApplication\(confirmation\.run\)/);
	const ack = between("async function acknowledgeInteractionApplication", "async function attemptInteractionPersistenceConfirmation");
	assert.match(ack, /"poll_connection"[^]*interactionEventAckArgs[^]*catch_up: true[^]*wait_ms: 0/);
	assert.match(ack, /connectionCapability: run\.authority\.connectionCapability/);
	assert.doesNotMatch(ack, /agent_settled|ctx\.isIdle/);
});

test("trail, final, keepalive, fallback, and process exit carry the exact interaction tuple", () => {
	assert.match(remote, /postToSession\(rendered, \{ phase: "trail"[^]*interaction: interactionIdentity\(postingTurn\.interaction\)/);
	assert.match(remote, /phase: "answer"[^]*interaction: interactionIdentity\(t\.interaction\)/);
	const keepalive = between("async function keepInteractionContinuationAlive", "async function releaseInteractionBeforePersistence");
	assert.match(keepalive, /interactionAuthorityCurrent\(run\.authority\)[^]*await resolveToken\(\)[^]*interactionAuthorityCurrent\(run\.authority\)/);
	assert.match(keepalive, /connection_id: run\.authority\.connectionId[^]*exactInteractionContinuationArgs\(run\.identity\)/);
	assert.match(keepalive, /await callDevspec[^]*return interactionRunIsLive\(run\) && interactionAuthorityCurrent\(run\.authority\)/);
	assert.doesNotMatch(keepalive, /active\.bond\.connectionId/);
	assert.match(remote, /reportComplete\("turn_end", commandTurnId, commandMessageId, commandTurnUnbound, interactionIdentity\(interactionRun\)\)/);
	assert.match(remote, /reportComplete\("process_exit", openTurn\.commandTurnId, openTurn\.commandMessageId, isCommandTurnUnbound\(openTurn\), interactionIdentity\(openTurn\.interaction\)\)/);
	assert.match(remote, /command_turn_unbound: true[^]*exactInteractionContinuationArgs/);
});

test("busy wakes include system notices and stale settle cannot clear a newer runtime revision", () => {
	const signal = between("function signalWake", "function interactionEventsRelevant");
	assert.match(signal, /idleBoundaryWake\.noteWake\(active\.busy \|\| active\.runtimeOccupancy\.isBusy\(\)\)/);
	assert.match(signal, /active\.wakeGate\.signal\(\)/);
	assert.doesNotMatch(signal, /wakePending|wakeWaiter/);
	const started = between('pi.on("agent_start"', 'pi.on("agent_settled"');
	assert.match(started, /runtimeOccupancy\.begin\(requestedKind\)/);
	assert.match(started, /requestedKind = newInteractionRun \? "interaction" : systemNoticeTurnPending \? "system_notice" : "owner"/);
	assert.match(started, /const completionNeutral = occupancy\?\.kind === "system_notice"/);
	const settled = between('pi.on("agent_settled"', "// ---- Turn lifecycle events");
	assert.match(settled, /runtimeOccupancy\.finish\(occupancyAtSettle\)\)\) return/);
	assert.match(settled, /idleBoundaryWake\.consumeAtIdle\(trueIdle\)\) signalWake\(pump\)/);
	assert.doesNotMatch(settled, /pumpLoop\(/);
});

test("busy reattach aborts and neutralizes revoked exact interaction authority", () => {
	const revoke = between("function revokeInteractionForAttachmentChange", "function interactionApplicationDetails");
	assert.match(revoke, /ctx\.abort\(\)/);
	assert.match(revoke, /interactionDelivery\.abandonMessage/);
	assert.match(revoke, /run\.application = "released"/);
	assert.match(revoke, /turn\.interaction = undefined[^]*turn\.completionNeutral = true/);
	assert.match(revoke, /pendingInteractionStarts\.clear\(\)[^]*pendingInteractionReleases\.clear\(\)/);
	const attachment = between("const serverSessionId =", "if (interactionEvent) {");
	assert.match(attachment, /serverSessionId !== \(active\.bond\.sessionId \?\? null\)[^]*revokeInteractionForAttachmentChange\(active, ctx\)/);
});

test("ambiguous start and release calls retain exact pump retries", () => {
	const apply = between("async function applyInteractionEvent", "async function drainInteractionRetries");
	assert.match(apply, /pi_appendInteractionEntry\("observed", observedDetails\)[^]*await startInteractionContinuation/);
	assert.match(apply, /retainInteractionStartRetry\(active, event, authority\.localSessionId\)/);
	assert.match(apply, /startedSourceMatches[^]*started\.sourceSessionId === event\.source_session_id[^]*startAction === "release"/);
	const release = between("async function releaseInteractionBeforePersistence", "/**\n * Post a captured segment");
	assert.match(release, /retainInteractionReleaseRetry\(run\)/);
	const drain = between("async function drainInteractionRetries", "async function acknowledgeInteractionApplication");
	assert.match(drain, /pendingInteractionReleases[^]*releaseInteractionBeforePersistence/);
	assert.match(drain, /pendingInteractionStarts[^]*applyInteractionEvent/);
	assert.match(drain, /active\.generation !== run\.authority\.generation/);
	assert.doesNotMatch(drain.slice(0, drain.indexOf("for (const [eventId, pending] of [...active.pendingInteractionStarts]")), /getSessionId|sourceSessionId/,
		"exact release retry survives local-session changes and targets original authority");
});

test("owner polling is deferred by server activity while Pi suppresses generic busy mutation", () => {
	const pump = between("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /!activeInteractionRun\(active\) \? \{ busy: active\.busy \} : \{\}/);
	assert.match(pump, /interactionEventAck[^]*catch_up: true/);
	assert.match(pump, /await applyInteractionEvent\(active, ctx, interactionEvent\)/);
});

test("a busy question answer aborts then applies the exact continuation, never an owner command", () => {
	const pump = between("if (interactionEvent) {", "// Titles are job-generated");
	assert.match(pump, /decideInteractionDelivery\(\{[^]*hasEvent: true[^]*\}\) === "preempt"/s);
	assert.match(pump, /pi_abort\(\)/);
	assert.match(pump, /waitUntil\([^]*ctx\.isIdle\(\) && !active\.busy && !active\.runtimeOccupancy\.isBusy\(\)/s);
	assert.ok(pump.indexOf("pi_abort()") < pump.indexOf("await applyInteractionEvent"));
	assert.doesNotMatch(pump, /sendUserMessage|pi_send\(/);
	const apply = between("async function applyInteractionEvent", "async function drainInteractionRetries");
	assert.match(apply, /retainInteractionStartRetry\(active, event, ctx\.sessionManager\.getSessionId\(\)\)/);
	assert.match(apply, /started\.outcome === "blocked_by_activity"[^]*retainInteractionStartRetry/s);
});
