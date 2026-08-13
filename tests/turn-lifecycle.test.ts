import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDispatchMessage } from "../extensions/core/dispatch.ts";
import { isClosedAnswer, isClosedAnswerBoundary, isDeliveryBoundary, planSettle, shouldSplitFirstAnswer, TurnTracker } from "../extensions/core/turn-lifecycle.ts";

function remoteTurn(answer: string): TurnTracker {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\ndo the thing");
	t.assistantFinal(answer);
	return t;
}

test("userMessage classifies remote / dispatch / local", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\nhi");
	assert.equal(t.userKind, "remote");
	const d = new TurnTracker();
	d.userMessage("[DevSpec remote — work dispatch to Wary Wolf]\n…");
	assert.equal(d.userKind, "dispatch");
	const l = new TurnTracker();
	l.userMessage("just typing locally");
	assert.equal(l.userKind, "local");
});

test("remote run → the final assistant message is the answer (mechanical, single writer)", () => {
	const plan = planSettle(remoteTurn("here is the answer"), true);
	assert.deepEqual(plan, { kind: "final", message: "here is the answer" });
});

test("run-scoped: the LAST round's closing text is the answer, however many rounds preceded (cc9e8c43)", () => {
	// A multi-round tool-looping run: each round produces assistant text, the
	// run ends with the real answer. The tracker is created once per run, so
	// every round's text lands on the SAME tracker and the final round wins.
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\ndo the thing");
	t.assistantFinal("round 1 narration — not the answer");
	t.assistantFinal("round 2 narration — still not the answer");
	t.assistantFinal("the answer");
	assert.deepEqual(planSettle(t, true), { kind: "final", message: "the answer" });
});

test("a zero-width / whitespace-only final text never produces a bubble", () => {
	const t = remoteTurn("\u200B");
	assert.equal(t.lastAssistantText, "");
	assert.deepEqual(planSettle(t, true), { kind: "none" });
	const spaces = remoteTurn("   \n  ");
	assert.deepEqual(planSettle(spaces, true), { kind: "none" });
	// …and a zero-width round mid-run does not wipe a real earlier text.
	const mid = remoteTurn("real closing text");
	mid.assistantFinal("\u200B");
	assert.deepEqual(planSettle(mid, true), { kind: "final", message: "real closing text" });
});

test("local runs mirror the prompt then the answer", () => {
	const t = new TurnTracker();
	t.userMessage("local question");
	t.assistantFinal("local answer");
	assert.deepEqual(planSettle(t, true), {
		kind: "local_mirror",
		prompt: "local question",
		answer: "local answer",
	});
});

test("nothing posts when unattached, or when the run had no answer text", () => {
	assert.deepEqual(planSettle(remoteTurn("answer"), false), { kind: "none" });
	const silent = new TurnTracker();
	silent.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\nhi");
	assert.deepEqual(planSettle(silent, true), { kind: "none" });
});

test("the new single-line envelope still classifies as remote (2b072496)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf] do the thing");
	assert.equal(t.userKind, "remote");
});

test("a user message with an accumulated answer is a delivery boundary (b1fb756a)", () => {
	// Segment has produced text → the injection closes it as its own bubble.
	assert.equal(isDeliveryBoundary(remoteTurn("the answer so far")), true);
	// No text yet → the injection just joins the open segment.
	const fresh = new TurnTracker();
	assert.equal(isDeliveryBoundary(fresh), false);
	const zw = new TurnTracker();
	zw.assistantFinal("\u200B");
	assert.equal(isDeliveryBoundary(zw), false, "zero-width narration is not an answer worth closing on");
});

test("segments deliver per message: each message's answer is its own bubble (b1fb756a)", () => {
	// Segment 1: remote question → answer text accumulates.
	const s1 = remoteTurn("answer one");
	assert.equal(isDeliveryBoundary(s1), true);
	assert.deepEqual(planSettle(s1, true), { kind: "final", message: "answer one" });
	// The followUp starts segment 2: it classifies and answers independently —
	// segment 1's text is gone from the tracker, never replaced-at-run-end.
	const s2 = new TurnTracker();
	s2.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\nsecond question");
	s2.assistantFinal("answer two");
	assert.equal(s2.userKind, "remote");
	assert.deepEqual(planSettle(s2, true), { kind: "final", message: "answer two" });
	// A notification-segment (no remote prefix) mirrors as a local prompt pair.
	const s3 = new TurnTracker();
	s3.userMessage("[background task finished]");
	s3.assistantFinal("ack");
	assert.deepEqual(planSettle(s3, true), { kind: "local_mirror", prompt: "[background task finished]", answer: "ack" });
});

