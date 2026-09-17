import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAutomationRunMessage, isAutomationRunEnvelope, automationRunId } from "../extensions/core/dispatch.ts";
import { INTERACTION_EVENT_CUSTOM_TYPE, formatInteractionEventContinuation, type InteractionEventV1 } from "../extensions/core/interaction-events.ts";
import { automaticBackgroundTaskId, backgroundTaskNotificationId, classifyUserKind, isBackgroundCompletionOrigin, isClosedAnswer, isClosedAnswerBoundary, isDeliveryBoundary, isHarnessOrigin, isReceiptAcknowledgement, isSubagentAsyncNotification, isWaitNarration, isProcessClose, planSettle, shouldSplitSpeech, TurnTracker } from "../extensions/core/turn-lifecycle.ts";

function remoteTurn(answer: string): TurnTracker {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\ndo the thing");
	t.assistantFinal(answer);
	return t;
}

test("userMessage classifies remote / automation / local", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\nhi");
	assert.equal(t.userKind, "remote");
	const automation = new TurnTracker();
	automation.userMessage("[DevSpec remote — automation run to Wary Wolf]\n…");
	assert.equal(automation.userKind, "automation");
	const l = new TurnTracker();
	l.userMessage("just typing locally");
	assert.equal(l.userKind, "local");
});

