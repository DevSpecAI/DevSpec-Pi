/**
 * Between-step delivery, wired (DevSpec item da5cfae5). The REAL delivery code
 * and the REAL turn_end, message_start and agent_settled hooks from
 * devspec-remote.ts run here against a stand-in Pi whose steering queue behaves
 * as Pi's does: a steer is shown to the agent only at a step boundary, and a
 * stopped run drops what is still queued.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { DeliveryQueue, StaleDeliveryError, nextDeliveryRetryDelayMs } from "../extensions/core/delivery-queue.ts";
import { revalidateAutomationRunRetry } from "../extensions/core/automation-run-retry.ts";
import { capturePumpAuthority, isPumpAuthorityCurrent } from "../extensions/core/bond-recovery.ts";
import { unwrapMcpResult } from "../extensions/core/result.ts";
import {
	CHECK_JOB_CONTRACT_URI,
	dispatchId,
	formatAutomationRunMessage,
	formatCheckJobsMessage,
	isAutomationRunEnvelope,
	isCheckJobEnvelope,
	isDispatchEnvelope,
	servedCheckJobHelpers,
	shouldDeliverQueuedCheckJob,
} from "../extensions/core/dispatch.ts";
import {
	BETWEEN_STEP_CUSTOM_TYPE,
	BetweenStepLedger,
	betweenStepDeliveryId,
	deliverIdleCheckJobs,
	formatBetweenStepMessage,
} from "../extensions/core/between-step.ts";
import { noticeIdsFromDelivery, type NoticeReplyCapture } from "../extensions/core/notice-reply.ts";
import type { SystemNoticeV1 } from "../extensions/core/remote-payload.ts";
import {
	SYSTEM_NOTICE_CUSTOM_TYPE,
	acceptSystemNotices,
	bindSystemNoticeState,
	commitSystemNoticeDelivery,
	queuedSystemNotices,
	remoteRunActivityPolicy,
	resetSystemNoticeStateForTests,
} from "../extensions/core/system-notice.ts";
import { noticeNeedsPerson } from "../extensions/core/run-voice.ts";
import { extractText } from "../extensions/core/trail.ts";
import { CHECK_JOB_PREFIX, classifyUserKind, isBetweenStepDelivery, TurnTracker } from "../extensions/core/turn-lifecycle.ts";
import { UsageRefusalReport } from "../extensions/core/usage-refusal.ts";
import { PendingWorkSubjects, isNonCommandWorkSubject, workSubjectForAutomationRun, workSubjectForCheckJobs } from "../extensions/core/work-subject.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
function slice(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
	return source.slice(from, to);
}
const delivery = slice("function automationRecord(", "/**\n * Revive a recoverably-ended server bond in place");
const turnEndHook = slice('\tpi.on("turn_end"', "\t// Leftover bg receipts arrive");
const messageStartHook = slice('\tpi.on("message_start"', '\tpi.on("message_update"');
const settledHook = slice('\tpi.on("agent_settled"', "\t// ---- Turn lifecycle events");
const steerBinding = slice("\tpi_steerBetweenSteps = (message, details) => {", "\tpi_compact = ");

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const JOB_A = "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11";
const JOB_B = "4f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e22";
const JOB_C = "5f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e33";
const NEEDS = "17171717-1717-4171-8171-171717171717";
const RECORD = "18181818-1818-4181-8181-181818181818";
const job = (id: string, title = "Ship the export button") => ({
	id, kind: "check_job", check_job_id: id, check_kind: "conflict_decisions",
	record: { type: "task", id: "9b2d6c1e-1111-4222-8333-444455556666", title },
	entries: 3, yours: true, offered_at: "2026-11-04T02:00:00.000Z", delivery_connection_id: CONNECTION,
});
const notice = (notice_id: string, audience: "needs_person" | "for_the_record"): SystemNoticeV1 => ({
	version: 1, kind: "server_notice", notice_id, topic: "coherence_finding", notice_type: "coherence_finding",
	summary: "A finding", prompt: "Handle the finding.", records: [], allowed_outcomes: ["resolved"], allowed_tools: ["update_task"], audience,
} as unknown as SystemNoticeV1);
const inbox = (id: string, dispatches: unknown[]) => ({ content: [{ type: "text", text: JSON.stringify({ connection_id: CONNECTION, dispatches, count: dispatches.length, dispatch_id: id, identity_complete: true }) }] });

interface Steer { customType: string; content: string; details: Record<string, unknown> }
type Hook = (event: any, ctx: any) => Promise<unknown> | unknown;

afterEach(() => resetSystemNoticeStateForTests());

/**
 * A bonded Pi with the real delivery code. `runActive` and `idle` are the test's
 * to move, as Pi's own run lifecycle moves them. Pi's steering queue is modelled
 * faithfully: `nextStep()` is the loop reading it after turn_end and emitting the
 * steered message's message_start; `stopRun()` is the person stopping the run.
 */
