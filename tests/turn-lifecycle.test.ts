import assert from "node:assert/strict";
import { test } from "node:test";
import { assertHydratedAssignmentIdentity, dispatchImplementationDelivery, formatDispatchMessage, isPlaybookDispatch } from "../extensions/core/dispatch.ts";
import { IMPLEMENTATION_CONTRACT_RESOURCE_URI, type ImplementationContractContext } from "../extensions/core/implementation-contract.ts";
import { automaticBackgroundTaskId, backgroundTaskNotificationId, classifyUserKind, isClosedAnswer, isClosedAnswerBoundary, isDeliveryBoundary, isHarnessOrigin, isWaitNarration, isProcessClose, planSettle, shouldPauseSettle, shouldSplitFirstAnswer, TurnTracker } from "../extensions/core/turn-lifecycle.ts";

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
	assert.equal(isHarnessOrigin("synthetic extension content", "future-extension-message"), true);
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

test("pi-subagents completion notifications are synthetic, not owner prompts", () => {
	const completion = [
		"Background task completed: **workflow**",
		"",
		"Workflow completed with 1 child run(s). Return: {",
		'  "runId": "39192d20",',
		'  "artifactPaths": ["/private/subagent-artifacts/owner-dispatch.md"]',
		"}",
	].join("\n");

	assert.equal(isHarnessOrigin(completion, "subagent-notify"), true);
	assert.equal(classifyUserKind(completion, "subagent-notify"), "harness");
	assert.equal(isHarnessOrigin(completion), true, "rendered-text backstop survives missing customType");
	assert.equal(isHarnessOrigin("Background tasks completed (2): **worker**, **reviewer**\n\n1. worker\ncomplete"), true);
	assert.equal(isHarnessOrigin("Detached foreground task failed: **worker**\n\nprocess failed"), true);
	assert.equal(isHarnessOrigin("Background task completed: **workflow** — why did this appear?"), false, "a typed question that quotes only the heading stays local");

	const notification = new TurnTracker();
	notification.userMessage(completion, { customType: "subagent-notify" });
	notification.assistantFinal("That completion receipt was from the discarded fixture. No action needed.");
	assert.equal(notification.userKind, "harness");
	assert.equal(notification.shouldMirrorPrompt, false);
	const notificationPlan = planSettle(notification, true);
	assert.deepEqual(notificationPlan, { kind: "none" });
	assert.doesNotMatch(JSON.stringify(notificationPlan), /39192d20|subagent-artifacts|owner-dispatch\.md/);

	const remote = "[DevSpec remote — message from Ali Price to Ivory Koala]\nWhy is this attributed to me?";
	assert.equal(isHarnessOrigin(remote, "future-remote-envelope"), false);
	assert.equal(classifyUserKind(remote, "future-remote-envelope"), "remote");
	const dispatch = "[DevSpec remote — work dispatch from Ali Price]\nImplement the fix.";
	assert.equal(isHarnessOrigin(dispatch, "future-dispatch-envelope"), false);
	assert.equal(classifyUserKind(dispatch, "future-dispatch-envelope"), "dispatch");

	const activeOwner = new TurnTracker();
	activeOwner.userMessage(remote);
	activeOwner.assistantFinal("I found the attribution boundary and am checking it.", true);
	assert.equal(isDeliveryBoundary(activeOwner), true);
	activeOwner.noteBackgroundTask("unrelated-bg-task");
	activeOwner.userMessage(completion, { customType: "subagent-notify" });
	assert.equal(activeOwner.userKind, "remote", "synthetic receipt cannot overwrite the owner turn");
	assert.deepEqual(activeOwner.pendingBackgroundTasks(), ["unrelated-bg-task"], "unrelated ownership is untouched");
	assert.equal(activeOwner.resolveBackgroundTask("unrelated-bg-task"), true);
	activeOwner.assistantFinal("The synthetic-origin fix is complete.");
	const ownerPlan = planSettle(activeOwner, true);
	assert.deepEqual(ownerPlan, { kind: "final", message: "The synthetic-origin fix is complete." });
	assert.doesNotMatch(JSON.stringify(ownerPlan), /39192d20|subagent-artifacts|owner-dispatch\.md/);
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

	// Grok emits curly I’ll — same sentence must still be process (6ea9aa47).
	const curly = "Typecheck is still running. I’ll wait for that, then lint, commit, and check the panel in a real browser.";
	assert.equal(isWaitNarration(curly), true, "curly apostrophe must fold to ASCII I'll");
	assert.equal(isClosedAnswer({ text: curly, hasToolCalls: false, stopReason: "stop" }), false);
	assert.equal(isWaitNarration("Lint is still running. I’ll push and merge as soon as it finishes."), true);
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

test("bg_run then text-only close then [bg completed] posts the wrap-up (6ea9aa47)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\nCan you take over?");
	assert.equal(t.userKind, "remote");
	t.assistantFinal("I'll pick this up properly.", false);
	t.noteBackgroundTask("typecheck-panel");
	const parked = "Typecheck is still running. I’ll wait for that, then lint, commit, and check the panel in a real browser.";
	assert.equal(isClosedAnswer({
		text: parked,
		hasToolCalls: false,
		stopReason: "stop",
		awaitingBackground: true,
	}), false);
	t.assistantFinal(parked, isClosedAnswer({
		text: parked,
		hasToolCalls: false,
		stopReason: "stop",
		awaitingBackground: true,
	}));
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(t.lastCloseWasAnswer, false);
	assert.equal(isClosedAnswerBoundary(t), false);
	assert.equal(shouldPauseSettle(t), true);
	assert.deepEqual(planSettle(t, true), { kind: "none" }, "parked wait must not settle as the answer");
	assert.equal(t.lastAssistantText, "I'll pick this up properly.");

	t.userMessage("[bg completed] Typecheck panel tabs", {
		customType: "background-task-notification",
		backgroundTaskId: "typecheck-panel",
	});
	assert.equal(t.userKind, "remote", "bg completed must not steal the owner turn");
	assert.equal(t.awaitingBackground, false);
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(shouldPauseSettle(t), true, "parked wait stays paused until the wrap-up lands");

	const wrapUp = "Ali — slice 1 is actually on origin/staging now, not just announced.";
	t.assistantFinal(wrapUp, isClosedAnswer({ text: wrapUp, hasToolCalls: false, stopReason: "stop" }));
	assert.equal(t.lastCloseWasAnswer, true);
	assert.deepEqual(planSettle(t, true), { kind: "final", message: wrapUp });
});