test("directed-question custom continuation is genuine activity but never remote command ingress", () => {
	const interactionEvent: InteractionEventV1 = {
		kind: "devspec.interaction_event",
		version: 1,
		event_id: "11111111-1111-4111-8111-111111111111",
		response_id: "22222222-2222-4222-8222-222222222222",
		question_id: "33333333-3333-4333-8333-333333333333",
		origin_connection_id: "44444444-4444-4444-8444-444444444444",
		source_session_id: "55555555-5555-4555-8555-555555555555",
		response_kind: "text",
		answer: "yes",
		answered_at: "2026-08-25T12:00:00.000Z",
		claim_token: "66666666-6666-4666-8666-666666666666",
		lease_expires_at: "2026-08-25T12:00:30.000Z",
	};
	const message = formatInteractionEventContinuation(interactionEvent);
	assert.equal(isHarnessOrigin(message), false, "formatter prefix is the text fallback when customType is unavailable");
	assert.equal(classifyUserKind(message), "interaction");
	assert.equal(isHarnessOrigin("host omitted the envelope", INTERACTION_EVENT_CUSTOM_TYPE), false,
		"customType remains the primary classification signal");
	assert.equal(classifyUserKind("host omitted the envelope", INTERACTION_EVENT_CUSTOM_TYPE), "interaction");
	const tracker = new TurnTracker();
	tracker.userMessage(message, { customType: INTERACTION_EVENT_CUSTOM_TYPE });
	tracker.assistantFinal("Continuing the original workflow.");
	assert.deepEqual(planSettle(tracker, true), { kind: "final", message: "Continuing the original workflow." });
	assert.equal(tracker.userKind, "interaction");
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

test("every user-facing text on a tool-carrying message splits into its own bubble (759f2818/8f2e3224)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\ninterrupt");
	assert.equal(t.awaitingFirstAnswer, true);
	assert.equal(
		shouldSplitSpeech(t, { text: "Yes Ali — interrupt landed. Carrying on.", hasToolCalls: true }),
		true,
	);
	// Consume the first answer the way message_end does.
	assert.equal(t.assistantFinal("Yes Ali — interrupt landed. Carrying on.", true), "stored");
	assert.equal(t.awaitingFirstAnswer, false);
	// Kimi-style bundling: narration rides every tool-carrying round, and every
	// one of them is a bubble now — the first-answer-only gate lost them all.
	assert.equal(shouldSplitSpeech(t, { text: "looking at the ledger first", hasToolCalls: true }), true);

	const next = new TurnTracker();
	next.carryUser(t.userText);
	assert.equal(next.awaitingFirstAnswer, false);
	assert.equal(next.userKind, "remote");
	assert.equal(shouldSplitSpeech(next, { text: "still narrating", hasToolCalls: true }), true);

	const silent = new TurnTracker();
	silent.userMessage("[DevSpec remote — message from Ali to Wary Wolf]\nhi");
	assert.equal(shouldSplitSpeech(silent, { text: "", hasToolCalls: true }), false);
	assert.equal(shouldSplitSpeech(silent, { text: "Ali, I'll check the attachments.", hasToolCalls: false }), false, "text-only closes stay deferred to the next round or settle so the final answer rides complete_turn:true");
	// Wait-narration never splits, tools or not.
	assert.equal(shouldSplitSpeech(t, { text: "I'll wait for the suite, then commit. Independent work is done.", hasToolCalls: true }), false);
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
	assert.equal(isSubagentAsyncNotification(completion, "subagent-notify"), true);
	assert.equal(isSubagentAsyncNotification("Detached foreground task completed: **worker**\n\ndone", "subagent-notify"), false);
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
	const automation = "[DevSpec remote — automation run to Ivory Koala]\nRun the supplied automation.";
	assert.equal(isHarnessOrigin(automation, "future-automation-envelope"), false);
	assert.equal(classifyUserKind(automation, "future-automation-envelope"), "automation");

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

test("bg_run then wait-narration close then [bg completed] posts the wrap-up (6ea9aa47)", () => {
	// Wiring-faithful: the opener rode a tool-carrying message, so message_end
	// split-posted it and the continuation segment starts empty (carryUser).
	const opened = new TurnTracker();
	opened.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\nCan you take over?");
	assert.equal(shouldSplitSpeech(opened, { text: "I'll pick this up properly.", hasToolCalls: true }), true);
	opened.assistantFinal("I'll pick this up properly.", true);

	const t = new TurnTracker();
	t.carryUser(opened.userText, opened);
	t.noteBackgroundTask("typecheck-panel");
	const parked = "Typecheck is still running. I’ll wait for that, then lint, commit, and check the panel in a real browser.";
	assert.equal(isClosedAnswer({ text: parked, hasToolCalls: false, stopReason: "stop" }), false);
	assert.equal(t.assistantFinal(parked, false), "process");
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(t.lastCloseWasAnswer, false);
	assert.equal(isClosedAnswerBoundary(t), false);
	// No pause any more: the settle delivers nothing new (the opener already
	// posted) and the turn closes — Working ends instead of spinning.
	assert.deepEqual(planSettle(t, true), { kind: "none" }, "wait text never settles as the answer");
	assert.equal(t.lastAssistantText, "");

	// The completion wake is a NEW harness segment (settle released the old
	// one); receipt acknowledgements stay trail-only…
	t.userMessage("[bg completed] Typecheck panel tabs", {
		customType: "background-task-notification",
		backgroundTaskId: "typecheck-panel",
	});
	assert.equal(t.userKind, "remote", "bg completed must not steal the owner turn");
	assert.equal(t.awaitingBackground, false);

	const wrapUp = "Ali — slice 1 is actually on origin/staging now, not just announced.";
	t.assistantFinal(wrapUp, isClosedAnswer({ text: wrapUp, hasToolCalls: false, stopReason: "stop" }));
	assert.equal(t.lastCloseWasAnswer, true);
	assert.deepEqual(planSettle(t, true), { kind: "final", message: wrapUp });
});

test("a substantive text-only close after bg_run is speech — pending tasks never eat it (759f2818)", () => {
	// The 2026-09-17 morning session: the 2.6k-char final report closed
	// text-only while deploy watchers were pending, and the old blanket rule
	// (text-only + awaitingBackground = process) discarded it whole. Pending
	// background work is irrelevant to speech classification now.
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\ncontinue");
	t.noteBackgroundTask("lint");
	const report = "Done — diagnosed, fixed, shipped, and verified live. " + "Detail. ".repeat(200);
	assert.equal(isWaitNarration(report), false);
	assert.equal(isProcessClose({ text: report }), false, "pending bg tasks cannot make substantive speech process");
	assert.equal(isClosedAnswer({ text: report, hasToolCalls: false, stopReason: "stop" }), true);
	assert.equal(t.assistantFinal(report, true), "stored");
	assert.equal(t.lastCloseWasProcess, false);
	assert.deepEqual(planSettle(t, true), { kind: "final", message: report.trim() });

	// The wait-class shapes the blanket rule was built for are still process,
	// via isWaitNarration alone.
	const parked = "Independent work is done. I'll wait for the lint results.";
	assert.equal(isProcessClose({ text: parked }), true);
});

test("new command speech posts normally with inherited background work, then the wake recap is its own bubble (6f4424bd)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Honest Crocodile]\nShip the sync fix.");
	t.noteBackgroundTask("staging-ci");
	const parked = "CI is still running. I’ll wait for it before closing the item.";
	t.assistantFinal(parked, false);
	assert.equal(t.lastCloseWasProcess, true);

	// The owner interrupts: the new command's first response needs no override
	// machinery any more — bundled speech splits like any other, and a
	// text-only answer settles complete_turn:true (the turn closes; the
	// pending CI task does not hold it open).
	const command = "[DevSpec remote — message from Ali Price to Honest Crocodile]\nExplain the NUL item.";
	t.userMessage(command);
	const answer = "It is unrelated housekeeping and does not change the Features work.";
	assert.equal(shouldSplitSpeech(t, { text: answer, hasToolCalls: false }), false, "text-only answers post at settle, not mid-message");
	t.assistantFinal(answer, true);
	assert.deepEqual(planSettle(t, true), { kind: "final", message: answer });

	const continuation = new TurnTracker();
	continuation.carryUser(t.userText, t);
	assert.deepEqual(continuation.pendingBackgroundTasks(), ["staging-ci"], "ownership survives for wake correlation/bookkeeping only");
	continuation.userMessage("[bg completed] staging CI", {
		customType: "background-task-notification",
		backgroundTaskId: "staging-ci",
	});
	const recap = "The housekeeping item is now done and staging CI is green.";
	continuation.assistantFinal(recap, true);
	assert.deepEqual(planSettle(continuation, true), { kind: "final", message: recap });
});