function rig(options: { sessionId?: string | null; settled?: string[]; turn?: Record<string, unknown> | null; helpers?: string | Error } = {}) {
	const hooks: Record<string, Hook> = {};
	const wakes: Array<{ message: string; mode: string }> = [];
	const steers: Steer[] = [];
	const steeringQueue: Steer[] = [];
	const toasts: string[] = [];
	const lookups: string[] = [];
	const calls: string[] = [];
	const resourceReads: string[] = [];
	const replyTool: boolean[] = [];
	const settled = new Set(options.settled ?? []);
	const state = { runActive: false, idle: true, pending: false };
	const key = bindSystemNoticeState({ piSessionId: "pi-session", connectionId: CONNECTION, pumpGeneration: 1 });
	const active: Record<string, any> = {
		generation: 1, stop: false, busy: false, workSubject: null, workSubjectNeedsClear: false, systemNoticeKey: key,
		bond: { connectionId: CONNECTION, codename: "Wary Wolf", sessionId: options.sessionId === undefined ? "room" : options.sessionId, connectionCapability: "cap" },
		runtimeOccupancy: { isBusy: () => state.runActive, capture: () => null, finish: () => true },
		idleBoundaryWake: { consumeAtIdle: () => false },
		automationQueue: new DeliveryQueue(),
		betweenStep: new BetweenStepLedger(),
		automationRetryAttempts: new Map<string, number>(),
		automationRetryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
	};
	const never = (name: string) => () => { throw new Error(`${name} must not run for a between-step delivery`); };
	const sandbox: Record<string, any> = {
		setTimeout, clearTimeout, Date, Math, Promise, Set, Map, Error, Boolean, String, JSON,
		StaleDeliveryError, nextDeliveryRetryDelayMs, revalidateAutomationRunRetry, capturePumpAuthority, isPumpAuthorityCurrent,
		unwrapMcpResult, isAutomationRunEnvelope, isCheckJobEnvelope, isDispatchEnvelope, dispatchId,
		formatAutomationRunMessage, formatCheckJobsMessage, shouldDeliverQueuedCheckJob, servedCheckJobHelpers, CHECK_JOB_CONTRACT_URI,
		readDevspecResource: async (_token: string, uri: string) => {
			resourceReads.push(uri);
			if (options.helpers instanceof Error) throw options.helpers;
			return { contents: [{ uri, text: JSON.stringify({ kind: "devspec.product.remote_ingress_contract", semantics: { check_job: options.helpers ? { helpers: options.helpers } : {} } }) }] };
		},
		BetweenStepLedger, betweenStepDeliveryId, deliverIdleCheckJobs, formatBetweenStepMessage, BETWEEN_STEP_CUSTOM_TYPE,
		queuedSystemNotices, commitSystemNoticeDelivery, noticeIdsFromDelivery, remoteRunActivityPolicy, noticeNeedsPerson,
		pi_setNoticeReplyToolActive: (enabled: boolean) => { replyTool.push(enabled); },
		reportUnansweredSteeredNotices: async (t: Record<string, unknown>) => { calls.push(`reportUnansweredSteeredNotices:${[...((t.steeredNotices as NoticeReplyCapture | undefined)?.noticeIds ?? [])].join(",")}`); },
		SYSTEM_NOTICE_CUSTOM_TYPE, isBetweenStepDelivery, extractText,
		MODEL_TIMEOUT_MS: 5_000,
		pump: active,
		turn: options.turn ?? null,
		lastCtx: null,
		systemNoticeTurnPending: false,
		systemNoticeRunActive: false,
		pendingSystemNoticeWorkSubject: null,
		nextRunWorkSubject: null,
		parkedWorkSubject: null,
		pendingWorkSubjects: new PendingWorkSubjects(),
		workSubjectForAutomationRun,
		workSubjectForCheckJobs,
		isNonCommandWorkSubject,
		setPumpWorkSubject(p: Record<string, unknown>, s: unknown) { p.workSubject = s; p.workSubjectNeedsClear = s === null; },
		segmentIsQuiet: () => false,
		segmentInputKind: "command",
		leafWake: null,
		settledInteractionForOffer: null,
		parkedBackground: null,
		pendingOffer: null,
		observationScope: null,
		foregroundEpoch: 0,
		pendingInteractionConfirmations: new Set(),
		pendingBackgroundTaskIds: new Set(),
		get runActive() { return state.runActive; },
		set runActive(value: boolean) { state.runActive = value; },
		getBond: () => active.bond,
		noteAutomation() {}, paintStatus() {}, noteProgressEvent() {}, debug() {},
		usageRefusal: new UsageRefusalReport(),
		notify: (_ctx: unknown, message: string) => toasts.push(message),
		signalWake: () => calls.push("signalWake"),
		currentPumpToken: async (_active: unknown, held: string) => held,
		pi_send: (message: string, mode: string) => {
			wakes.push({ message, mode });
			// Pi starts the run this message asked for.
			state.idle = false;
			state.runActive = true;
		},
		pi_steerBetweenSteps: (content: string, details: Record<string, unknown>) => {
			assert.equal(state.runActive, true, "a steer is only ever handed to a running Pi");
			const steer = { customType: BETWEEN_STEP_CUSTOM_TYPE, content, details };
			steers.push(steer);
			steeringQueue.push(steer);
		},
		callDevspec: async (_token: string, name: string, args: Record<string, unknown>) => {
			assert.equal(name, "get_connection_dispatch");
			const id = String(args.dispatch_id);
			lookups.push(id);
			return inbox(id, settled.has(id) ? [] : [job(id)]);
		},
		// The notice idle path, as deliverQueuedSystemNotices leaves the store.
		deliverQueuedSystemNotices: (pumpState: typeof active) => {
			const queued = queuedSystemNotices(pumpState.systemNoticeKey);
			if (queued.length === 0) return false;
			calls.push(`noticeRun:${queued.map((entry) => entry.notice_id).join(",")}`);
			commitSystemNoticeDelivery(pumpState.systemNoticeKey, queued.map((entry) => entry.notice_id));
			sandbox.systemNoticeTurnPending = true;
			return true;
		},
		// Everything a between-step delivery must leave alone.
		bindSegmentForMessage: never("request binding"),
		commandTurnBindings: { take: never("command binding") },
		splitTurnAtBoundary: never("a segment boundary"),
		transitionToRealUserActivity: never("a real-user transition"),
		completeTurnActivity: async (_t: unknown, why: string) => { calls.push(`completeTurnActivity:${why}`); },
		reportTerminalError: never("a terminal error post"),
		beatBusy: async (busy: boolean) => { calls.push(`beatBusy:${busy}`); },
		ensureTurn: never("turn creation"),
		isHarnessOrigin: never("harness classification"),
		// agent_settled's other collaborators, inert.
		typedInputLedger: () => ({ expire() {} }),
		requestChain: () => null,
		scanAppendedNotices() {},
		pi_setServeToolActive() {},
		pi_refreshBackgroundWork: async () => {},
		attemptInteractionPersistenceConfirmation: async () => {},
		reconcileSubagentFleetOwnership: async () => "current",
		retireInteractionForeground() {},
		settleTelemetry: () => null,
		untitledAttached: () => false,
		scheduleTitleRefresh() {},
		backgroundScopeKey: () => "",
		settleTurn: async () => { calls.push("settleTurn"); sandbox.turn = null; return false; },
		trackTerminalPost() {},
		completeObservedIdle: async () => {},
		foregroundIdleForOffer: () => false,
		pi_roomReaderAvailable: () => false,
		roomUnreadBoundary: never("the room boundary without a reader"),
		roomUnreadForContext: never("the room read without a reader"),
		noteInjectedContext() {},
		pi: { on: (name: string, fn: Hook) => { hooks[name] = fn; } },
	};
	const api = runInNewContext(stripTypeScriptTypes(
		`${delivery}\n${turnEndHook}\n${messageStartHook}\n${settledHook}\n({ enqueueDispatch, pumpWaitingCheckJobs, steerWaitingBetweenSteps, noteBetweenStepDelivered, dropWaitingCheckJobs })`,
	), sandbox) as {
		enqueueDispatch: (a: unknown, token: string, value: unknown, ctx: unknown) => void;
		pumpWaitingCheckJobs: (a: unknown, ctx: unknown) => void;
		dropWaitingCheckJobs: (a: unknown) => void;
	};
	const ctx = { cwd: "/tmp", isIdle: () => state.idle, hasPendingMessages: () => state.pending };
	const settle = async () => {
		await active.automationQueue.idle();
		for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
	};
	return {
		active, sandbox, state, hooks, wakes, steers, toasts, lookups, calls, resourceReads, replyTool, ctx, api, settle,
		ledger: () => active.betweenStep as BetweenStepLedger,
		arrive: async (...values: unknown[]) => { for (const value of values) api.enqueueDispatch(active, "tok-1", value, ctx); await settle(); },
		notices: (...values: SystemNoticeV1[]) => assert.equal(acceptSystemNotices(key, values), true),
		queuedNotices: () => queuedSystemNotices(key).map((entry) => entry.notice_id),
		startRun: () => { state.runActive = true; state.idle = false; },
		/** A step ends: Pi runs turn_end, then reads its steering queue and shows the agent what it holds. */
		endStep: async (outcome = "completed") => {
			const boundary = await hooks.turn_end!({ outcome, toolResults: [] }, ctx);
			const shown = steeringQueue.splice(0);
			for (const steer of shown) {
				await hooks.message_start!({ message: { role: "custom", customType: steer.customType, content: steer.content, details: steer.details } }, ctx);
			}
			return { boundary, shown };
		},
		/** The person stops the run: Pi drops its queue, and the run settles. */
		stopRun: async () => { steeringQueue.splice(0); await hooks.agent_settled!({ aborted: true }, ctx); await settle(); },
		/** The run ends by itself. */
		endRun: async () => {
			assert.deepEqual(steeringQueue, [], "Pi never ends a run with a steer still queued");
			state.idle = true;
			await hooks.agent_settled!({ aborted: false }, ctx);
			await settle();
		},
	};
}

