import assert from "node:assert/strict";
import { test } from "node:test";
import { shapeTranscript } from "../extensions/core/attach-context.ts";

const SESSION = "d8883a49-5e1f-416f-8384-7fd65e2e016b";

test("shapeTranscript learns the room's real title and nothing else", () => {
	const raw = {
		title: "Test DevSpec UI message delivery",
		messages: [{ author: { kind: "human", name: "Ali Price" }, content: "an instruction", remote_control: { is_owner_instruction: true } }],
	};
	assert.deepEqual(shapeTranscript(SESSION, raw), { sessionId: SESSION, title: "Test DevSpec UI message delivery" });
});

test("a brand-new session may have no title — and that is a fine answer (Ali: titles are job-generated)", () => {
	assert.equal(shapeTranscript(SESSION, { title: null, messages: [] }).title, null);
	assert.equal(shapeTranscript(SESSION, { title: "New session", messages: [] }).title, null);
	assert.equal(shapeTranscript(SESSION, null).title, null);
});