test("a text-only close after bg_run is process even without wait wording (6ea9aa47)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\ncontinue");
	t.noteBackgroundTask("lint");
	const parked = "Independent useful work is queued. Coming back when lint finishes.";
	assert.equal(isWaitNarration(parked), false);
	assert.equal(isProcessClose({ text: parked, awaitingBackground: true }), true);
	t.assistantFinal(parked, isClosedAnswer({
		text: parked,
		hasToolCalls: false,
		stopReason: "stop",
		awaitingBackground: true,
	}));
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(t.lastAssistantText, "");
	assert.equal(shouldPauseSettle(t), true);
});

test("first-answer split preserves parked wait state (9b66a177)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\ncontinue");
	t.noteBackgroundTask("typecheck");
	const wait = "Typecheck is still running. I’ll wait for it, then lint from the worktree and ship.";
	t.assistantFinal(wait, isClosedAnswer({
		text: wait,
		hasToolCalls: true,
		stopReason: "toolUse",
		awaitingBackground: true,
	}));
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(t.awaitingBackground, true);
	const next = new TurnTracker();
	next.carryUser(t.userText, t);
	assert.equal(next.awaitingBackground, true);
	assert.equal(next.lastCloseWasProcess, true);
	assert.equal(next.lastAssistantText, "");
	assert.equal(shouldPauseSettle(next), true);
});

test("empty assistantFinal does not clear lastCloseWasProcess (9b66a177)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\ncontinue");
	t.noteBackgroundTask("typecheck");
	const wait = "Typecheck is still running. I’ll wait for it, then lint from the worktree and ship.";
	t.assistantFinal(wait, false);
	assert.equal(t.lastCloseWasProcess, true);
	t.assistantFinal("");
	t.assistantFinal("\u200B", true);
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(t.lastCloseWasAnswer, false);
	assert.equal(shouldPauseSettle(t), true);
});