/** A turn's state as the extension tracks it for a room. */
function trackedTurn(wake: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const tracker = new TurnTracker();
	tracker.userMessage(wake);
	return { revision: 7, tracker, completionNeutral: false, commandTurnId: "turn-1", commandMessageId: "message-1", requestKind: "command", canPost: () => true, ...extra };
}
const snapshot = (t: Record<string, unknown>) => JSON.stringify({ ...t, tracker: { ...(t.tracker as object) } });

// ---- Criteria 1 and 2: mid-turn, at the next step, all together -------------------

test("check jobs sent while Pi works a turn reach the agent at its next step, together, in one steer", async () => {
	const r = rig();
	r.startRun();
	await r.arrive(job(JOB_A), job(JOB_B, "Rename the plan"), job(JOB_C, "Fold the duplicate"));
	assert.deepEqual(r.wakes, [], "nothing is queued behind the turn as a follow-up or sent as a new run");
	assert.deepEqual(r.steers, [], "and nothing is delivered inside the step");
	assert.deepEqual(r.lookups, [], "no call to DevSpec is made from inside Pi's loop");
	const { shown } = await r.endStep();
	assert.equal(shown.length, 1, "one steer for everything waiting when the step ended");
	assert.deepEqual(shown[0]!.details.check_job_ids, [JOB_A, JOB_B, JOB_C]);
	assert.equal(shown[0]!.customType, BETWEEN_STEP_CUSTOM_TYPE);
	for (const id of [JOB_A, JOB_B, JOB_C]) assert.ok(shown[0]!.content.includes(`"check_job_id": "${id}"`));
	assert.deepEqual(r.toasts, ["DevSpec remote: 3 check jobs delivered."]);
	assert.equal(r.ledger().hasWaitingCheckJobs(), false);
});

