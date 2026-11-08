/**
 * What woke a run decides whether its text reaches the DevSpec room (DevSpec item
 * a868f41f, criterion f9caa4fa). The pure rule, the tell_person mark, and the REAL
 * segment writers from devspec-remote.ts (speech, trail tick, segment answer,
 * notice reply, terminal error) with the wire mocked.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, test } from "node:test";
import { AssistantSpeechSource, AssistantSpeechQueue, assistantSpeechWithinBudget } from "../extensions/core/assistant-speech.ts";
import { TurnTracker, shouldSplitSpeech, isClosedAnswer } from "../extensions/core/turn-lifecycle.ts";
import { extractAssistantParts, TrailBuilder } from "../extensions/core/trail.ts";
import { unwrapMcpResult } from "../extensions/core/result.ts";
import { parsePostSessionReceipt, TrailDeliveryState } from "../extensions/core/post-session-receipt.ts";
import { noticeReplyFinalText, noticeReplyTerminalMessage, postNoticeReply } from "../extensions/core/notice-reply.ts";
import { remoteRunActivityPolicy } from "../extensions/core/system-notice.ts";
import { formatCheckJobMessage } from "../extensions/core/dispatch.ts";
import { noticeBatchWake, noticeNeedsPerson, runSpeaks, wakeIsQuiet, type RunWake } from "../extensions/core/run-voice.ts";
import { carriesTellPerson, noteTellPerson, resetTellPersonForTests, takeTellPerson } from "../extensions/core/tell-person.ts";
import { systemNotice } from "./canonical-ingress-fixture.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const tools = readFileSync(new URL("../extensions/devspec-tools.ts", import.meta.url), "utf8");
const voice = source.slice(source.indexOf("function segmentWake("), source.indexOf("function isCommandTurnUnbound("));
const speech = source.slice(source.indexOf("const assistantSpeechQueue ="), source.indexOf("// Per-turn telemetry"));
const tick = source.slice(source.indexOf("function trailTick()"), source.indexOf("/**\n * Explicitly close this connection"));
const terminalError = source
	.slice(source.indexOf("const TERMINAL_ERROR_PROVIDER_CHARS"), source.indexOf("/** Start the exact event/claim-bound activity"))
	.replace("export function renderTerminalErrorPost", "function renderTerminalErrorPost");
const endHook = source.slice(source.indexOf('\tpi.on("message_end"'), source.indexOf('\tpi.on("tool_execution_start"'));
const segment = source.slice(source.indexOf("async function postSegmentAnswer("), source.indexOf("/**\n * Settle the run"));

const NEEDS = "17171717-1717-4171-8171-171717171717";
const RECORD = "18181818-1818-4181-8181-181818181818";
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const JOB = "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11";
const envelope = (details: unknown) => ({ content: [{ type: "text", text: JSON.stringify(details) }] });
const assistant = (text: string, stopReason: string, tools = false) => ({ role: "assistant", stopReason, content: [{ type: "text", text }, ...(tools ? [{ type: "toolCall", name: "record_check_rulings" }] : [])] });
const checkJobWake = formatCheckJobMessage({
	id: JOB, kind: "check_job", check_job_id: JOB, check_kind: "staleness",
	record: { type: "goal", id: "5c1d2e3f-1111-4222-8333-444455556666", title: "Launch to customers" },
	entries: 4, yours: false, offered_at: "2026-11-07T20:00:00.000Z", delivery_connection_id: CONNECTION,
}, "Amber Hawk");

afterEach(() => resetTellPersonForTests());

// ---- The rule -------------------------------------------------------------

test("the rule: a person or a notice that needs one speaks; a check job or for-the-record notices go quiet unless tell_person", () => {
	const table: Array<[RunWake, boolean, boolean]> = [
		["person", false, true],
		["person", true, true],
		["notice_needs_person", false, true],
		["notice_needs_person", true, true],
		["notice_for_the_record", false, false],
		["notice_for_the_record", true, true],
		["check_job", false, false],
		["check_job", true, true],
	];
	for (const [wake, tellPerson, speaks] of table) assert.equal(runSpeaks(wake, tellPerson), speaks, `${wake} tell_person=${tellPerson}`);
	assert.deepEqual((["person", "notice_needs_person", "notice_for_the_record", "check_job"] as RunWake[]).filter(wakeIsQuiet), ["notice_for_the_record", "check_job"]);
});

test("DevSpec's label decides a notice batch; only an explicit for_the_record is ever quiet", () => {
	const record = systemNotice({ audience: "for_the_record" }) as never;
	const needs = systemNotice({ notice_id: NEEDS, audience: "needs_person" }) as never;
	const unreadable = { version: 1 as const, kind: "unreadable" as const, notice_id: RECORD, received_kind: "future", received_version: "1" };
	assert.equal(noticeNeedsPerson(record), false);
	assert.equal(noticeNeedsPerson(needs), true);
	assert.equal(noticeNeedsPerson(unreadable), true, "an unreadable notice is told to the person");
	assert.equal(noticeBatchWake([record]), "notice_for_the_record");
	assert.equal(noticeBatchWake([record, record]), "notice_for_the_record");
	assert.equal(noticeBatchWake([record, needs]), "notice_needs_person");
	assert.equal(noticeBatchWake([record, unreadable]), "notice_needs_person");
	assert.equal(noticeBatchWake([]), "notice_needs_person", "an empty batch is never read as quiet");
});

// ---- The tell_person mark -------------------------------------------------

test("the tell_person mark is read from DevSpec's appended block, never from wording", () => {
	const mark = { tell_person: { why: "changed_someone_elses_record", record: { type: "task", id: NEEDS }, owner: "someone_else", instruction: "Tell the person." } };
	const raw = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }, { type: "text", text: JSON.stringify(mark) }] };
	assert.equal(carriesTellPerson(unwrapMcpResult(raw).appended), true);
	assert.equal(carriesTellPerson(unwrapMcpResult(envelope({ ok: true, tell_person: true })).appended), false, "the result's own fields are not the mark");
	assert.equal(carriesTellPerson(unwrapMcpResult({ content: [{ type: "text", text: "{}" }, { type: "text", text: "please tell_person about this" }] }).appended), false);
	assert.equal(carriesTellPerson(unwrapMcpResult({ content: [{ type: "text", text: "{}" }, { type: "text", text: JSON.stringify({ devspec_account_notice: {} }) }] }).appended), false);
	assert.equal(carriesTellPerson(undefined), false);
});

test("the mark crosses from the tools extension to the run by tool call id, once", () => {
	noteTellPerson("call-1");
	assert.equal(takeTellPerson("call-2"), false);
	assert.equal(takeTellPerson("call-1"), true);
	assert.equal(takeTellPerson("call-1"), false, "taken once");
	noteTellPerson("");
	assert.equal(takeTellPerson(""), false, "no id, no mark");
	for (let index = 0; index < 300; index += 1) noteTellPerson(`old-${index}`);
	assert.equal(takeTellPerson("old-0"), false, "an untaken mark falls off; the store stays bounded");
	assert.equal(takeTellPerson("old-299"), true);
});

test("the wiring: tools note the mark by tool call id, and a finished tool call hands it to its segment", () => {
	assert.match(tools, /async execute\(toolCallId, params, _signal, _onUpdate, ctx\) \{\n\t+return executeVerb\(def\.name, params as Record<string, unknown>, ctx, toolCallId\);/);
	assert.match(tools, /if \(carriesTellPerson\(unwrapMcpResult\(raw\)\.appended\)\) noteTellPerson\(toolCallId\);/);
	const end = source.slice(source.indexOf('\tpi.on("tool_execution_end"'), source.indexOf('\tpi.on("session_shutdown"'));
	assert.match(end, /const tellPerson = takeTellPerson\(event\.toolCallId\);\n\t+if \(tellPerson && turn\) turn\.tellPerson = true;/);
	// A new request in the same run starts without the previous one's mark.
	assert.match(source, /turn\.localActivityReady = undefined;\n\t+turn\.tellPerson = undefined;/);
	// A notice batch is captured split by DevSpec's label.
	assert.match(source, /const \{ needsPerson, forTheRecord \} = noticeIdsFromDelivery\(msg\?\.details\);/);
});

// ---- The real segment writers ---------------------------------------------

function harness(turn: Record<string, unknown>) {
	const hooks: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
	const requests: Array<{ name: string; args: Record<string, unknown> }> = [];
	const room: Array<{ message: string; opts: Record<string, unknown> }> = [];
	const warnings: string[] = [], journal: string[] = [], posts: Promise<void>[] = [];
	const bond = { connectionId: CONNECTION, sessionId: "room", connectionCapability: "cap" };
	class DevspecToolError extends Error {}
	const sandbox = {
		AssistantSpeechSource, AssistantSpeechQueue, assistantSpeechWithinBudget, unwrapMcpResult, parsePostSessionReceipt, TurnTracker, shouldSplitSpeech, isClosedAnswer, extractAssistantParts,
		noticeReplyFinalText, noticeReplyTerminalMessage, postNoticeReply, remoteRunActivityPolicy, DevspecToolError, runSpeaks, wakeIsQuiet,
		turn, pump: { bond, generation: 1, stop: false }, lastCtx: { hasUI: true }, AGENT_NAME: "Pi",
		getBond: () => bond, resolveToken: async () => ({ token: "private-bearer" }), replyModelArgs: () => ({}),
		randomUUID: () => "20202020-2020-4202-8202-202020202020",
		noteProgressEvent() {}, debug() {}, telemetry: { addMessageUsage() {} }, safeHasUI: () => true,
		notify: (_ctx: unknown, warning: string) => warnings.push(warning), noteOwnRoomMessage: () => {},
		trackTerminalPost: (post: Promise<void>) => posts.push(post), splitTurnAtBoundary() { journal.push("split"); },
		INTERACTION_EVENT_CUSTOM_TYPE: "interaction", QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE: "dismissal", FINAL_TRAIL_CHARS: 100000,
		planSettle() { return { kind: "none" }; }, isCommandTurnUnbound: () => true, interactionIdentity: () => undefined,
		nextTrailDelayMs: () => 0, commandTurnBindings: { forgetByCommand() {} }, activeCommandStyles: new Map(), noteCommandTurnClosed() {},
		postToSession: async (message: string, opts: Record<string, unknown>) => { room.push({ message, opts }); return true; },
		callDevspec: async (_token: string, name: string, args: Record<string, unknown>, opts: { beforeSend?: () => void }) => {
			opts.beforeSend?.();
			requests.push({ name, args });
			if (args.system_notice_ids) {
				return envelope({ delivery: { status: "stored", message_id: "row" }, message_id: "row", session_id: "room", connection_id: args.connection_id, phase: "answer", notice_reply: { notice_ids: args.system_notice_ids }, turn_effect: "none", complete_turn: false });
			}
			return envelope({ connection_id: args.connection_id, session_id: "room", phase: "answer", assistant_source_id: args.assistant_source_id, message_id: "row", delivery: { status: "stored", message_id: "row" } });
		},
		pi: { on: (name: string, fn: typeof hooks[string]) => hooks[name] = fn, appendEntry: (type: string) => journal.push(type) },
	};
	const api = runInNewContext(stripTypeScriptTypes(`${voice}\n${speech}\n${tick}\n${terminalError}\n${segment}\n${endHook}\n({ postSegmentAnswer, trailTick, reportTerminalError, segmentWake })`), sandbox) as {
		postSegmentAnswer: (t: unknown, stats: null, why: string, complete?: boolean) => Promise<boolean>;
		trailTick: () => void;
		reportTerminalError: (t: unknown, stats: null) => Promise<void>;
		segmentWake: (t: unknown) => RunWake;
	};
	return { hooks, api, requests, room, warnings, journal, drain: () => Promise.all(posts) };
}

/** A segment with a v2 speech binding ready, as prepareAssistantSpeech leaves an attached run. */
function liveSegment(wake: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const tracker = new TurnTracker();
	tracker.userMessage(wake);
	const trail = new TrailBuilder();
	trail.toolStart("call-1", "claim_check_job", { check_job_id: JOB });
	trail.toolEnd("call-1", "claim_check_job", true, envelope({ ok: true }));
	const trailDelivery = new TrailDeliveryState();
	trailDelivery.markDirty();
	const args = Object.freeze({ connection_id: CONNECTION, ingest_version: 2 });
	const binding = { args, current: () => true, capability: "cap", sessionId: "room", ready: Promise.resolve({ args, token: "private-bearer" }) };
	return {
		revision: 1, tracker, trail, trailDelivery, completionNeutral: false, canPost: () => true, speechManaged: true,
		receiptBatch: { noteAssistantText() {}, suppressEmptyFallback() { return false; }, deferTrail() { return false; } },
		trailPostFence: { track() {} }, posts: 0, lastPostAt: 0,
		assistantSpeech: { source: new AssistantSpeechSource(), binding, model: {} },
		...extra,
	};
}

