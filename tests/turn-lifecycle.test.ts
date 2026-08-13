import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDispatchMessage } from "../extensions/core/dispatch.ts";
import { classifyUserKind, isClosedAnswer, isClosedAnswerBoundary, isDeliveryBoundary, isHarnessOrigin, isWaitNarration, planSettle, shouldSplitFirstAnswer, TurnTracker } from "../extensions/core/turn-lifecycle.ts";

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
	// A leftover bg receipt is harness origin: no remirror, no answer bubble.
	const s3 = new TurnTracker();
	s3.userMessage("<background-task-notification>\n  <status>completed</status>\n</background-task-notification>");
	s3.assistantFinal("That lint receipt is the isolated check that already passed. No further action.");
	assert.equal(s3.userKind, "harness");
	assert.deepEqual(planSettle(s3, true), { kind: "none" });
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

test("typed slash commands stay local — we do not filter a leading /", () => {
	assert.equal(classifyUserKind("/bg-update"), "local");
	assert.equal(isHarnessOrigin("/bg-update"), false);
	const t = new TurnTracker();
	t.userMessage("/bg-update");
	t.assistantFinal("here is how to update");
	assert.equal(t.userKind, "local");
	assert.equal(t.shouldMirrorPrompt, true);
	assert.deepEqual(planSettle(t, true), {
		kind: "local_mirror",
		prompt: "/bg-update",
		answer: "here is how to update",
	});
});

test("leftover [bg completed] / customType is harness: no remirror, no answer", () => {
	assert.equal(isHarnessOrigin("[bg completed] Isolated lint (abc123)"), true);
	assert.equal(isHarnessOrigin("hello", "background-task-notification"), true);
	assert.equal(isHarnessOrigin("Also just to confirm that the Pi package doesn't use MCP"), false);

	const xml = new TurnTracker();
	xml.userMessage("<background-task-notification>\n  <task-id>abc</task-id>\n</background-task-notification>");
	xml.assistantFinal("That typecheck receipt is the isolated run that already passed. No further action.");
	assert.deepEqual(planSettle(xml, true), { kind: "none" });

	const typedThenLeftover = new TurnTracker();
	typedThenLeftover.userMessage("Also just to confirm native tools?");
	typedThenLeftover.assistantFinal("Yes — native tools are the connection.", true);
	assert.deepEqual(planSettle(typedThenLeftover, true), {
		kind: "local_mirror",
		prompt: "Also just to confirm native tools?",
		answer: "Yes — native tools are the connection.",
	});
	// Continuation after first-answer split must not remirror the typed prompt.
	const cont = new TurnTracker();
	cont.carryUser(typedThenLeftover.userText);
	cont.assistantFinal("more work after the answer");
	assert.equal(cont.userKind, "local");
	assert.equal(cont.shouldMirrorPrompt, false);
	assert.deepEqual(planSettle(cont, true), { kind: "final", message: "more work after the answer" });

	// A leftover wake that then replays the typed prompt stays harness.
	const leftover = new TurnTracker();
	leftover.userMessage("[bg completed] Isolated typecheck", { customType: "background-task-notification" });
	leftover.userMessage("Also just to confirm native tools?");
	leftover.assistantFinal("That typecheck receipt already passed. No further action.");
	assert.equal(leftover.userKind, "harness");
	assert.equal(leftover.shouldMirrorPrompt, false);
	assert.deepEqual(planSettle(leftover, true), { kind: "none" });
});

test("display:false DevSpec context injections never remirror as local prompts", () => {
	assert.equal(isHarnessOrigin("### DevSpec memory — auto-recall\nBINDING"), true);
	assert.equal(isHarnessOrigin("cards", "devspec-proactive"), true);
	assert.equal(isHarnessOrigin("[DevSpec remote — bond context for Rapid Quokka]\nYou are attached"), true);
	assert.equal(isHarnessOrigin("tail", "devspec-attach-context"), true);
	assert.equal(isHarnessOrigin("[DevSpec remote — room orientation for Rapid Quokka]\nRecent activity"), true);
	assert.equal(isHarnessOrigin("digest", "devspec-room-orientation"), true);

	const recall = new TurnTracker();
	recall.userMessage("### DevSpec memory — auto-recall\nMechanically recalled for this turn's prompt.", { customType: "devspec-proactive" });
	recall.assistantFinal("Looking good now, Ali.");
	assert.equal(recall.userKind, "harness");
	assert.equal(recall.shouldMirrorPrompt, false);
	assert.deepEqual(planSettle(recall, true), { kind: "none" });

	const attach = new TurnTracker();
	attach.userMessage("[DevSpec remote — bond context for Rapid Quokka]\nYou are attached", { customType: "devspec-attach-context" });
	attach.assistantFinal("ok");
	assert.deepEqual(planSettle(attach, true), { kind: "none" });

	const orient = new TurnTracker();
	orient.userMessage("[DevSpec remote — room orientation for Rapid Quokka]\nRecent activity", { customType: "devspec-room-orientation" });
	orient.assistantFinal("ok");
	assert.deepEqual(planSettle(orient, true), { kind: "none" });

	// A real owner envelope that quotes the recall heading stays remote.
	const quoted = new TurnTracker();
	quoted.userMessage("[DevSpec remote — message from Ali Price to Rapid Quokka]\nwhat about the DevSpec memory auto-recall!?");
	quoted.assistantFinal("That block is not from you.");
	assert.equal(quoted.userKind, "remote");
	assert.deepEqual(planSettle(quoted, true), { kind: "final", message: "That block is not from you." });

	// Typed local prompts still mirror once.
	const typed = new TurnTracker();
	typed.userMessage("Ok I reloaded, how's it looking now?");
	typed.assistantFinal("Looking good.");
	assert.equal(typed.userKind, "local");
	assert.deepEqual(planSettle(typed, true), {
		kind: "local_mirror",
		prompt: "Ok I reloaded, how's it looking now?",
		answer: "Looking good.",
	});
});