test("a steered check job is not delivered again at the next step or when the turn ends", async () => {
	const r = rig();
	r.startRun();
	await r.arrive(job(JOB_A));
	await r.endStep();
	assert.equal((await r.endStep()).shown.length, 0, "the following step has nothing to steer");
	await r.endRun();
	assert.equal(r.steers.length, 1);
	assert.deepEqual(r.wakes, [], "the end of the turn starts no check-job run for it");
	// The wake channel lists the open set again on every poll: still once.
	await r.arrive(job(JOB_A));
	assert.deepEqual(r.wakes, []);
	assert.equal(r.steers.length, 1);
});

test("a check job that arrives after the turn's last step is delivered as soon as the turn ends", async () => {
	const r = rig();
	r.startRun();
	await r.endStep();
	await r.arrive(job(JOB_A));
	assert.deepEqual(r.steers, []);
	await r.endRun();
	assert.equal(r.wakes.length, 1);
	assert.equal(r.wakes[0]!.mode, "now");
	assert.equal(classifyUserKind(r.wakes[0]!.message), "check_job");
	assert.ok(r.wakes[0]!.message.includes(JOB_A));
	assert.deepEqual(r.lookups, [JOB_A], "a job that waited is rechecked before it wakes an idle Pi");
});

test("a steer the person's stop made Pi drop is delivered once the run has settled, and only once", async () => {
	const r = rig();
	r.startRun();
	r.notices(notice(NEEDS, "needs_person"));
	await r.arrive(job(JOB_A));
	// The step ends and the steer is queued, but the run is stopped before Pi shows it.
	await r.hooks.turn_end!({ outcome: "completed", toolResults: [] }, r.ctx);
	assert.equal(r.steers.length, 1);
	assert.deepEqual(r.queuedNotices(), [NEEDS], "handed to Pi is not delivered: the notice is still held");
	r.state.idle = true;
	await r.stopRun();
	assert.deepEqual(r.calls.filter((call) => call.startsWith("noticeRun")), [`noticeRun:${NEEDS}`], "the notice goes out idle, as before");
	// The notice run that starts takes the check job at its first step boundary.
	assert.deepEqual(r.wakes, [], "no second run is started beside the notice run");
	r.sandbox.systemNoticeTurnPending = false;
	r.startRun();
	const { shown } = await r.endStep();
	assert.deepEqual(shown.map((steer) => steer.details.check_job_ids), [[JOB_A]]);
	assert.deepEqual(shown[0]!.details.notices, [], "the notice is not delivered a second time");
	await r.endRun();
	assert.deepEqual(r.wakes, []);
	assert.equal(r.steers.length, 2);
});

test("a step that was stopped or failed steers nothing; the next completed step does", async () => {
	const r = rig();
	r.startRun();
	await r.arrive(job(JOB_A));
	assert.equal((await r.endStep("aborted")).shown.length, 0);
	assert.equal((await r.endStep("error")).shown.length, 0);
	assert.equal(r.ledger().steerInFlight, false);
	assert.equal((await r.endStep("completed")).shown.length, 1);
});

