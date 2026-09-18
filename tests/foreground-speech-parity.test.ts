import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnTracker, shouldSplitSpeech } from "../extensions/core/turn-lifecycle.ts";

// Exact assistant JSONL entry aa8920bd, 2026-09-17T20:04:38.653Z.
const opener = "Task A's wake under the new build. Reading its output and checking the server-side Working state through the gap (the core variant-1 assertion), with B still running:";

for (const text of [opener, "I’ll wait for the build.", "The verification failed; no further action is safe until the failure is fixed."]) {
	test(`foreground speech is not classified by its wording: ${text.slice(0, 36)}`, () => {
		const tracker = new TurnTracker();
		tracker.userMessage("<background-task-notification><status>completed</status></background-task-notification>", { customType: "background-task-notification" });
		tracker.noteBackgroundTask("still-running");
		assert.equal(tracker.assistantFinal(text, true), "stored");
		assert.equal(tracker.lastAssistantText, text);
		assert.equal(shouldSplitSpeech(tracker, { text, hasToolCalls: true }), true);
		assert.deepEqual(tracker.pendingBackgroundTasks(), ["still-running"]);
	});
}

test("accepted speech preserves whitespace and Unicode, not an admission-normalized copy", () => {
	const tracker = new TurnTracker();
	tracker.userMessage("[DevSpec remote — message from Ali] Continue");
	const text = "  Indented code:\n    print('👩‍💻')\n\n";
	assert.equal(tracker.assistantFinal(text, true), "stored");
	assert.equal(tracker.lastAssistantText, text);
});

test("invisible-only assistant text is not speech", () => {
	const tracker = new TurnTracker();
	assert.equal(tracker.assistantFinal(" \u2060\u00ad\u200d\ufe0f\n", true), "empty");
	assert.equal(tracker.lastAssistantText, "");
});