/** Each assistant message gets its own source, as each LLM round's context hook gives it. */
async function say(h: ReturnType<typeof harness>, t: Record<string, unknown>, text: string, stopReason = "stop", tools = false) {
	if (t.assistantSpeech) (t.assistantSpeech as Record<string, unknown>).source = new AssistantSpeechSource();
	await h.hooks.message_end({ message: assistant(text, stopReason, tools) }, {});
}

test("a check-job run posts nothing to the room: no speech, no trail, no answer, no error notice", async () => {
	const t = liveSegment(checkJobWake, { terminalError: "402 Insufficient balance" });
	const h = harness(t);
	assert.equal(h.api.segmentWake(t), "check_job");
	await say(h, t, "I'll take the check and rule its entries.", "toolUse", true);
	await say(h, t, "Completed all 4 comparisons: no conflicts.");
	h.api.trailTick();
	await h.drain();
	assert.equal(await h.api.postSegmentAnswer(t, null, "run_end", true), false, "it completes no turn by an answer");
	await h.api.reportTerminalError(t, null);
	assert.deepEqual(h.requests, [], "no speech post");
	assert.deepEqual(h.room, [], "no trail, answer or error post");
	assert.deepEqual(h.warnings, []);
	assert.ok(!h.journal.includes("devspec-assistant-speech"), "nothing journalled as posted speech");
});