test("a second step boundary before Pi shows the first steer adds no second steer; later arrivals join the next one", async () => {
	const r = rig();
	r.startRun();
	await r.arrive(job(JOB_A));
	await r.hooks.turn_end!({ outcome: "completed", toolResults: [] }, r.ctx);
	await r.arrive(job(JOB_B));
	// Pi showed the person's own steer first: ours is still queued at this boundary.
	await r.hooks.turn_end!({ outcome: "completed", toolResults: [] }, r.ctx);
	assert.equal(r.steers.length, 1);
	const first = await r.endStep();
	assert.deepEqual(first.shown.map((steer) => steer.details.check_job_ids), [[JOB_A]]);
	const second = await r.endStep();
	assert.deepEqual(second.shown.map((steer) => steer.details.check_job_ids), [[JOB_B]]);
});

// ---- Criterion 3: notices -----------------------------------------------------------

test("a notice about the agent's own work reaches it at its next step, with the check jobs, and is committed once", async () => {
	const r = rig();
	r.startRun();
	r.notices(notice(NEEDS, "needs_person"), notice(RECORD, "for_the_record"));
	await r.arrive(job(JOB_A));
	const { shown } = await r.endStep();
	assert.equal(shown.length, 1, "check jobs and notices in the same pause");
	assert.deepEqual((shown[0]!.details.notices as SystemNoticeV1[]).map((entry) => entry.notice_id), [NEEDS, RECORD]);
	assert.ok(shown[0]!.content.includes(`notice_id=${JSON.stringify(NEEDS)}`) && shown[0]!.content.includes(`notice_id=${JSON.stringify(RECORD)}`));
	assert.deepEqual(r.queuedNotices(), [], "shown to the agent, so no longer held");
	assert.ok(r.calls.includes("signalWake"), "and the notice channel is free to send more");
	await r.endRun();
	assert.deepEqual(r.calls.filter((call) => call.startsWith("noticeRun")), [], "the end of the turn starts no notice run for them");
});

test("a notice that arrives after the steer was queued waits for the next step, never lost and never doubled", async () => {
	const r = rig();
	r.startRun();
	r.notices(notice(NEEDS, "needs_person"));
	await r.hooks.turn_end!({ outcome: "completed", toolResults: [] }, r.ctx);
	r.notices(notice(RECORD, "for_the_record"));
	const first = await r.endStep();
	assert.deepEqual(first.shown.map((steer) => (steer.details.notices as SystemNoticeV1[]).map((entry) => entry.notice_id)), [[NEEDS]]);
	assert.deepEqual(r.queuedNotices(), [RECORD]);
	const second = await r.endStep();
	assert.deepEqual(second.shown.map((steer) => (steer.details.notices as SystemNoticeV1[]).map((entry) => entry.notice_id)), [[RECORD]]);
	assert.deepEqual(r.queuedNotices(), []);
});

// ---- Criterion 4: the running command is untouched -----------------------------------

test("a steer into a person's command leaves the turn, its request and its Working state exactly as they were", async () => {
	const turn = trackedTurn("[DevSpec remote — message from Ali Price] Ship the export button");
	const r = rig({ turn });
	r.startRun();
	r.active.busy = true;
	r.notices(notice(NEEDS, "needs_person"), notice(RECORD, "for_the_record"));
	await r.arrive(job(JOB_A));
	const before = snapshot(turn);
	// The never() collaborators throw if the delivery binds a request, takes a command
	// binding, splits the segment, changes presence or completes the turn.
	await r.hooks.turn_end!({ outcome: "completed", toolResults: [] }, r.ctx);
	assert.deepEqual(r.replyTool, [true], "the reply tool is shown before Pi prepares the step that reads the steer");
	const { shown } = await r.endStep();
	assert.equal(shown.length, 1);
	const { steeredNotices, ...rest } = turn;
	assert.equal(snapshot(rest), before, "kind, command turn, request kind and revision are untouched");
	assert.equal((turn.tracker as TurnTracker).userKind, "remote");
	assert.equal(turn.noticeReply, undefined, "the command's final message is not turned into a notice reply");
	// The notices wait for a reply handed over apart from the command's messages.
	assert.deepEqual([...(steeredNotices as NoticeReplyCapture).noticeIds], [NEEDS]);
	assert.deepEqual([...(steeredNotices as NoticeReplyCapture).forTheRecordIds], [RECORD]);
	assert.equal(r.sandbox.turn, turn, "the same segment goes on");
	assert.equal(r.sandbox.segmentInputKind, "command", "writes are still recorded for the command's request");
	assert.equal(r.active.busy, true, "Working is as the room saw it");
	assert.deepEqual(r.calls, ["signalWake"], "no presence beat, no completion and no post of any kind");
	assert.match(shown[0]!.content, /What you want your person to hear about a notice goes through the reply_to_devspec_notice tool/);
	assert.doesNotMatch(shown[0]!.content, /nothing is posted separately as a reply/);
});