test("mid-turn context injection keeps the original remote turn and posts the wrap-up", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Rapid Quokka]\nwhat about the auto-recall!?");
	t.assistantFinal("That recall block was injected with display:false.", true);
	assert.equal(t.userKind, "remote");
	t.userMessage("### DevSpec memory — auto-recall\nMechanically recalled", { customType: "devspec-proactive" });
	assert.equal(t.userKind, "remote", "harness must not overwrite an in-flight remote turn");
	assert.equal(t.shouldMirrorPrompt, false);
	t.assistantFinal("You're right, Ali. That auto-recall block was not from you.");
	assert.deepEqual(planSettle(t, true), {
		kind: "final",
		message: "You're right, Ali. That auto-recall block was not from you.",
	});
});

test("wait-narration is process, not a closed answer (15d7aa56)", () => {
	const wait = "I'll wait for the linked-modules v2 tests, then commit both repos. Independent work is done.";
	assert.equal(isWaitNarration(wait), true);
	assert.equal(isWaitNarration("I'll wait for the poll-connection suite. Independent work is done."), true);
	assert.equal(isWaitNarration("I'll wait for v2 typecheck, then rebase, commit, and merge. Independent work is done."), true);
	assert.equal(isClosedAnswer({ text: wait, hasToolCalls: false, stopReason: "stop" }), false);
	// Owner-directed waits stay answers.
	assert.equal(isWaitNarration("I'll wait for your go-ahead, Ali."), false);
	assert.equal(isWaitNarration("Want me to wait for the tests?"), false);
	assert.equal(isClosedAnswer({ text: "I'll wait for your go-ahead, Ali.", hasToolCalls: false, stopReason: "stop" }), true);
});

test("remote wait-narration + bg completed + wrap-up posts the wrap-up, not the wait", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Drifting Mantis]\nOkay. I reloaded, so let's continue.");
	assert.equal(t.userKind, "remote");
	const wait = "I'll wait for the linked-modules v2 tests, then commit both repos. Independent work is done.";
	assert.equal(isClosedAnswer({ text: wait, hasToolCalls: false, stopReason: "stop" }), false);
	t.assistantFinal(wait, isClosedAnswer({ text: wait, hasToolCalls: false, stopReason: "stop" }));
	assert.equal(t.lastCloseWasAnswer, false);
	assert.equal(isClosedAnswerBoundary(t), false, "wait-narration must not split a bubble");
	assert.equal(t.lastAssistantText, "", "wait text never becomes the stored answer");
	assert.equal(t.awaitingFirstAnswer, true);

	// Several wait-splits later, a leftover bg receipt must stay harness and
	// must not overwrite the live remote turn (60cf5f00 still holds).
	t.userMessage("[bg completed] linked-modules v2 tests", { customType: "background-task-notification" });
	assert.equal(t.userKind, "remote", "bg completed must not steal the owner turn");
	t.assistantFinal("I'll wait for the poll-connection suite. Independent work is done.", false);
	t.userMessage("[bg completed] poll-connection suite", { customType: "background-task-notification" });
	assert.equal(t.userKind, "remote");

	const wrapUp = "CONTROL shipped. Stop is on the now-line. Compact is in the tooltip.";
	t.assistantFinal(wrapUp, isClosedAnswer({ text: wrapUp, hasToolCalls: false, stopReason: "stop" }));
	assert.equal(t.lastCloseWasAnswer, true);
	assert.deepEqual(planSettle(t, true), { kind: "final", message: wrapUp });
});

test("leftover-only [bg completed] still posts no answer (56b9a3b4)", () => {
	const leftover = new TurnTracker();
	leftover.userMessage("[bg completed] Isolated typecheck", { customType: "background-task-notification" });
	leftover.assistantFinal("I'll wait for nothing — that receipt already passed.");
	assert.equal(leftover.userKind, "harness");
	assert.deepEqual(planSettle(leftover, true), { kind: "none" });
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