test("a text-only assistant close is a finished answer (f0df6c3e)", () => {
	assert.equal(isClosedAnswer({ text: "You're right. I'll measure the recall path.", hasToolCalls: false, stopReason: "stop" }), true);
	assert.equal(isClosedAnswer({ text: "You're right. I'll measure the recall path.", hasToolCalls: false, stopReason: null }), true, "missing stopReason with no tools is still a close");
	assert.equal(isClosedAnswer({ text: "looking", hasToolCalls: true, stopReason: "toolUse" }), false);
	assert.equal(isClosedAnswer({ text: "looking", hasToolCalls: true, stopReason: "stop" }), false, "toolCall blocks win over stopReason");
	assert.equal(isClosedAnswer({ text: "looking", hasToolCalls: false, stopReason: "toolUse" }), false);
	assert.equal(isClosedAnswer({ text: "", hasToolCalls: false, stopReason: "stop" }), false);
	assert.equal(isClosedAnswer({ text: "\u200B", hasToolCalls: false, stopReason: "stop" }), false);
	assert.equal(isClosedAnswer({ text: "partial", hasToolCalls: false, stopReason: "aborted" }), false);
	assert.equal(isClosedAnswer({ text: "partial", hasToolCalls: false, stopReason: "error" }), false);
	assert.equal(isClosedAnswer({ text: "partial", hasToolCalls: false, stopReason: "length" }), false);
});

test("the next assistant round after a text-only close is a delivery boundary", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\ninterrupt");
	t.assistantFinal("You're right. I'll measure it.", true);
	assert.equal(isClosedAnswerBoundary(t), true);
	assert.equal(isDeliveryBoundary(t), true);
	// A tool-loop close is NOT a finished answer — later rounds stay on this segment.
	const loop = new TurnTracker();
	loop.assistantFinal("looking", false);
	assert.equal(isClosedAnswerBoundary(loop), false);
	assert.equal(isDeliveryBoundary(loop), true);
	// A zero-width close cannot be an answer boundary.
	const empty = new TurnTracker();
	empty.assistantFinal("\u200B", true);
	assert.equal(isClosedAnswerBoundary(empty), false);
});

test("first user-facing text after a user message splits even when the same message has tools (f0df6c3e r2)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\ninterrupt");
	assert.equal(t.awaitingFirstAnswer, true);
	assert.equal(
		shouldSplitFirstAnswer(t, { text: "Yes Ali — interrupt landed. Carrying on.", hasToolCalls: true }),
		true,
	);
	// Consume the first answer the way message_end does.
	t.assistantFinal("Yes Ali — interrupt landed. Carrying on.", true);
	assert.equal(t.awaitingFirstAnswer, false);
	assert.equal(shouldSplitFirstAnswer(t, { text: "looking", hasToolCalls: true }), false, "later tool-loop narration does not split again");

	const next = new TurnTracker();
	next.carryUser(t.userText);
	assert.equal(next.awaitingFirstAnswer, false);
	assert.equal(next.userKind, "remote");
	assert.equal(shouldSplitFirstAnswer(next, { text: "looking", hasToolCalls: true }), false);

	const silent = new TurnTracker();
	silent.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\nhi");
	assert.equal(shouldSplitFirstAnswer(silent, { text: "", hasToolCalls: true }), false);
	assert.equal(shouldSplitFirstAnswer(silent, { text: "Ali, I'll check the attachments.", hasToolCalls: false }), false, "text-only first close waits for the next round or settle so Working can clear");
});

test("formatDispatchMessage carries the protocol steps and payload", () => {
	const msg = formatDispatchMessage({ assignment_id: "as-1", title: "Fix flaky test" }, "Wary Wolf");
	assert.match(msg, /^\[DevSpec remote — work dispatch to Wary Wolf\]/);
	assert.match(msg, /Fix flaky test/);
	assert.match(msg, /get_assignment \(assignment_id: "as-1"\)/);
	assert.match(msg, /acknowledge_assignment/);
	assert.match(msg, /resolve_assignment/);
	assert.match(msg, /"assignment_id": "as-1"/);
});