test("harness [bg completed] keeps lastCloseWasProcess on a live owner turn (9b66a177)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\ncontinue");
	t.noteBackgroundTask("typecheck-header");
	const wait = "Typecheck is still running. I’ll wait for it, then lint from the worktree and ship.";
	t.assistantFinal(wait, false);
	assert.equal(t.lastCloseWasProcess, true);
	t.userMessage("[bg completed] Typecheck header menu", {
		customType: "background-task-notification",
		backgroundTaskId: "typecheck-header",
	});
	assert.equal(t.userKind, "remote");
	assert.equal(t.awaitingBackground, false);
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(shouldPauseSettle(t), true);
});

test("first-answer + bg_run + wait + empty close + [bg completed] posts the wrap-up (9b66a177)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\nAmazing ok let's continue");
	const opener = "Continuing with the header Agents menu: live headline plus a jump into the Agents tab.";
	assert.equal(shouldSplitFirstAnswer(t, { text: opener, hasToolCalls: true }), true);
	t.assistantFinal(opener, true);
	const next = new TurnTracker();
	next.carryUser(t.userText, t);
	next.noteBackgroundTask("typecheck-menu");
	const wait = "Selection wiring is already there. Typecheck is running; I’ll wait for it, then lint from the worktree and ship.";
	next.assistantFinal(wait, isClosedAnswer({
		text: wait,
		hasToolCalls: true,
		stopReason: "toolUse",
		awaitingBackground: true,
	}));
	assert.equal(next.lastAssistantText, "");
	assert.equal(next.lastCloseWasProcess, true);
	next.assistantFinal("");
	assert.equal(next.lastCloseWasProcess, true);
	assert.equal(shouldPauseSettle(next), true);
	assert.deepEqual(planSettle(next, true), { kind: "none" });
	next.userMessage("[bg completed] Typecheck header menu", {
		customType: "background-task-notification",
		backgroundTaskId: "typecheck-menu",
	});
	assert.equal(next.userKind, "remote");
	assert.equal(next.lastCloseWasProcess, true);
	const wrapUp = "Ali — slice 3 is on staging. Header Agents menu now shows a working agent’s live headline.";
	next.assistantFinal(wrapUp, isClosedAnswer({ text: wrapUp, hasToolCalls: false, stopReason: "stop" }));
	assert.equal(next.lastCloseWasAnswer, true);
	assert.deepEqual(planSettle(next, true), { kind: "final", message: wrapUp });
});

test("automatic background task receipts require a successful notifying wake", () => {
	const live = {
		details: {
			task: {
				id: "task-live",
				notifyOnCompletion: true,
				triggerOnCompletion: true,
			},
		},
	};
	assert.equal(automaticBackgroundTaskId("bg_run", live), "task-live");
	assert.equal(automaticBackgroundTaskId("bg_run", live, true), null, "failed launch cannot park the turn");
	assert.equal(automaticBackgroundTaskId("bg_logs", live), null, "inspection receipts cannot re-arm a completed task");
	assert.equal(automaticBackgroundTaskId("bg_run", { details: { task: { ...live.details.task, notifyOnCompletion: false } } }), null);
	assert.equal(automaticBackgroundTaskId("bg_delegate", { details: { task: { ...live.details.task, triggerOnCompletion: false } } }), null);
	assert.equal(automaticBackgroundTaskId("fusion_validate", { details: { task: { id: "missing-flags" } } }), null);
});

test("terminal notification ids prefer structured details and fall back to the envelope", () => {
	const xml = "<background-task-notification><task-id>task-xml</task-id><status>failed</status></background-task-notification>";
	assert.equal(backgroundTaskNotificationId(xml), "task-xml");
	assert.equal(backgroundTaskNotificationId(xml, { id: "task-details" }), "task-details");
	assert.equal(backgroundTaskNotificationId("<task-id>running</task-id><status>running</status>"), null);
	assert.equal(backgroundTaskNotificationId("<task-id>done</task-id>", { status: "completed" }), "done");
	assert.equal(backgroundTaskNotificationId("[bg killed] unknown"), null);
});