test("a check-job run whose write changed someone else's record speaks from the mark on, like any run", async () => {
	const t = liveSegment(checkJobWake);
	const h = harness(t);
	await say(h, t, "I'll fold the duplicate.", "toolUse", true);
	t.tellPerson = true; // tool_execution_end took DevSpec's mark for the write
	await say(h, t, "I closed Sam's task as a duplicate of yours.");
	await h.drain();
	assert.deepEqual(h.requests.map((request) => [request.name, request.args.message, request.args.ingest_version]), [
		["post_session_message", "I closed Sam's task as a duplicate of yours.", 2],
	]);
	assert.equal(h.requests[0]!.args.system_notice_ids, undefined);
	// Still no trail: a finished trail-only row would be drawn in the conversation.
	h.api.trailTick();
	assert.equal(await h.api.postSegmentAnswer(t, null, "run_end", true), false);
	assert.deepEqual(h.room, []);
});

test("a person's command speaks exactly as before: speech, trail and answer writers all run", async () => {
	const t = liveSegment("[DevSpec remote — message from Ali Price] check the release", { commandTurnId: "turn", commandMessageId: "message" });
	const h = harness(t);
	assert.equal(h.api.segmentWake(t), "person");
	await say(h, t, "On it.", "toolUse", true);
	await say(h, t, "The release is green.");
	await h.drain();
	assert.deepEqual(h.requests.map((request) => request.args.message), ["On it.", "The release is green."]);
	h.api.trailTick();
	assert.equal(h.room.length, 1, "the trail posts");
	assert.equal(h.room[0]!.opts.phase, "trail");
	await h.api.reportTerminalError({ ...t, terminalError: "402 Insufficient balance" }, null);
	assert.equal(h.room[1]?.opts.phase, "error", "a failed command still says why");
});