test("when the person's turn ends, its own answer and completion come first, then whatever notice is unanswered is reported, and the reply tool goes away", async () => {
	const turn = trackedTurn("[DevSpec remote — message from Ali Price] Ship the export button");
	const r = rig({ turn });
	r.startRun();
	r.notices(notice(NEEDS, "needs_person"));
	await r.endStep();
	r.calls.length = 0;
	await r.endRun();
	assert.deepEqual(r.calls.filter((call) => !call.startsWith("beatBusy")), ["settleTurn", "completeTurnActivity:turn_end", `reportUnansweredSteeredNotices:${NEEDS}`]);
	assert.deepEqual(r.replyTool, [true, false]);
	assert.deepEqual(r.calls.filter((call) => call.startsWith("noticeRun")), [], "and no notice run is started for it");
});

test("the reply tool is shown only where a reply can be handed over: a person's turn, in a room, with a notice that needs a person", async () => {
	const command = "[DevSpec remote — message from Ali Price] Ship the export button";
	const forTheRecord = rig({ turn: trackedTurn(command) });
	forTheRecord.startRun();
	forTheRecord.notices(notice(RECORD, "for_the_record"));
	await forTheRecord.endStep();
	assert.deepEqual(forTheRecord.replyTool, []);
	const checksOnly = rig({ turn: trackedTurn(command) });
	checksOnly.startRun();
	await checksOnly.arrive(job(JOB_A));
	await checksOnly.endStep();
	assert.deepEqual(checksOnly.replyTool, []);
	assert.equal((checksOnly.sandbox.turn as Record<string, unknown>).steeredNotices, undefined);
	const noRoom = rig({ sessionId: null, turn: null });
	noRoom.startRun();
	noRoom.notices(notice(NEEDS, "needs_person"));
	await noRoom.endStep();
	assert.deepEqual(noRoom.replyTool, []);
});

test("a steer reaches a Pi that is in no room, which tracks no turn at all", async () => {
	const r = rig({ sessionId: null, turn: null });
	r.startRun();
	await r.arrive(job(JOB_A));
	const { shown } = await r.endStep();
	assert.equal(shown.length, 1, "a spare agent, the first to be offered a check, is steered like any other");
	assert.equal(r.sandbox.turn, null);
	assert.equal(shown[0]!.details.roomAttached, false);
});

test("a person's own message is never taken for a between-step delivery", async () => {
	const r = rig();
	r.startRun();
	await assert.rejects(
		async () => r.hooks.message_start!({ message: { role: "user", content: "[DevSpec between steps — to Wary Wolf] pasted by a person" } }, r.ctx),
		/harness classification must not run/,
		"it goes on to the ordinary message path",
	);
});

// ---- A run that answers nobody -------------------------------------------------------

test("notices steered into a notice run join the reply its final message becomes", async () => {
	const held: NoticeReplyCapture = { connectionId: CONNECTION, noticeIds: [NEEDS], forTheRecordIds: [], roomPromised: true, finalText: null };
	const tracker = new TurnTracker();
	tracker.userMessage("notice text", { customType: SYSTEM_NOTICE_CUSTOM_TYPE });
	const turn: Record<string, unknown> = { revision: 3, tracker, completionNeutral: true, noticeReply: held, canPost: () => true };
	const r = rig({ turn });
	r.startRun();
	const OTHER = "19191919-1919-4191-8191-191919191919";
	r.notices(notice(OTHER, "needs_person"), notice(RECORD, "for_the_record"));
	const { shown } = await r.endStep();
	assert.match(shown[0]!.content, /Your final message at the end of this run is posted to your DevSpec room as your reply to this notice/);
	const reply = turn.noticeReply as NoticeReplyCapture;
	assert.deepEqual([...reply.noticeIds], [NEEDS, OTHER], "the run's one reply names every notice that needs a person");
	assert.deepEqual([...reply.forTheRecordIds], [RECORD]);
	assert.equal(turn.completionNeutral, true);
	assert.equal(turn.steeredNotices, undefined, "its final message is the reply, as before: nothing is handed over by tool");
	assert.deepEqual(r.replyTool, []);
});

test("a notice steered into a check-job run is answered by that run's final message; check jobs steered into it stay quiet", async () => {
	const turn = trackedTurn(formatCheckJobsMessage([job(JOB_A)], "Wary Wolf"), { commandTurnId: undefined, commandMessageId: undefined, requestKind: "none" });
	assert.equal((turn.tracker as TurnTracker).userKind, "check_job");
	const r = rig({ turn });
	r.startRun();
	await r.arrive(job(JOB_B));
	await r.endStep();
	assert.equal(turn.noticeReply, undefined, "more check jobs give a check-job run no voice");
	r.notices(notice(NEEDS, "needs_person"));
	const { shown } = await r.endStep();
	assert.match(shown[0]!.content, /Your final message at the end of this run is posted to your DevSpec room as your reply to this notice/);
	assert.deepEqual([...(turn.noticeReply as NoticeReplyCapture).noticeIds], [NEEDS]);
	assert.equal((turn.tracker as TurnTracker).userKind, "check_job", "it is still a check-job run");
	assert.equal(turn.steeredNotices, undefined);
	assert.deepEqual(r.replyTool, []);
});

// ---- Criterion 5: idle is unchanged, and so is everything a person sends ---------------