test("overlapping background completions preserve the owner turn until the final wrap-up (15cb0983)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Amber Hawk]\nImplement the next slices.");
	t.noteBackgroundTask("gate-a");
	t.noteBackgroundTask("gate-b");
	assert.deepEqual(t.pendingBackgroundTasks(), ["gate-a", "gate-b"]);

	const parked = "The gates are running; I’ll merge and browser-check when green.";
	t.assistantFinal(parked, false);
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(shouldPauseSettle(t), true);

	// A completes twice (before_agent_start + message_start). The duplicate is
	// idempotent and must not consume sibling B.
	const completeA = {
		customType: "background-task-notification",
		backgroundTaskId: "gate-a",
	};
	t.userMessage("[bg completed] gate A", completeA);
	t.userMessage("[bg completed] gate A", completeA);
	assert.deepEqual(t.pendingBackgroundTasks(), ["gate-b"]);
	assert.equal(shouldPauseSettle(t), true);

	// The process-only response to A still cannot settle while B is live.
	t.assistantFinal("That was gate A; gate B remains active.", false);
	assert.equal(t.lastCloseWasProcess, true);
	assert.deepEqual(planSettle(t, true), { kind: "none" });

	// An unrelated leftover cannot consume B.
	t.userMessage("[bg killed] stale task", {
		customType: "background-task-notification",
		backgroundTaskId: "other-task",
	});
	assert.deepEqual(t.pendingBackgroundTasks(), ["gate-b"]);

	// B may complete, fail, or be killed: terminal state is represented by the
	// same matching id. The resulting substantive recap is the one answer.
	t.userMessage("[bg failed] gate B", {
		customType: "background-task-notification",
		backgroundTaskId: "gate-b",
	});
	assert.deepEqual(t.pendingBackgroundTasks(), []);
	const recap = "Two dependency slices are complete and deployed; all checks passed.";
	t.assistantFinal(recap, true);
	assert.deepEqual(planSettle(t, true), { kind: "final", message: recap });
});

test("pending background task identities survive delivery segment splits (15cb0983)", () => {
	const first = new TurnTracker();
	first.userMessage("[DevSpec remote — message from Ali Price to Amber Hawk]\nContinue.");
	first.noteBackgroundTask("deploy");
	first.noteBackgroundTask("browser-review");
	const continuation = new TurnTracker();
	continuation.carryUser(first.userText, first);
	assert.deepEqual(continuation.pendingBackgroundTasks(), ["deploy", "browser-review"]);
	continuation.resolveBackgroundTask("deploy");
	assert.deepEqual(first.pendingBackgroundTasks(), ["deploy", "browser-review"], "split copies ownership rather than aliasing it");
	assert.deepEqual(continuation.pendingBackgroundTasks(), ["browser-review"]);
});

test("leftover-only [bg completed] still posts no answer (56b9a3b4)", () => {
	const leftover = new TurnTracker();
	leftover.userMessage("[bg completed] Isolated typecheck", { customType: "background-task-notification" });
	leftover.assistantFinal("I'll wait for nothing — that receipt already passed.");
	assert.equal(leftover.userKind, "harness");
	assert.deepEqual(planSettle(leftover, true), { kind: "none" });
});

test("legacy assignment envelopes remain work (for mechanical hydration), never playbooks", () => {
	const legacy = { id: "legacy-assignment", mode: "direct" };
	assert.equal(dispatchImplementationDelivery(legacy), null);
	assert.equal(isPlaybookDispatch(legacy), false);
	assert.equal(isPlaybookDispatch({ id: "run-1", kind: "playbook_run" }), true);

	const hydratedLegacy = {
		id: "legacy-assignment",
		mode: "direct",
		members: [{ action_item_id: "legacy-item", title: "Legacy work" }],
	};
	const delivery = dispatchImplementationDelivery(hydratedLegacy);
	assert.ok(delivery);
	assert.equal(delivery.reference.contract_version, undefined);
	const context: ImplementationContractContext = {
		contractVersion: "4.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource",
		rules: [{ id: "core.claim-early", requirement: "Claim early; missing claims never block work." }],
	};
	assert.match(formatDispatchMessage(hydratedLegacy, "Wary Wolf", context, delivery), /"contract_version":"4.0.0"/);
});