test("background-interrupted local and automation commands answer normally (6f4424bd)", () => {
	const local = new TurnTracker();
	local.userMessage("Start the long check.");
	local.noteBackgroundTask("local-check");
	local.userMessage("What does that result mean?");
	const localAnswer = "It means the runtime behavior is unchanged.";
	assert.equal(shouldSplitSpeech(local, { text: localAnswer, hasToolCalls: false }), false);
	local.assistantFinal(localAnswer, true);
	assert.deepEqual(planSettle(local, true), {
		kind: "local_mirror",
		prompt: "What does that result mean?",
		answer: localAnswer,
	});

	const automation = new TurnTracker();
	automation.userMessage("[DevSpec remote — automation run Alpha]\nStart checks.");
	automation.noteBackgroundTask("automation-check");
	automation.userMessage("[DevSpec remote — automation run Beta]\nExplain status.");
	const automationAnswer = "The first gate passed; the second remains active.";
	assert.equal(shouldSplitSpeech(automation, { text: automationAnswer, hasToolCalls: false }), false);
	automation.assistantFinal(automationAnswer, true);
	assert.deepEqual(planSettle(automation, true), { kind: "final", message: automationAnswer });
});

test("explicit wait narration after a new command remains process-only (6f4424bd)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Honest Crocodile]\nStart checks.");
	t.noteBackgroundTask("ci");
	t.userMessage("[DevSpec remote — message from Ali Price to Honest Crocodile]\nAny update?");
	const wait = "CI is still running, Ali. I’ll wait for it, then report the result.";
	assert.equal(isWaitNarration(wait), true, "addressing Ali does not make a work wait conversational");
	assert.equal(shouldSplitSpeech(t, { text: wait, hasToolCalls: false }), false);
	assert.equal(shouldSplitSpeech(t, { text: wait, hasToolCalls: true }), false, "wait-narration never splits a bubble, tools or not");
	t.assistantFinal(wait, false);
	assert.equal(t.lastCloseWasProcess, true);
	assert.deepEqual(planSettle(t, true), { kind: "none" });
});