test("an idle Pi takes a check job straight away, as a check-job wake", async () => {
	const r = rig();
	await r.arrive(job(JOB_A));
	assert.equal(r.wakes.length, 1);
	assert.equal(r.wakes[0]!.mode, "now");
	assert.ok(r.wakes[0]!.message.startsWith(`${CHECK_JOB_PREFIX} to Wary Wolf]`));
	assert.deepEqual(r.steers, [], "an idle Pi is never steered");
	assert.deepEqual(r.toasts, ["DevSpec remote: check job delivered."]);
});

test("an idle Pi takes every check job the wake channel lists in one wake: no job waits a turn for the one before it", async () => {
	const r = rig();
	await r.arrive(job(JOB_A), job(JOB_B, "Rename the plan"), job(JOB_C, "Fold the duplicate"));
	assert.equal(r.wakes.length, 1);
	for (const id of [JOB_A, JOB_B, JOB_C]) assert.ok(r.wakes[0]!.message.includes(`"check_job_id": "${id}"`));
	assert.deepEqual(r.toasts, ["DevSpec remote: 3 check jobs delivered."]);
});

test("an idle Pi is not woken for a check job DevSpec no longer lists, and still wakes for the rest", async () => {
	const r = rig({ settled: [JOB_A] });
	await r.arrive(job(JOB_A), job(JOB_B));
	assert.ok(r.lookups.includes(JOB_A), "a waiting job is rechecked with DevSpec before it wakes an idle Pi");
	assert.equal(r.wakes.length, 1);
	assert.ok(!r.wakes[0]!.message.includes(JOB_A));
	assert.ok(r.wakes[0]!.message.includes(JOB_B));
	const none = rig({ settled: [JOB_A] });
	await none.arrive(job(JOB_A));
	assert.deepEqual(none.wakes, [], "no run and no toast for a job already ruled or handed on");
	assert.deepEqual(none.toasts, []);
});

test("a check job that arrives while its predecessor's run is starting is steered into that run, never started beside it", async () => {
	const r = rig();
	await r.arrive(job(JOB_A));
	assert.equal(r.wakes.length, 1);
	await r.arrive(job(JOB_B));
	assert.equal(r.wakes.length, 1, "the run the first wake started is taking it");
	const { shown } = await r.endStep();
	assert.deepEqual(shown.map((steer) => steer.details.check_job_ids), [[JOB_B]]);
});

test("an idle Pi with a message already queued is asked again shortly, and takes the job once it can", async () => {
	const r = rig();
	r.state.pending = true;
	await r.arrive(job(JOB_A));
	assert.deepEqual(r.wakes, []);
	assert.ok(r.active.checkJobIdleTimer, "an idle Pi that cannot take it yet is rechecked");
	r.state.pending = false;
	await new Promise((resolve) => setTimeout(resolve, 260));
	await r.settle();
	assert.equal(r.wakes.length, 1);
	assert.equal(r.active.checkJobIdleTimer, undefined);
});

test("an automation run is still delivered exactly as before, behind a waiting check job or not", async () => {
	const automation = {
		id: "run-1", kind: "automation_run", run_id: "run-1", automation_id: "automation-1", automation_name: "Deploy recovery",
		trigger_kind: "scheduled", owner: { user_id: "owner-1", display_name: "Ali Price" }, permission: "can_commit",
		queued_at: "2026-08-20T12:00:00.000Z", delivery_connection_id: CONNECTION, requester: null,
	};
	const r = rig();
	r.startRun();
	await r.arrive(job(JOB_A), automation);
	assert.equal(r.wakes.length, 1);
	assert.equal(r.wakes[0]!.mode, "followUp", "a busy Pi queues an automation run as a follow-up, as before");
	assert.equal(classifyUserKind(r.wakes[0]!.message), "automation");
	assert.deepEqual(r.toasts, ["DevSpec remote: automation run delivered."]);
	assert.deepEqual(r.steers, [], "and it is never put in a steer");
	const idleRig = rig();
	await idleRig.arrive(automation);
	assert.equal(idleRig.wakes[0]!.mode, "now");
});

test("a connection that ends or is replaced takes its waiting check jobs with it", async () => {
	const r = rig();
	r.startRun();
	await r.arrive(job(JOB_A));
	r.api.dropWaitingCheckJobs(r.active);
	assert.equal(r.ledger().hasWaitingCheckJobs(), false);
	assert.equal((await r.endStep()).shown.length, 0);
	// A stopped pump steers and wakes nothing.
	const stopped = rig();
	stopped.startRun();
	await stopped.arrive(job(JOB_A));
	stopped.active.stop = true;
	assert.equal((await stopped.endStep()).shown.length, 0);
	stopped.state.runActive = false;
	stopped.state.idle = true;
	stopped.api.pumpWaitingCheckJobs(stopped.active, stopped.ctx);
	await stopped.settle();
	assert.deepEqual(stopped.wakes, []);
});