test("formatDispatchMessage carries thin work/contract identity and payload", () => {
	const dispatch = {
		id: "as-1",
		implementation_kickoff: {
			kind: "devspec.implementation_kickoff",
			schema_version: 1,
			work: { assignment_id: "as-1", action_item_ids: ["item-1"] },
			implementation_contract: {
				contract_version: "4.0.0",
				resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
			},
		},
		members: [{ action_item_id: "item-1", title: "Fix flaky test" }],
	};
	const delivery = dispatchImplementationDelivery(dispatch);
	assert.ok(delivery);
	const context: ImplementationContractContext = {
		contractVersion: "4.0.0",
		contractHash: "sha256:contract",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource",
		rules: [
			{ id: "core.claim-early", requirement: "Claim early; missing claims never block work." },
			{ id: "core.stay-available", requirement: "Return to capacity." },
		],
	};
	const msg = formatDispatchMessage(dispatch, "Wary Wolf", context, delivery);
	assert.match(msg, /^\[DevSpec remote — work dispatch to Wary Wolf\]/);
	assert.match(msg, /Fix flaky test/);
	assert.match(msg, /"contract_version":"4.0.0"/);
	assert.match(msg, /acknowledge assignment as-1/i);
	assert.match(msg, /resolve that assignment/i);
	assert.match(msg, /core\.stay-available/);
	assert.match(msg, /"id": "as-1"/);
	assert.doesNotMatch(msg, /Run the assignment protocol/);
	assert.doesNotMatch(msg, /Claim each member with claim_work_item/);
	// No mode on the kickoff header, and no mode-specific resource named.
	assert.doesNotMatch(msg.split("\n")[1] ?? "", /execution_mode|attended/);
});

test("canonical dispatch contradictions fail closed instead of broadening work", () => {
	const canonical = {
		id: "as-1",
		implementation_kickoff: {
			kind: "devspec.implementation_kickoff",
			schema_version: 1,
			work: { assignment_id: "as-1", action_item_ids: ["item-a"] },
			implementation_contract: {
				contract_version: "4.0.0",
				resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
			},
		},
		members: [{ action_item_id: "item-a" }],
	};

	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		implementation_kickoff: { ...canonical.implementation_kickoff, kind: "devspec.implementation_lookalike" },
	}), /kind was invalid/);
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		implementation_kickoff: { ...canonical.implementation_kickoff, schema_version: 2 },
	}), /schema version was invalid/);
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		implementation_kickoff: {
			...canonical.implementation_kickoff,
			implementation_contract: {
				...canonical.implementation_kickoff.implementation_contract,
				resource_uri: "devspec://product/implementation-contract/attended",
			},
		},
	}), /named a contract resource Pi does not serve/);
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		members: [{ action_item_id: "item-a" }, { action_item_id: "item-b" }],
	}), /contradicted assignment members/);
	// A mode on the assignment or the kickoff is a server that has not caught up:
	// refuse it rather than work under a shape whose meaning was deleted.
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		execution_mode: "attended",
	}), /carried a retired execution mode/);
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		implementation_kickoff: { ...canonical.implementation_kickoff, execution_mode: "unattended" },
	}), /carried a retired execution mode/);
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		implementation_kickoff: {
			...canonical.implementation_kickoff,
			work: { ...canonical.implementation_kickoff.work, assignment_id: "as-other" },
		},
	}), /contradicted assignment identity/);
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		implementation_kickoff: {
			...canonical.implementation_kickoff,
			implementation_contract: {
				...canonical.implementation_kickoff.implementation_contract,
				contract_version: " ",
			},
		},
	}), /contract version was invalid/);
	assert.throws(() => dispatchImplementationDelivery({
		...canonical,
		implementation_kickoff: {
			...canonical.implementation_kickoff,
			work: { ...canonical.implementation_kickoff.work, action_item_ids: [] },
		},
	}), /requires at least one action-item id/);
});

test("hydration cannot substitute a different assignment than the triggering dispatch", () => {
	const delivery = dispatchImplementationDelivery({
		id: "assignment-b",
		members: [{ action_item_id: "item-b" }],
	});
	assert.ok(delivery);
	assert.throws(
		() => assertHydratedAssignmentIdentity("assignment-a", delivery),
		/hydration returned assignment-b while assignment-a was requested/,
	);
	assert.doesNotThrow(() => assertHydratedAssignmentIdentity("assignment-b", delivery));
});

test("canonical kickoff absence preserves the isolated legacy-member compatibility path", () => {
	// A legacy `mode: autopilot` row used to synthesize an unattended delivery.
	// There is nothing to synthesize onto now, so it is simply ignored.
	assert.deepEqual(dispatchImplementationDelivery({
		id: "legacy-1",
		mode: "autopilot",
		members: [{ action_item_id: "legacy-item" }],
	}), {
		assignmentId: "legacy-1",
		actionItemIds: ["legacy-item"],
		reference: { resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
	});
});