test("speech split preserves wait state on the continuation (9b66a177)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\ncontinue");
	t.noteBackgroundTask("typecheck");
	const wait = "Typecheck is still running. I’ll wait for it, then lint from the worktree and ship.";
	assert.equal(shouldSplitSpeech(t, { text: wait, hasToolCalls: true }), false, "wait-narration never splits");
	t.assistantFinal(wait, isClosedAnswer({ text: wait, hasToolCalls: true, stopReason: "toolUse" }));
	assert.equal(t.lastCloseWasProcess, true);
	assert.equal(t.awaitingBackground, true);
	const next = new TurnTracker();
	next.carryUser(t.userText, t);
	assert.equal(next.awaitingBackground, true);
	assert.equal(next.lastCloseWasProcess, true);
	assert.equal(next.lastAssistantText, "");
	assert.deepEqual(planSettle(next, true), { kind: "none" });
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
	assert.deepEqual(planSettle(t, true), { kind: "none" }, "nothing stored — settle closes without a bubble");
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
});

test("speech + bg_run + wait + empty close + [bg completed] posts the wrap-up (9b66a177)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Lucky Meerkat]\nAmazing ok let's continue");
	const opener = "Continuing with the header Agents menu: live headline plus a jump into the Agents tab.";
	assert.equal(shouldSplitSpeech(t, { text: opener, hasToolCalls: true }), true);
	t.assistantFinal(opener, true);
	const next = new TurnTracker();
	next.carryUser(t.userText, t);
	next.noteBackgroundTask("typecheck-menu");
	const wait = "Selection wiring is already there. Typecheck is running; I’ll wait for it, then lint from the worktree and ship.";
	next.assistantFinal(wait, isClosedAnswer({ text: wait, hasToolCalls: true, stopReason: "toolUse" }));
	assert.equal(next.lastAssistantText, "");
	assert.equal(next.lastCloseWasProcess, true);
	next.assistantFinal("");
	assert.equal(next.lastCloseWasProcess, true);
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

test("async subagent ownership: parent settles honestly, the completion wake posts the recap (759f2818)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Fearless Walrus]\nImplement the ledger foundation.");
	const opener = "I’ve claimed the foundation and delegated the implementation review.";
	assert.equal(shouldSplitSpeech(t, { text: opener, hasToolCalls: true }), true);
	t.assistantFinal(opener, true);

	const continuation = new TurnTracker();
	continuation.carryUser(t.userText, t);
	continuation.noteBackgroundTask("pi-subagents:active-fleet");
	// "Still active" status is foreground speech — it posts like anything else.
	// Pending children never hold the turn open; the run settled, so the turn
	// closes and Working clears until the completion wake reopens it.
	const parked = "The child implementation is still active; I’ll resume when it finishes.";
	continuation.assistantFinal(parked, isClosedAnswer({ text: parked, hasToolCalls: false, stopReason: "stop" }));
	assert.deepEqual(planSettle(continuation, true), { kind: "final", message: parked });

	assert.equal(continuation.resolveBackgroundTask("pi-subagents:stale-fleet"), false, "stale completion cannot consume active bookkeeping");
	assert.equal(continuation.resolveBackgroundTask("pi-subagents:active-fleet"), true);

	// The completion wake is a fresh harness segment — and because the wake was
	// a background completion, its substantive recap is room content.
	const wake = new TurnTracker();
	wake.userMessage("Background task completed: **fleet**\n\nAll children settled.", { customType: "subagent-notify" });
	assert.equal(wake.userKind, "harness");
	assert.equal(wake.harnessSpeechAllowed, true);
	const recap = "The delegated implementation is complete and all checks passed.";
	assert.equal(wake.assistantFinal(recap, true), "stored");
	assert.deepEqual(planSettle(wake, true), { kind: "final", message: recap });
});

test("terminal notification ids prefer structured details and fall back to the envelope", () => {
	const xml = "<background-task-notification><task-id>task-xml</task-id><status>failed</status></background-task-notification>";
	assert.equal(backgroundTaskNotificationId(xml), "task-xml");
	assert.equal(backgroundTaskNotificationId(xml, { id: "task-details" }), "task-details");
	assert.equal(backgroundTaskNotificationId("<task-id>running</task-id><status>running</status>"), null);
	assert.equal(backgroundTaskNotificationId("<task-id>done</task-id>", { status: "completed" }), "done");
	assert.equal(backgroundTaskNotificationId("[bg killed] unknown"), null);
});

