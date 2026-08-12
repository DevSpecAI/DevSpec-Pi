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

test("formatDispatchMessage carries the protocol steps and payload", () => {
	const msg = formatDispatchMessage({ assignment_id: "as-1", title: "Fix flaky test" }, "Wary Wolf");
	assert.match(msg, /^\[DevSpec remote — work dispatch to Wary Wolf\]/);
	assert.match(msg, /Fix flaky test/);
	assert.match(msg, /get_assignment \(assignment_id: "as-1"\)/);
	assert.match(msg, /acknowledge_assignment/);
	assert.match(msg, /resolve_assignment/);
	assert.match(msg, /"assignment_id": "as-1"/);
});
