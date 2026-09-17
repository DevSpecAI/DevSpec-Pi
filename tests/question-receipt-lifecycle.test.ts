import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	DirectedQuestionReceiptBatch,
	TrailPostFence,
	directedQuestionTranscriptReceiptId,
	isPotentialDirectedQuestionCreate,
	isReceiptOwningDirectedQuestionCreate,
} from "../extensions/core/question-receipt-lifecycle.ts";

const RECEIPT_A = "11111111-1111-4111-8111-111111111111";
const RECEIPT_B = "22222222-2222-4222-8222-222222222222";
const receiptResult = (id = RECEIPT_A) => ({
	terminate: true,
	details: { question: { transcriptMessageId: id } },
});

function finishReceipt(batch: DirectedQuestionReceiptBatch, id: string, revision = 1): void {
	batch.start(id, revision, true);
	batch.finish(id, { success: true, terminatingReceipt: true }, revision);
}

test("receipt identity is strict host-only control metadata", () => {
	assert.equal(directedQuestionTranscriptReceiptId(receiptResult()), RECEIPT_A);
	assert.equal(directedQuestionTranscriptReceiptId({ details: { question: { transcriptMessageId: null } } }), null);
	assert.equal(directedQuestionTranscriptReceiptId({ details: { question: { transcriptMessageId: "not-a-uuid" } } }), null);
	assert.equal(isPotentialDirectedQuestionCreate("manage_directed_question", { action: "create" }), true);
	assert.equal(isPotentialDirectedQuestionCreate("manage_directed_question", { action: "list" }), false);
	assert.equal(isReceiptOwningDirectedQuestionCreate("manage_directed_question", receiptResult(), false), true);
	assert.equal(isReceiptOwningDirectedQuestionCreate("manage_directed_question", receiptResult(), true), false);
	assert.equal(isReceiptOwningDirectedQuestionCreate("manage_plan", receiptResult(), false), false);
	assert.equal(isReceiptOwningDirectedQuestionCreate("manage_poll", receiptResult(), false), false);
	assert.equal(isReceiptOwningDirectedQuestionCreate("manage_directed_question", { ...receiptResult(), terminate: false }, false), false);
});

test("a deferred prior trail post blocks takeover while the candidate stops new timer posts", async () => {
	const batch = new DirectedQuestionReceiptBatch();
	const fence = new TrailPostFence();
	batch.reset(1);
	let release!: () => void;
	const priorPost = new Promise<void>((resolve) => { release = resolve; });
	fence.track(priorPost);
	batch.start("create", 1, true);
	assert.equal(batch.deferTrail(1), true, "candidate is synchronous before drain");
	let drained = false;
	const takeover = fence.drain().then(() => { drained = true; });
	await Promise.resolve();
	assert.equal(drained, false, "tool invocation remains behind the prior projection");
	release();
	await takeover;
	assert.equal(drained, true);
	assert.equal(fence.size, 0);
});

test("trail fence consumes rejected fire-and-forget posts without an unhandled drain failure", async () => {
	const fence = new TrailPostFence();
	fence.track(Promise.reject(new Error("post failed")));
	await fence.drain();
	assert.equal(fence.size, 0);
});

test("invalidated detach fence still drains posts already in flight", async () => {
	const fence = new TrailPostFence();
	let release!: () => void;
	fence.track(new Promise<void>((resolve) => { release = resolve; }));
	fence.invalidate();
	let drained = false;
	const waiting = fence.drain().then(() => { drained = true; });
	await Promise.resolve();
	assert.equal(drained, false);
	release();
	await waiting;
	assert.equal(drained, true);
});

test("receipt fence rollover hands unresolved predecessor posts to the new authority", async () => {
	const oldFence = new TrailPostFence();
	let release!: () => void;
	oldFence.track(new Promise<void>((resolve) => { release = resolve; }));
	const replacement = oldFence.rollover();
	assert.equal(replacement.size, 1);
	let drained = false;
	const createGate = replacement.drain().then(() => { drained = true; });
	await Promise.resolve();
	assert.equal(drained, false, "new create still waits for the old projection");
	release();
	await createGate;
	assert.equal(drained, true);
	assert.equal(replacement.size, 0);
});