function noticeSegment(capture: Record<string, unknown>): Record<string, unknown> {
	return { revision: 1, tracker: new TurnTracker(), trail: new TrailBuilder(), trailDelivery: new TrailDeliveryState(), completionNeutral: true,
		canPost: () => true, speechManaged: true, receiptBatch: { noteAssistantText() {}, suppressEmptyFallback() { return false; } },
		noticeReply: { connectionId: CONNECTION, noticeIds: [], forTheRecordIds: [], roomPromised: true, finalText: null, ...capture } };
}

test("a run woken only by for-the-record notices posts nothing, not even an acknowledgement", async () => {
	const t = noticeSegment({ forTheRecordIds: [RECORD] });
	const h = harness(t);
	assert.equal(h.api.segmentWake(t), "notice_for_the_record");
	await say(h, t, "Folded my duplicate into my earlier task.");
	await h.drain();
	assert.equal(await h.api.postSegmentAnswer(t, null, "run_end", true), false);
	assert.deepEqual(h.requests, []);
	assert.deepEqual(h.room, []);
	assert.deepEqual(h.warnings, []);
});

test("a for-the-record run that changed someone else's record tells the room in an ordinary message", async () => {
	const t = noticeSegment({ forTheRecordIds: [RECORD] });
	const h = harness(t);
	await say(h, t, "I merged my duplicate into Sam's task, which changed it.");
	t.tellPerson = true;
	await h.drain();
	assert.equal(await h.api.postSegmentAnswer(t, null, "run_end", true), false, "it opens and completes no turn");
	assert.equal(h.requests.length, 1);
	const { name, args } = h.requests[0]!;
	assert.equal(name, "post_session_message");
	assert.deepEqual({ ...args }, { connection_id: CONNECTION, ingest_version: 2, assistant_source_id: "20202020-2020-4202-8202-202020202020",
		message: "I merged my duplicate into Sam's task, which changed it.", phase: "answer", complete_turn: false });
	assert.deepEqual(h.room, []);
});

test("a batch with a notice that needs a person replies, naming only that notice", async () => {
	const t = noticeSegment({ noticeIds: [NEEDS], forTheRecordIds: [RECORD] });
	const h = harness(t);
	assert.equal(h.api.segmentWake(t), "notice_needs_person");
	await say(h, t, "Your task clashes with Sam's decision; want me to revise it?");
	await h.drain();
	await h.api.postSegmentAnswer(t, null, "run_end", true);
	assert.deepEqual(h.requests.map((request) => request.args.system_notice_ids), [[NEEDS]]);
	assert.deepEqual(h.room, []);
});