test("overlapping background completions keep idempotent bookkeeping; speech is never gated on them (15cb0983)", () => {
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Amber Hawk]\nImplement the next slices.");
	t.noteBackgroundTask("gate-a");
	t.noteBackgroundTask("gate-b");
	assert.deepEqual(t.pendingBackgroundTasks(), ["gate-a", "gate-b"]);

	// Gate progress is foreground speech: it posts even while a sibling task
	// runs. Nothing parks the turn any more.
	const progress = "The gates are running; I’ll merge and browser-check when green.";
	t.assistantFinal(progress, false);
	assert.equal(t.lastCloseWasProcess, false);

	// A completes twice (before_agent_start + message_start). The duplicate is
	// idempotent and must not consume sibling B.
	const completeA = {
		customType: "background-task-notification",
		backgroundTaskId: "gate-a",
	};
	t.userMessage("[bg completed] gate A", completeA);
	t.userMessage("[bg completed] gate A", completeA);
	assert.deepEqual(t.pendingBackgroundTasks(), ["gate-b"]);

	// The mid-run wake response is speech too (it posts); B still pending is
	// irrelevant to classification.
	t.assistantFinal("That was gate A; gate B remains active.", false);
	assert.equal(t.lastCloseWasProcess, false);

	// An unrelated leftover cannot consume B.
	t.userMessage("[bg killed] stale task", {
		customType: "background-task-notification",
		backgroundTaskId: "other-task",
	});
	assert.deepEqual(t.pendingBackgroundTasks(), ["gate-b"]);

	// B may complete, fail, or be killed: terminal state is represented by the
	// same matching id. The substantive wrap-up is the closing answer.
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
	assert.deepEqual(first.pendingBackgroundTasks(), ["deploy", "browser-review"], "standalone trackers still copy rather than alias");
	assert.deepEqual(continuation.pendingBackgroundTasks(), ["browser-review"]);
});

test("the wiring's connection-scoped pending set is shared across segments and wakes (759f2818 presence)", () => {
	// Presence must survive the per-segment tracker replacement at splits and
	// the settle→wake handoff: every tracker the wiring builds gets the SAME
	// set, so a task noted on one segment keeps Working alive until its
	// completion resolves it on whichever segment is current.
	const shared = new Set<string>();
	const first = new TurnTracker(shared);
	first.userMessage("[DevSpec remote — message from Ali Price to Amber Hawk]\nContinue.");
	first.noteBackgroundTask("pulse-check");
	const continuation = new TurnTracker(shared);
	continuation.carryUser(first.userText, first);
	continuation.noteBackgroundTask("commit-watch");
	assert.deepEqual(first.pendingBackgroundTasks(), ["pulse-check", "commit-watch"], "a later segment's launch is visible to the earlier one");
	const wake = new TurnTracker(shared);
	wake.userMessage("[bg completed] pulse check", {
		customType: "background-task-notification",
		backgroundTaskId: "pulse-check",
	});
	assert.deepEqual(first.pendingBackgroundTasks(), ["commit-watch"], "a resolve anywhere resolves everywhere");
	assert.equal(wake.awaitingBackground, true, "the sibling task still holds presence");
	wake.resolveBackgroundTask("commit-watch");
	assert.equal(wake.awaitingBackground, false);
	assert.equal(first.awaitingBackground, false, "last resolution releases Working for every segment");
});

