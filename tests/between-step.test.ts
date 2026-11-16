/**
 * Between-step delivery (DevSpec item da5cfae5; decisions b8abe2bb, 1d5a9c56):
 * what waits, how it leaves exactly once, what the agent is shown, and how the
 * running turn's kind is left alone. The wiring is in between-step-wiring.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BETWEEN_STEP_CUSTOM_TYPE,
	BetweenStepLedger,
	betweenStepDeliveryId,
	deliverIdleCheckJobs,
	formatBetweenStepMessage,
	isBetweenStepDelivery,
	type WaitingCheckJob,
} from "../extensions/core/between-step.ts";
import { CHECK_JOB_CONTRACT_URI, CHECK_JOB_HELPERS_POINTER, formatCheckJobsMessage, servedCheckJobHelpers } from "../extensions/core/dispatch.ts";
import { noticeIdsFromDelivery } from "../extensions/core/notice-reply.ts";
import type { SystemNoticeV1 } from "../extensions/core/remote-payload.ts";
import { formatSystemNoticeMessage } from "../extensions/core/system-notice.ts";
import { CHECK_JOB_PREFIX, classifyUserKind, isHarnessOrigin, TurnTracker, type UserKind } from "../extensions/core/turn-lifecycle.ts";

const JOB_A = "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11";
const JOB_B = "4f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e22";
const JOB_C = "5f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e33";
const NEEDS = "17171717-1717-4171-8171-171717171717";
const RECORD = "18181818-1818-4181-8181-181818181818";

const job = (id: string, title = "Ship the export button") => ({
	id, kind: "check_job", check_job_id: id, check_kind: "conflict_decisions",
	record: { type: "task", id: "9b2d6c1e-1111-4222-8333-444455556666", title },
	entries: 3, yours: true, offered_at: "2026-11-04T02:00:00.000Z", delivery_connection_id: "conn-1",
});
const notice = (notice_id: string, audience: "needs_person" | "for_the_record"): SystemNoticeV1 => ({
	version: 1, kind: "server_notice", notice_id, topic: "coherence_finding", notice_type: "coherence_finding",
	summary: "A finding", prompt: "Handle the finding.", records: [], allowed_outcomes: ["resolved"], allowed_tools: ["update_task"], audience,
} as unknown as SystemNoticeV1);

// ---- Exactly once ----------------------------------------------------------

test("every check job waiting when a step ends leaves in one steer, and is committed only when the agent is shown it", () => {
	const ledger = new BetweenStepLedger();
	assert.equal(ledger.admitCheckJob(JOB_A, job(JOB_A)), true);
	assert.equal(ledger.admitCheckJob(JOB_B, job(JOB_B)), true);
	assert.equal(ledger.admitCheckJob(JOB_A, job(JOB_A)), false, "the wake channel lists the open set again: once is enough");
	const batch = ledger.beginSteer([NEEDS], "steer-1")!;
	assert.deepEqual(batch.checkJobs.map((entry) => entry.id), [JOB_A, JOB_B], "both, in arrival order, in one batch");
	assert.deepEqual(batch.noticeIds, [NEEDS]);
	// Handed to Pi, not yet shown: nothing is committed.
	assert.equal(ledger.steerInFlight, true);
	assert.deepEqual(ledger.waitingCheckJobs().map((entry) => entry.id), [JOB_A, JOB_B]);
	// Pi shows it to the agent.
	assert.equal(ledger.observe("steer-1"), batch);
	assert.equal(ledger.steerInFlight, false);
	assert.deepEqual(ledger.waitingCheckJobs(), [], "a steered job is not waiting at the end of the turn");
	assert.equal(ledger.runEnded(), null, "nothing is left to deliver again when the run ends");
});

test("a repeat sight of the same steer, or a steer nobody is waiting on, commits nothing", () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	ledger.beginSteer([], "steer-1");
	assert.ok(ledger.observe("steer-1"));
	ledger.admitCheckJob(JOB_B, job(JOB_B));
	assert.equal(ledger.observe("steer-1"), null, "the same steer seen twice");
	assert.equal(ledger.observe("someone-elses"), null);
	assert.deepEqual(ledger.waitingCheckJobs().map((entry) => entry.id), [JOB_B], "the job that arrived later still waits");
});

test("only one steer is in flight; what arrives meanwhile joins the next one", () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	assert.ok(ledger.beginSteer([], "steer-1"));
	ledger.admitCheckJob(JOB_B, job(JOB_B));
	assert.equal(ledger.beginSteer([NEEDS], "steer-2"), null, "the first has not reached the agent yet");
	ledger.observe("steer-1");
	const next = ledger.beginSteer([NEEDS], "steer-2")!;
	assert.deepEqual(next.checkJobs.map((entry) => entry.id), [JOB_B]);
	assert.deepEqual(next.noticeIds, [NEEDS]);
});

test("nothing waiting means no steer; notices alone are enough for one", () => {
	const ledger = new BetweenStepLedger();
	assert.equal(ledger.beginSteer([], "steer-1"), null);
	assert.equal(ledger.steerInFlight, false);
	const batch = ledger.beginSteer([NEEDS, RECORD], "steer-2")!;
	assert.deepEqual(batch.checkJobs, []);
	assert.deepEqual(batch.noticeIds, [NEEDS, RECORD]);
});

test("a run that ends before Pi shows the steer leaves its batch waiting, to go out idle", () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	const batch = ledger.beginSteer([NEEDS], "steer-1");
	assert.equal(ledger.runEnded(), batch, "the run was stopped and Pi dropped its queue");
	assert.equal(ledger.steerInFlight, false);
	assert.deepEqual(ledger.waitingCheckJobs().map((entry) => entry.id), [JOB_A], "never committed, so still waiting");
	// Should Pi show that old steer after all, nothing is committed a second time by it.
	assert.equal(ledger.observe("steer-1"), null);
	assert.deepEqual(ledger.waitingCheckJobs().map((entry) => entry.id), [JOB_A]);
});

test("a steer Pi refused is not in flight, and a withdrawn job is gone", () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	ledger.beginSteer([], "steer-1");
	ledger.abandonSteer("another");
	assert.equal(ledger.steerInFlight, true);
	ledger.abandonSteer("steer-1");
	assert.equal(ledger.steerInFlight, false);
	assert.equal(ledger.withdrawCheckJob(JOB_A), true);
	assert.equal(ledger.hasWaitingCheckJobs(), false);
	assert.equal(ledger.beginSteer([], "steer-2"), null);
});

// ---- Idle delivery ----------------------------------------------------------

function idle(ledger: BetweenStepLedger, options: { ready?: () => boolean; current?: () => boolean; pending?: (id: string) => Promise<boolean> | boolean; send?: (jobs: readonly WaitingCheckJob[]) => void } = {}) {
	const sent: string[][] = [];
	const asked: string[] = [];
	const run = () => deliverIdleCheckJobs({
		ledger,
		ready: options.ready ?? (() => true),
		current: options.current ?? (() => true),
		stillPending: async (id) => { asked.push(id); return options.pending ? options.pending(id) : true; },
		send: options.send ?? ((jobs) => { sent.push(jobs.map((entry) => entry.id)); }),
	});
	return { sent, asked, run };
}

test("an idle Pi is sent every waiting check job in one wake, straight away", async () => {
	const ledger = new BetweenStepLedger();
	for (const id of [JOB_A, JOB_B, JOB_C]) ledger.admitCheckJob(id, job(id));
	const h = idle(ledger);
	assert.equal(await h.run(), "sent");
	assert.deepEqual(h.sent, [[JOB_A, JOB_B, JOB_C]], "one wake, all three: no job waits a turn for the one before it");
	assert.deepEqual(ledger.waitingCheckJobs(), []);
	assert.equal(await h.run(), "nothing", "and never a second time");
	assert.deepEqual(h.sent.length, 1);
});

test("a check job DevSpec no longer lists is dropped without waking anyone", async () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	ledger.admitCheckJob(JOB_B, job(JOB_B));
	const h = idle(ledger, { pending: (id) => id === JOB_B });
	assert.equal(await h.run(), "sent");
	assert.deepEqual(h.asked, [JOB_A, JOB_B]);
	assert.deepEqual(h.sent, [[JOB_B]]);
	const none = new BetweenStepLedger();
	none.admitCheckJob(JOB_A, job(JOB_A));
	const settled = idle(none, { pending: () => false });
	assert.equal(await settled.run(), "nothing");
	assert.deepEqual(settled.sent, [], "no wake for a job that was ruled or handed on");
	assert.equal(none.hasWaitingCheckJobs(), false);
});

test("a busy Pi is never woken: the jobs keep waiting for its next step", async () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	const h = idle(ledger, { ready: () => false });
	assert.equal(await h.run(), "busy");
	assert.deepEqual(h.asked, [], "DevSpec is not even asked");
	assert.deepEqual(h.sent, []);
	assert.equal(ledger.hasWaitingCheckJobs(), true);
});

test("a run that starts while DevSpec is asked takes the jobs at its next step instead", async () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	let ready = true;
	const h = idle(ledger, { ready: () => ready, pending: () => { ready = false; return true; } });
	assert.equal(await h.run(), "busy");
	assert.deepEqual(h.sent, [], "no second run is started beside the one that began");
	assert.deepEqual(ledger.waitingCheckJobs().map((entry) => entry.id), [JOB_A]);
	// That run steers it at its first step boundary, and it is then delivered once.
	assert.ok(ledger.beginSteer([], "steer-1"));
	ledger.observe("steer-1");
	ready = true;
	assert.equal(await h.run(), "nothing");
});

test("a job that arrives while DevSpec is asked goes in the same wake", async () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	const h = idle(ledger, { pending: () => { ledger.admitCheckJob(JOB_B, job(JOB_B)); return true; } });
	assert.equal(await h.run(), "sent");
	assert.deepEqual(h.sent, [[JOB_A, JOB_B]]);
});

test("a wake Pi refuses leaves the jobs waiting; a replaced connection delivers nothing", async () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	await assert.rejects(idle(ledger, { send: () => { throw new Error("Pi refused"); } }).run(), /Pi refused/);
	assert.equal(ledger.hasWaitingCheckJobs(), true, "not committed, so the next attempt sends it");
	let current = true;
	const h = idle(ledger, { current: () => current, pending: () => { current = false; return false; } });
	assert.equal(await h.run(), "stale");
	assert.deepEqual(h.sent, []);
	assert.equal(ledger.hasWaitingCheckJobs(), true, "a stale pump changes nothing");
});

test("while a steer is in flight nothing leaves by the idle path", async () => {
	const ledger = new BetweenStepLedger();
	ledger.admitCheckJob(JOB_A, job(JOB_A));
	ledger.beginSteer([], "steer-1");
	const h = idle(ledger);
	assert.equal(await h.run(), "busy");
	assert.deepEqual(h.sent, []);
});

// ---- What the agent is shown -------------------------------------------------

test("the steer names every waiting check job and notice in one message, as nobody's request", () => {
	const notices = [notice(NEEDS, "needs_person"), notice(RECORD, "for_the_record")];
	const message = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [job(JOB_A), job(JOB_B, "Rename the plan")], notices, roomAttached: true, inRunningTurn: true });
	const lines = message.split("\n");
	assert.equal(lines[0], "[DevSpec between steps — to Wary Wolf]");
	assert.equal(lines[1], "DevSpec delivered this between two steps of the turn you are running. Nobody asked for it and it is no part of what you were asked to do: deal with all of it now, in this one pause, then carry on exactly where you left off.");
	assert.ok(message.includes(`- A check is waiting on Ship the export button (check_job_id ${JOB_A})`));
	assert.ok(message.includes(`- A check is waiting on Rename the plan (check_job_id ${JOB_B})`));
	assert.ok(message.includes(`"check_job_id": "${JOB_A}"`) && message.includes(`"check_job_id": "${JOB_B}"`), "both envelopes, with the ids a helper is given");
	assert.ok(message.includes(`notice_id=${JSON.stringify(NEEDS)}`) && message.includes(`notice_id=${JSON.stringify(RECORD)}`));
	// Each notice is in the notice message's own words, whole.
	assert.ok(message.endsWith(formatSystemNoticeMessage(notices, { roomAttached: true, inRunningTurn: true })));
	assert.throws(() => formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [], notices: [], roomAttached: true, inRunningTurn: true }), /at least one check job or notice/);
});

test("the agent hears where the helper rule is served before any check job is taken, in a wake and in a steer", () => {
	// Decision 1d5a9c56: the rule is the server's. The plugin points at it and adds
	// only what a helper agent is on Pi.
	assert.match(CHECK_JOB_HELPERS_POINTER, /semantics\.check_job\.helpers in devspec:\/\/product\/remote-ingress-contract/);
	assert.match(CHECK_JOB_HELPERS_POINTER, /repeated as `helpers` on every claim_check_job reply/);
	assert.match(CHECK_JOB_HELPERS_POINTER, /pi-subagents/);
	for (const message of [
		formatCheckJobsMessage([job(JOB_A)], "Wary Wolf"),
		formatCheckJobsMessage([job(JOB_A), job(JOB_B)], "Wary Wolf"),
		formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [job(JOB_A)], notices: [], roomAttached: false, inRunningTurn: true }),
	]) {
		const pointer = message.indexOf(CHECK_JOB_HELPERS_POINTER);
		assert.ok(pointer > 0, "the pointer is in the text that announces the job");
		assert.ok(pointer < message.indexOf("claim_check_job and every entry ruled"), "before the tools that take and rule it");
		assert.ok(pointer < message.indexOf("Check job envelope"), "and before the ids");
	}
});

test("DevSpec's own served words on helpers are quoted whole when the plugin holds them, never reworded", () => {
	const served = "Rule a check job in a helper agent wherever you can start one. Give the helper only the check_job_id.";
	const wake = formatCheckJobsMessage([job(JOB_A)], "Wary Wolf", { helpers: served });
	assert.ok(wake.includes(`DevSpec's words, as served now: ${served}`));
	assert.ok(wake.indexOf(CHECK_JOB_HELPERS_POINTER) < wake.indexOf(served), "the pointer comes first");
	const steer = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [job(JOB_A)], notices: [], roomAttached: true, inRunningTurn: true, helpers: served });
	assert.ok(steer.includes(`DevSpec's words, as served now: ${served}`));
	assert.doesNotMatch(formatCheckJobsMessage([job(JOB_A)], "Wary Wolf", { helpers: "  " }), /as served now/);
	assert.doesNotMatch(formatCheckJobsMessage([job(JOB_A)], "Wary Wolf"), /as served now/);
});

test("the served words are read from the contract the pointer names, and from nowhere else", () => {
	assert.ok(CHECK_JOB_HELPERS_POINTER.includes(CHECK_JOB_CONTRACT_URI));
	const contract = (extra: Record<string, unknown>) => ({ contents: [{ uri: CHECK_JOB_CONTRACT_URI, text: JSON.stringify({ kind: "devspec.product.remote_ingress_contract", ...extra }) }] });
	assert.equal(servedCheckJobHelpers(contract({ semantics: { check_job: { helpers: "Rule a check job in a helper agent." } } })), "Rule a check job in a helper agent.");
	// A server that serves no such rule, another document, or something unreadable: nothing is quoted.
	for (const resource of [
		contract({ semantics: { check_job: {} } }),
		contract({ semantics: { check_job: { helpers: "  " } } }),
		contract({ semantics: { check_job: { helpers: 7 } } }),
		contract({}),
		{ contents: [{ text: JSON.stringify({ kind: "devspec.product.implementation_contract", semantics: { check_job: { helpers: "elsewhere" } } }) }] },
		{ contents: [{ text: "not json" }, { text: 7 }, null] },
		{ contents: "none" }, {}, null, "text",
	]) assert.equal(servedCheckJobHelpers(resource), null);
});

test("one wake carries every waiting check job and still classifies as a check-job turn", () => {
	const wake = formatCheckJobsMessage([job(JOB_A), job(JOB_B, "Rename the plan")], "Wary Wolf");
	assert.ok(wake.startsWith(`${CHECK_JOB_PREFIX} to Wary Wolf]\n2 checks are waiting. Rule every one of them in this one pause:\n`));
	assert.equal(classifyUserKind(wake), "check_job");
	assert.match(wake, /Each job is taken with claim_check_job and every entry ruled with record_check_rulings\.\nThen carry on\.\n\nCheck job envelopes:/);
	const envelopes = JSON.parse(wake.slice(wake.indexOf("```json\n") + 8, wake.lastIndexOf("\n```")));
	assert.deepEqual(envelopes.map((entry: { check_job_id: string }) => entry.check_job_id), [JOB_A, JOB_B]);
	assert.throws(() => formatCheckJobsMessage([], "Wary Wolf"), /check job envelope required/);
	assert.throws(() => formatCheckJobsMessage([job(JOB_A), { kind: "check" }], "Wary Wolf"), /check job envelope required/);
});

test("a steer in a turn that answers someone keeps that turn's voice; a run that answers nobody still replies with its final message", () => {
	const needs = [notice(NEEDS, "needs_person")];
	const inTurn = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [], notices: needs, roomAttached: true, inRunningTurn: true });
	assert.match(inTurn, /This turn's messages reach your DevSpec room as part of the work you were already doing, and nothing is posted separately as a reply to this notice\./);
	assert.match(inTurn, /Mention a notice in them only when an unresolved choice, hold, rejection, or block still needs a person after you act \(semantics\.notice_audience\)/);
	assert.doesNotMatch(inTurn, /Your final message at the end of this run is posted/);
	const nobodys = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [], notices: needs, roomAttached: true, inRunningTurn: false });
	assert.match(nobodys, /Your final message at the end of this run is posted to your DevSpec room as your reply to this notice/);
	assert.doesNotMatch(nobodys, /This turn's messages reach your DevSpec room/);
	const quiet = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [], notices: [notice(RECORD, "for_the_record")], roomAttached: true, inRunningTurn: true });
	assert.match(quiet, /Every notice here is for the record \(the served contract's semantics\.notice_audience\): say nothing about it in those messages, unless a write's result carries tell_person\./);
	const mixed = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [], notices: [...needs, notice(RECORD, "for_the_record")], roomAttached: true, inRunningTurn: true });
	assert.match(mixed, /Those for the record are never mentioned \(semantics\.notice_audience\)\./);
	const unattached = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [], notices: needs, roomAttached: false, inRunningTurn: true });
	assert.match(unattached, /You are not attached to a DevSpec room, so your final message stays in this terminal\./);
});

test("a notice message delivered on its own run reads exactly as before", () => {
	const needs = [notice(NEEDS, "needs_person")];
	assert.equal(formatSystemNoticeMessage(needs, { roomAttached: true }), formatSystemNoticeMessage(needs, { roomAttached: true, inRunningTurn: false }));
	assert.match(formatSystemNoticeMessage(needs, { roomAttached: true }), /Your final message at the end of this run is posted to your DevSpec room as your reply to this notice/);
});

test("a check-job steer in a speaking turn points at the rule that keeps rulings out of the room", () => {
	const steer = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [job(JOB_A)], notices: [], roomAttached: true, inRunningTurn: true });
	assert.match(steer, /Write nothing in your messages about taking or ruling a check \(the served contract's check_job\.room\)\./);
	assert.doesNotMatch(steer, /Then carry on\.\n/, "the steer's opening already says to carry on where it left off");
});

test("the steer's details name the delivery and carry the notices a reply would name", () => {
	const details = { delivery_id: "steer-1", check_job_ids: [JOB_A], notices: [notice(NEEDS, "needs_person"), notice(RECORD, "for_the_record")], roomAttached: true };
	assert.equal(betweenStepDeliveryId(details), "steer-1");
	assert.deepEqual(noticeIdsFromDelivery(details), { needsPerson: [NEEDS], forTheRecord: [RECORD] });
	for (const bad of [null, undefined, "steer-1", [], {}, { delivery_id: "" }, { delivery_id: 7 }]) assert.equal(betweenStepDeliveryId(bad), null);
});

// ---- The running turn keeps its kind -----------------------------------------

test("a between-step delivery is context, never a person's message or a new turn", () => {
	const steer = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [job(JOB_A)], notices: [], roomAttached: true, inRunningTurn: true });
	assert.equal(isBetweenStepDelivery(steer, BETWEEN_STEP_CUSTOM_TYPE), true);
	assert.equal(isBetweenStepDelivery(steer, null), true, "a host that drops the type still recognises it by its opening words");
	assert.equal(isBetweenStepDelivery("Fix the export button", null), false);
	assert.equal(isHarnessOrigin(steer, BETWEEN_STEP_CUSTOM_TYPE), true);
	assert.equal(isHarnessOrigin(steer), true);
	assert.equal(classifyUserKind(steer, BETWEEN_STEP_CUSTOM_TYPE), "harness");
	// It names check jobs without becoming a check-job turn.
	assert.notEqual(classifyUserKind(steer, BETWEEN_STEP_CUSTOM_TYPE), "check_job");
});

test("steered into a running turn, it changes nothing about that turn, whatever kind it is", () => {
	const steer = formatBetweenStepMessage({ codename: "Wary Wolf", checkJobs: [job(JOB_A)], notices: [notice(NEEDS, "needs_person")], roomAttached: true, inRunningTurn: true });
	const starts: Array<[UserKind, string, string | undefined]> = [
		["remote", "[DevSpec remote — message from Ali Price] Ship the export button", undefined],
		["local", "Ship the export button", undefined],
		["automation", "[DevSpec remote — automation run to Wary Wolf]\nDevSpec automation run r1 (Deploy recovery) is ready.", undefined],
		["check_job", formatCheckJobsMessage([job(JOB_B)], "Wary Wolf"), undefined],
		["interaction", "[DevSpec directed-question workflow continuation] answered", undefined],
		["harness", "[bg completed] Isolated lint (abc123)", undefined],
		["harness", "notice text", "devspec-system-notice-v1"],
	];
	for (const [kind, text, customType] of starts) {
		const tracker = new TurnTracker();
		tracker.userMessage(text, { customType });
		assert.equal(tracker.userKind, kind);
		tracker.assistantFinal("Working on it.", false);
		const before = { ...tracker };
		tracker.userMessage(steer, { customType: BETWEEN_STEP_CUSTOM_TYPE });
		assert.deepEqual({ ...tracker }, before, `${kind}: kind, text, first-answer state, mirror and last answer are untouched`);
	}
	// Even a segment that has no input yet is not given one by it.
	const fresh = new TurnTracker();
	fresh.userMessage(steer, { customType: BETWEEN_STEP_CUSTOM_TYPE });
	assert.equal(fresh.userKind, null);
	assert.equal(fresh.userText, "");
	assert.equal(fresh.awaitingFirstAnswer, false);
	// The person's next real message still starts their turn as before.
	fresh.userMessage("Ship the export button");
	assert.equal(fresh.userKind, "local");
	assert.equal(fresh.shouldMirrorPrompt, true);
});