test("the room's unread notice still rides the same step boundary, before the steer", async () => {
	const r = rig();
	const order: string[] = [];
	r.sandbox.pi_roomReaderAvailable = () => true;
	r.sandbox.roomUnreadBoundary = async () => { order.push("room boundary"); return { entries: [{ type: "custom_message", customType: "devspec-room-unread", content: "2 unread", display: false }] }; };
	const steer = r.sandbox.pi_steerBetweenSteps;
	r.sandbox.pi_steerBetweenSteps = (content: string, details: Record<string, unknown>) => { order.push("steer"); steer(content, details); };
	r.startRun();
	await r.arrive(job(JOB_A));
	const { boundary, shown } = await r.endStep();
	assert.deepEqual(order, ["room boundary", "steer"], "the steer is the handler's last act, after every await");
	assert.deepEqual((boundary as { entries: unknown[] }).entries.length, 1, "the boundary Pi is handed back is unchanged");
	assert.equal(shown.length, 1);
});

// ---- Helpers: the served words, heard before a job is taken ----------------------------

const SERVED = "Rule a check job in a helper agent wherever you can start one. Give the helper only the check_job_id and your connection id.";

test("a wake and a steer quote what DevSpec serves on helper agents, beside the pointer, before the tools and the ids", async () => {
	const idleRig = rig({ helpers: SERVED });
	await idleRig.arrive(job(JOB_A));
	assert.deepEqual(idleRig.resourceReads, [CHECK_JOB_CONTRACT_URI], "read mechanically: Pi's model cannot open a devspec:// resource");
	const wake = idleRig.wakes[0]!.message;
	assert.ok(wake.includes(`DevSpec's words, as served now: ${SERVED}`));
	assert.ok(wake.indexOf(SERVED) < wake.indexOf("claim_check_job and every entry ruled"));
	assert.ok(wake.indexOf(SERVED) < wake.indexOf("Check job envelope"));
	const busyRig = rig({ helpers: SERVED });
	busyRig.startRun();
	await busyRig.arrive(job(JOB_A));
	const { shown } = await busyRig.endStep();
	assert.ok(shown[0]!.content.includes(`DevSpec's words, as served now: ${SERVED}`));
});

test("when the served words cannot be read, the pointer stands by itself and nothing is held up", async () => {
	for (const helpers of [new Error("MCP HTTP 503: upstream unavailable"), undefined]) {
		const idleRig = rig({ helpers });
		await idleRig.arrive(job(JOB_A));
		assert.equal(idleRig.wakes.length, 1, "the check job is still delivered");
		assert.doesNotMatch(idleRig.wakes[0]!.message, /as served now/);
		assert.match(idleRig.wakes[0]!.message, /semantics\.check_job\.helpers in devspec:\/\/product\/remote-ingress-contract/);
		const busyRig = rig({ helpers });
		busyRig.startRun();
		await busyRig.arrive(job(JOB_A));
		const { shown } = await busyRig.endStep();
		assert.equal(shown.length, 1);
		assert.doesNotMatch(shown[0]!.content, /as served now/);
	}
});

// ---- Pi's own steer -------------------------------------------------------------------

test("the steer is Pi's own: a custom message on the running agent's steering queue, never a user message, a follow-up or a new run", async () => {
	// The real binding from the extension, calling Pi's real sendCustomMessage (what
	// ExtensionAPI.sendMessage runs) on a session that is mid-run.
	const steered: Array<Record<string, unknown>> = [];
	const other: string[] = [];
	const session = {
		isStreaming: true,
		agent: { steer: (message: Record<string, unknown>) => steered.push(message), followUp: () => other.push("followUp") },
		_pendingNextTurnMessages: { push: () => other.push("nextTurn") },
		_pendingCustomMessages: { push: () => other.push("appended after the turn") },
		_runAgentPrompt: async () => { other.push("new run"); },
		_appendCustomMessage: () => other.push("appended"),
	};
	const sent: Promise<void>[] = [];
	const sandbox: Record<string, any> = {
		BETWEEN_STEP_CUSTOM_TYPE,
		pi_steerBetweenSteps: null,
		pi: {
			sendMessage: (message: unknown, options: unknown) => { sent.push(AgentSession.prototype.sendCustomMessage.call(session as never, message as never, options as never)); },
			sendUserMessage: () => other.push("user message"),
		},
	};
	runInNewContext(stripTypeScriptTypes(steerBinding), sandbox);
	const details = { delivery_id: "steer-1", check_job_ids: [JOB_A], notices: [], roomAttached: true };
	sandbox.pi_steerBetweenSteps("[DevSpec between steps — to Wary Wolf]\n...", details);
	await Promise.all(sent);
	assert.deepEqual(other, [], "Pi was asked for nothing but a steer");
	assert.equal(steered.length, 1);
	const { timestamp: _timestamp, ...message } = steered[0]!;
	assert.deepEqual(message, { role: "custom", customType: BETWEEN_STEP_CUSTOM_TYPE, content: "[DevSpec between steps — to Wary Wolf]\n...", display: true, details });
	// What Pi will emit for it is what the extension counts as delivered, and leaves the turn alone for.
	assert.equal(isBetweenStepDelivery(extractText(steered[0]), String(steered[0]!.customType)), true);
});