test("2026-09-17 replay: the substantive report settles the turn; delayed bg receipts cannot replace it (759f2818)", () => {
	// Session 9f671595 / Pi file 01a0ae9d: four bg tasks (install, two builds,
	// deploy watcher) pending when the 2.6k-char final report closed text-only.
	// Old behaviour: process-classified, settle paused, and the last wake's
	// receipt posted as THE answer. New contract, step by step:
	const t = new TurnTracker();
	t.userMessage("[DevSpec remote — message from Ali Price to Dapper Wolf]\nI can't upload screenshots…");
	for (const id of ["install", "build-1", "build-2", "deploy-watch"]) t.noteBackgroundTask(id);
	const report = "Done — diagnosed, fixed, shipped, and verified live. The item is recorded as done.\n\n## What was actually wrong\n\n" + "Signal desktop wrote JPEG bytes under a .png filename. ".repeat(40);
	// The report is speech even with four tasks pending, and the settle posts it.
	assert.equal(t.assistantFinal(report, true), "stored");
	assert.deepEqual(planSettle(t, true), { kind: "final", message: report.trim() });

	// Each delayed wake is its own harness segment now (the owner segment
	// settled). Pure receipts stay trail-only and cannot become room content.
	const receipts = [
		"That's just the completion receipt for the worktree npm install from earlier — already consumed and accounted for. No action needed; the work it supported is finished and shipped.",
		"Another delayed receipt for a check I already consumed (the pre-merge production build — it passed, and the post-rebase build passed too). Nothing left open: the fix is on staging.",
		"Final receipt (the deploy watcher) — already acted on: that deploy is the one I verified the fix against. Everything is closed out; nothing further to do.",
	];
	for (const receipt of receipts) {
		const wake = new TurnTracker();
		wake.userMessage("<background-task-notification><task-id>x</task-id><status>completed</status></background-task-notification>");
		assert.equal(wake.userKind, "harness");
		assert.equal(wake.harnessSpeechAllowed, true);
		assert.equal(isReceiptAcknowledgement(receipt), true, `receipt classified: ${receipt.slice(0, 40)}`);
		assert.equal(wake.assistantFinal(receipt, true), "process");
		assert.deepEqual(planSettle(wake, true), { kind: "none" }, "receipts never become the room answer");
	}

	// …but a wake carrying real news (a failed gate, fresh verification) posts.
	const wake = new TurnTracker();
	wake.userMessage("[bg failed] staging deploy", { customType: "background-task-notification" });
	const news = "The deploy watcher came back red: the staging build failed on a type error in the telemetry merge. I've filed it and am checking whether my change is implicated.";
	assert.equal(isReceiptAcknowledgement(news), false);
	assert.equal(wake.assistantFinal(news, true), "stored");
	assert.deepEqual(planSettle(wake, true), { kind: "final", message: news });
});

test("receipt acknowledgements are short and formulaic; substance always escapes (759f2818)", () => {
	assert.equal(isReceiptAcknowledgement("Expected teardown of the last verification server — everything is shipped, merged to staging, and recorded. Nothing outstanding on my side."), true);
	assert.equal(isReceiptAcknowledgement("All done. No further action."), true);
	// Over 500 chars is never a receipt — the length cap is the safety rail.
	assert.equal(isReceiptAcknowledgement("No action needed. " + "x".repeat(600)), false);
	assert.equal(isReceiptAcknowledgement("The watcher fired and the deploy is LIVE — I re-ran Ali's exact file through the composer and it sent."), false);
	assert.equal(isReceiptAcknowledgement(""), false);
});

test("only background completions arm harness speech — context injections stay silent (60cf5f00)", () => {
	assert.equal(isBackgroundCompletionOrigin("<background-task-notification><task-id>t</task-id><status>completed</status></background-task-notification>", null), true);
	assert.equal(isBackgroundCompletionOrigin("[bg completed] Lint (abc123)", null), true);
	assert.equal(isBackgroundCompletionOrigin("anything", "background-task-notification"), true);
	assert.equal(isBackgroundCompletionOrigin("anything", "subagent-notify"), true);
	assert.equal(isBackgroundCompletionOrigin("### DevSpec memory — auto-recall\ncards", "devspec-proactive"), false);
	assert.equal(isBackgroundCompletionOrigin("[DevSpec remote — bond context for X]\nYou are attached", "devspec-attach-context"), false);
	assert.equal(isBackgroundCompletionOrigin("typed text", null), false);

	// A context-injection wake cannot store speech even if the model talks.
	const recall = new TurnTracker();
	recall.userMessage("### DevSpec memory — auto-recall\nMechanically recalled", { customType: "devspec-proactive" });
	assert.equal(recall.userKind, "harness");
	assert.equal(recall.harnessSpeechAllowed, false);
	assert.equal(recall.assistantFinal("Looking good now, Ali.", true), "process");
	assert.deepEqual(planSettle(recall, true), { kind: "none" });
});

