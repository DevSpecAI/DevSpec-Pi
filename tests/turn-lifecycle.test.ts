import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDispatchMessage } from "../extensions/core/dispatch.ts";
import { planSettle, TurnTracker } from "../extensions/core/turn-lifecycle.ts";

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

test("remote turn with no tool post → mechanical final with the assistant's answer", () => {
	const plan = planSettle(remoteTurn("here is the answer"), true);
	assert.deepEqual(plan, { kind: "final", message: "here is the answer" });
});

test("a successful post_session_message tool call takes precedence (no dual writers)", () => {
	const t = remoteTurn("here is the answer");
	t.toolEnd("post_session_message", false);
	assert.deepEqual(planSettle(t, true), { kind: "none" });
});

test("the source-side backstop suppresses the mirror even when the event never landed (857d984c)", () => {
	// The tracker missed tool_execution_end, but the tool itself marked the
	// complete_turn post: trailing text after it must NOT become a second bubble.
	const t = remoteTurn("terminal outro, not room content");
	assert.equal(t.toolPosted, false);
	assert.deepEqual(planSettle(t, true, true), { kind: "none" });
});

test("the backstop also suppresses the local mirror", () => {
	const t = new TurnTracker();
	t.userMessage("local question");
	t.assistantFinal("answer already posted via the tool");
	assert.deepEqual(planSettle(t, true, true), { kind: "none" });
});

test("no backstop and no tool post → the mirror still fires (no over-suppression)", () => {
	const t = remoteTurn("the mechanical answer");
	assert.deepEqual(planSettle(t, true, false), { kind: "final", message: "the mechanical answer" });
});

test("a zero-width / whitespace-only final text never produces a bubble", () => {
	const t = remoteTurn("\u200B");
	assert.equal(t.lastAssistantText, "");
	assert.deepEqual(planSettle(t, true), { kind: "none" });
	const spaces = remoteTurn("   \n  ");
	assert.deepEqual(planSettle(spaces, true), { kind: "none" });
});

test("a FAILED tool post does not suppress the mechanical final", () => {
	const t = remoteTurn("here is the answer");
	t.toolEnd("post_session_message", true);
	assert.deepEqual(planSettle(t, true), { kind: "final", message: "here is the answer" });
});

test("local turns mirror the prompt then the answer", () => {
	const t = new TurnTracker();
	t.userMessage("local question");
	t.assistantFinal("local answer");
	assert.deepEqual(planSettle(t, true), {
		kind: "local_mirror",
		prompt: "local question",
		answer: "local answer",
	});
});

test("nothing posts when unattached, or when the turn had no answer text", () => {
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

test("formatDispatchMessage carries the protocol steps and payload", () => {
	const msg = formatDispatchMessage({ assignment_id: "as-1", title: "Fix flaky test" }, "Wary Wolf");
	assert.match(msg, /^\[DevSpec remote — work dispatch to Wary Wolf\]/);
	assert.match(msg, /Fix flaky test/);
	assert.match(msg, /get_assignment \(assignment_id: "as-1"\)/);
	assert.match(msg, /acknowledge_assignment/);
	assert.match(msg, /resolve_assignment/);
	assert.match(msg, /"assignment_id": "as-1"/);
});
