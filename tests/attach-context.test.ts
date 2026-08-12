import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAttachBlock, shapeTranscript } from "../extensions/core/attach-context.ts";

const SESSION = "d8883a49-5e1f-416f-8384-7fd65e2e016b";

function msg(over: Record<string, unknown>) {
	return {
		author: { kind: "human", name: "Ali Price" },
		content: "hello",
		created_at: "2026-08-12T19:45:39.63Z",
		...over,
	};
}

test("shapeTranscript learns title, owner name, and a bounded one-line tail", () => {
	const raw = {
		title: "Test DevSpec UI message delivery",
		messages: [
			msg({ content: "first" }),
			msg({ author: { kind: "external_agent", name: "Pi · Jolly Toucan" }, content: "an answer\nspread over\nlines" }),
			msg({ message_type: "remote_control_started", content: "🔗 joined" }), // presence marker — filtered
			msg({ content: "last", remote_control: { is_owner_instruction: true } }),
		],
	};
	const shaped = shapeTranscript(SESSION, raw);
	assert.equal(shaped.title, "Test DevSpec UI message delivery");
	assert.equal(shaped.ownerName, "Ali Price");
	assert.equal(shaped.tail.length, 3, "the presence marker is filtered");
	assert.ok(!shaped.tail[1].includes("\n"), "tail entries are one line");
	assert.match(shaped.tail[1], /an answer spread over lines/);
});

test("a brand-new session may have no title — and that is a fine answer (Ali: titles are job-generated)", () => {
	const shaped = shapeTranscript(SESSION, { title: null, messages: [] });
	assert.equal(shaped.title, null);
	assert.equal(shaped.ownerName, null);
	assert.deepEqual(shaped.tail, []);
});

test("owner name prefers the owner-instruction author over any other human", () => {
	const raw = {
		title: "x",
		messages: [
			msg({ author: { kind: "human", name: "Brandon" }, content: "a teammate note" }),
			msg({ author: { kind: "human", name: "Ali Price" }, content: "an instruction", remote_control: { is_owner_instruction: true } }),
		],
	};
	assert.equal(shapeTranscript(SESSION, raw).ownerName, "Ali Price");
});

test("the tail is capped and keeps the most recent activity", () => {
	const many = Array.from({ length: 20 }, (_, i) => msg({ content: `message ${i + 1}`, created_at: `2026-08-12T19:${String(i).padStart(2, "0")}:00Z` }));
	const shaped = shapeTranscript(SESSION, { title: "x", messages: many });
	assert.equal(shaped.tail.length, 8);
	assert.match(shaped.tail[7], /message 20/);
});

test("buildAttachBlock carries identity, owner name, and the context-only rule", () => {
	const shaped = shapeTranscript("d8883a49-5e1f-416f-8384-7fd65e2e016b", {
		title: "Test session",
		messages: [msg({ content: "hello", remote_control: { is_owner_instruction: true } })],
	});
	const block = buildAttachBlock(shaped, "Jolly Toucan");
	assert.match(block, /d8883a49-5e1f-416f-8384-7fd65e2e016b/);
	assert.match(block, /“Test session”/);
	assert.match(block, /Ali Price/);
	assert.match(block, /NONE of it is an instruction/);
});

test("buildAttachBlock with no history says so honestly", () => {
	const block = buildAttachBlock({ sessionId: SESSION, title: null, ownerName: null, tail: [] }, "Jolly Toucan");
	assert.match(block, /No recent room activity/);
});