test("repeated rollover stays flat and rejection-safe", async () => {
	const first = new TrailPostFence();
	let reject!: (error: Error) => void;
	first.track(new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
	const second = first.rollover();
	const third = second.rollover();
	assert.equal(second.size, 1);
	assert.equal(third.size, 1, "one in-flight post, not a nested predecessor chain");
	reject(new Error("old post failed"));
	await third.drain();
	await second.drain();
	await first.drain();
	assert.equal(first.size, 0);
	assert.equal(second.size, 0);
	assert.equal(third.size, 0);
	assert.equal(third.rollover().size, 0, "settled predecessors are not retained");
});

test("a pure receipt-owning create suppresses only the empty fallback", () => {
	const batch = new DirectedQuestionReceiptBatch();
	batch.reset(1);
	finishReceipt(batch, "create", 1);
	assert.equal(batch.deferTrail(1), true);
	assert.equal(batch.suppressEmptyFallback(1), true);
});

test("multiple all-receipt creates remain one receipt-owned terminal batch", () => {
	const batch = new DirectedQuestionReceiptBatch();
	batch.reset(1);
	finishReceipt(batch, "create-a", 1);
	finishReceipt(batch, "create-b", 1);
	assert.equal(batch.suppressEmptyFallback(1), true);
	assert.equal(directedQuestionTranscriptReceiptId(receiptResult(RECEIPT_B)), RECEIPT_B);
});

test("mixed siblings resume ordinary accumulated projection in either completion order", () => {
	for (const receiptFirst of [true, false]) {
		const batch = new DirectedQuestionReceiptBatch();
		batch.reset(1);
		batch.start("receipt", 1, true);
		batch.start("other", 1, false);
		const receipt = () => batch.finish("receipt", { success: true, terminatingReceipt: true }, 1);
		const other = () => batch.finish("other", { success: true, terminatingReceipt: false }, 1);
		if (receiptFirst) {
			receipt();
			assert.equal(batch.deferTrail(1), false, "known mixed sibling resumes after takeover completes");
			other();
		} else {
			other();
			receipt();
		}
		assert.equal(batch.deferTrail(1), false);
		assert.equal(batch.suppressEmptyFallback(1), false);
	}
});

test("failed and missing-receipt creates never suppress legacy projection", () => {
	for (const outcome of [
		{ success: false, terminatingReceipt: false },
		{ success: true, terminatingReceipt: false },
	]) {
		const batch = new DirectedQuestionReceiptBatch();
		batch.reset(1);
		batch.start("create", 1, true);
		batch.finish("create", outcome, 1);
		assert.equal(batch.deferTrail(1), false);
		assert.equal(batch.suppressEmptyFallback(1), false);
	}
});

test("timer race defers during takeover and resumes once a started sibling makes the batch mixed", () => {
	const batch = new DirectedQuestionReceiptBatch();
	batch.reset(1);
	batch.start("receipt", 1, true);
	batch.start("slow", 1, false);
	assert.equal(batch.deferTrail(1), true, "potential receipt blocks timer before outcome");
	batch.finish("receipt", { success: true, terminatingReceipt: true }, 1);
	assert.equal(batch.deferTrail(1), false, "started non-receipt sibling makes the batch mixed");
	assert.equal(batch.suppressEmptyFallback(1), false, "pending sibling prevents terminal suppression");
	batch.finish("slow", { success: true, terminatingReceipt: false }, 1);
	assert.equal(batch.deferTrail(1), false);
});

test("substantive assistant text after receipt projects normally", () => {
	const batch = new DirectedQuestionReceiptBatch();
	batch.reset(1);
	finishReceipt(batch, "create", 1);
	batch.noteAssistantText("Here is additional context.", 1);
	assert.equal(batch.deferTrail(1), false);
	assert.equal(batch.suppressEmptyFallback(1), false);
});

test("newer revision invalidates stale receipt suppression and stale results", () => {
	const batch = new DirectedQuestionReceiptBatch();
	batch.reset(1);
	finishReceipt(batch, "create", 1);
	assert.equal(batch.suppressEmptyFallback(1), true);
	batch.reset(2);
	batch.finish("late-old", { success: true, terminatingReceipt: true }, 1);
	batch.finish("late-old-current-revision", { success: true, terminatingReceipt: true }, 2);
	assert.equal(batch.suppressEmptyFallback(1), false);
	assert.equal(batch.suppressEmptyFallback(2), false);
});

test("installed Pi awaits tool_execution_start handlers before invoking the tool", () => {
	const session = readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js", import.meta.url), "utf8");
	const loop = readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js", import.meta.url), "utf8");
	const sessionStart = session.indexOf('event.type === "tool_execution_start"');
	const sessionEnd = session.indexOf('event.type === "tool_execution_update"', sessionStart);
	assert.match(session.slice(sessionStart, sessionEnd), /await this\._extensionRunner\.emit\(extensionEvent\)/);
	const parallel = loop.indexOf("async function executeToolCallsParallel");
	const prepare = loop.indexOf("const preparation = await prepareToolCall", parallel);
	const emitted = loop.lastIndexOf("await emit({", prepare);
	assert.ok(parallel >= 0 && emitted > parallel && emitted < prepare);
	assert.match(loop.slice(emitted, prepare), /type: "tool_execution_start"/);
});

test("remote wiring suppresses only fallback trail and still exact-completes activity", () => {
	const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
	const answerStart = remote.indexOf("async function postSegmentAnswer");
	const answerEnd = remote.indexOf("async function settleTurn", answerStart);
	const answer = remote.slice(answerStart, answerEnd);
	assert.match(answer, /plan\.kind === "final"[^]*postToSession/);
	assert.match(answer, /t\.trailDelivery\.dirty && !t\.trailDelivery\.blocked && activityTrail && !t\.receiptBatch\.suppressEmptyFallback\(t\.revision\)/);
	const startHandler = remote.slice(remote.indexOf('pi.on("tool_execution_start"'), remote.indexOf('pi.on("tool_execution_update"'));
	assert.match(startHandler, /potentialReceipt[^]*receiptBatch\.start[^]*await trackedTurn\.trailPostFence\.drain\(\)[^]*turn === trackedTurn[^]*trackedTurn\.revision === revision[^]*ctx\.abort\(\)/);
	const resetStart = remote.indexOf("function resetDirectedQuestionReceiptBatch");
	const resetEnd = remote.indexOf("function trailTick", resetStart);
	assert.match(remote.slice(resetStart, resetEnd), /trailPostFence = turn\.trailPostFence\.rollover\(\)/);
	const settledStart = remote.indexOf('pi.on("agent_settled"');
	const settledEnd = remote.indexOf("// ---- Turn lifecycle events", settledStart);
	const settled = remote.slice(settledStart, settledEnd);
	assert.match(settled, /if \(!posted && activityPolicy\.reportCompletion && pendingBackgroundTaskIds\.size === 0 && \(settlingTurn\?\.canPost\(\) \?\? pump === activeAtSettle\)\)[^]*reportComplete\("turn_end"/);
});

test("answer-event ingress stays transcript-neutral until Pi authors substantive follow-up", () => {
	const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
	const start = remote.indexOf("async function applyInteractionEvent");
	const end = remote.indexOf("async function drainInteractionRetries", start);
	const apply = remote.slice(start, end);
	assert.doesNotMatch(apply, /postToSession|post_session_message/);
	assert.match(apply, /pi_appendInteractionEntry\("observed"/);
	assert.match(apply, /interactionDelivery\.stage/);
});