test("a completion arriving on an already-harness segment still resolves its task (759f2818 live)", () => {
	// Live 2026-09-17 (session ea7704f4): B2 completed while A2's wake turn
	// was still running. The second notification landed on the already-harness
	// tracker; the once-harness early return skipped resolution, leaking B2 —
	// every later settle saw pendingBg=1 and Working parked at a stuck timer
	// with everything finished.
	const shared = new Set<string>();
	const owner = new TurnTracker(shared);
	owner.userMessage("[DevSpec remote — message from Ali Price to Nimble Rabbit]\nrun the monitors");
	owner.noteBackgroundTask("pulse-a2");
	owner.noteBackgroundTask("watch-b2");
	const wake = new TurnTracker(shared);
	wake.userMessage("[bg completed] Presence pulse A2", { customType: "background-task-notification", backgroundTaskId: "pulse-a2" });
	assert.equal(wake.userKind, "harness");
	assert.deepEqual(wake.pendingBackgroundTasks(), ["watch-b2"]);
	wake.userMessage("[bg completed] Presence watch B2", { customType: "background-task-notification", backgroundTaskId: "watch-b2" });
	assert.deepEqual(wake.pendingBackgroundTasks(), [], "harness-on-harness completion resolves");
	assert.equal(wake.userKind, "harness", "still no remirror/no owner-kind theft");
});

test("leftover-only [bg completed] still posts no answer (56b9a3b4)", () => {
	const leftover = new TurnTracker();
	leftover.userMessage("[bg completed] Isolated typecheck", { customType: "background-task-notification" });
	leftover.assistantFinal("I'll wait for nothing — that receipt already passed.");
	assert.equal(leftover.userKind, "harness");
	assert.deepEqual(planSettle(leftover, true), { kind: "none" });
});

test("only typed automation-run envelopes have remote run identity", () => {
	const automation = {
		id: "run-1",
		kind: "automation_run",
		run_id: "run-1",
		automation_id: "automation-1",
		automation_name: "Deploy recovery",
		trigger_kind: "scheduled",
		owner: { user_id: "owner-1", display_name: "Ali Price" },
		permission: "can_commit",
		queued_at: "2026-08-20T12:00:00.000Z",
		delivery_connection_id: "conn-1",
		requester: null,
	};
	assert.equal(isAutomationRunEnvelope(automation), true);
	assert.equal(automationRunId(automation), "run-1");
	assert.equal(isAutomationRunEnvelope({ id: "legacy-envelope", members: [{ action_item_id: "item-1" }] }), false);
	assert.equal(automationRunId({ kind: "assignment", id: "legacy-envelope" }), undefined);
	assert.equal(automationRunId({ kind: "automation_run" }), undefined);
	assert.equal(isAutomationRunEnvelope({ ...automation, instruction: "old payload" }), false);
});

test("automation message has an automation-only model-visible envelope", () => {
	const value = {
		id: "run-1",
		kind: "automation_run",
		run_id: "run-1",
		automation_id: "automation-1",
		automation_name: "Deploy recovery",
		trigger_kind: "event",
		owner: { user_id: "owner-1", display_name: "Ali Price" },
		permission: "look_only",
		queued_at: "2026-08-20T12:00:00.000Z",
		delivery_connection_id: "conn-1",
		requester: null,
	};
	const message = formatAutomationRunMessage(value, "Wary Wolf");
	assert.match(message, /^\[DevSpec remote — automation run to Wary Wolf\]/);
	assert.match(message, /DevSpec automation run run-1 \(Deploy recovery\) is ready/);
	assert.match(message, /claim_automation_run/);
	assert.match(message, /Owner: Ali Price/);
	assert.match(message, /Automation run envelope:/);
	assert.doesNotMatch(message, /work dispatch|assignment|local_agent_dispatch|been dispatched/i);
	assert.doesNotMatch(message, /follow the supplied instruction/);
	assert.throws(
		() => formatAutomationRunMessage({ kind: "automation_run" }, "Wary Wolf"),
		/requires a run id/,
	);
});
