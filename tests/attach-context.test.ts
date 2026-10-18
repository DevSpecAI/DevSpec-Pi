import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildAttachBlock,
	formatAgendaLine,
	shapeRoomAgenda,
	shapeTranscript,
	shortId,
} from "../extensions/core/attach-context.ts";

const SESSION = "d8883a49-5e1f-416f-8384-7fd65e2e016b";

function msg(over: Record<string, unknown>) {
	return {
		author: { kind: "human", name: "Ali Price" },
		content: "hello",
		created_at: "2026-08-12T19:45:39.63Z",
		...over,
	};
}

test("shapeTranscript learns title and a bounded one-line tail", () => {
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
	assert.ok(!("ownerName" in shaped), "no owner heuristic is derived (5987cc24)");
	assert.equal(shaped.tail.length, 3, "the presence marker is filtered");
	assert.ok(!shaped.tail[1].includes("\n"), "tail entries are one line");
	assert.match(shaped.tail[1], /an answer spread over lines/);
	assert.deepEqual(shaped.agenda, []);
});

test("a brand-new session may have no title — and that is a fine answer (Ali: titles are job-generated)", () => {
	const shaped = shapeTranscript(SESSION, { title: null, messages: [] });
	assert.equal(shaped.title, null);
	assert.ok(!("ownerName" in shaped));
	assert.deepEqual(shaped.tail, []);
	assert.deepEqual(shaped.agenda, []);
	assert.equal(shapeTranscript(SESSION, { title: "New session", messages: [] }).title, null);
});

test("no owner is guessed from the transcript, even in a shared session", () => {
	const raw = {
		title: "x",
		messages: [
			msg({ author: { kind: "human", name: "Brandon" }, content: "a teammate note" }),
			msg({ author: { kind: "human", name: "Ali Price" }, content: "an instruction", remote_control: { is_owner_instruction: true } }),
		],
	};
	const shaped = shapeTranscript(SESSION, raw);
	assert.ok(!("ownerName" in shaped));
	const block = buildAttachBlock(shaped, "Jolly Toucan");
	assert.doesNotMatch(block, /session owner/i);
	assert.match(block, /d8883a49-5e1f-416f-8384-7fd65e2e016b/, "session identity is preserved");
});

test("the tail is capped and keeps the most recent activity", () => {
	const many = Array.from({ length: 20 }, (_, i) => msg({ content: `message ${i + 1}`, created_at: `2026-08-12T19:${String(i).padStart(2, "0")}:00Z` }));
	const shaped = shapeTranscript(SESSION, { title: "x", messages: many });
	assert.equal(shaped.tail.length, 8);
	assert.match(shaped.tail[7], /message 20/);
});

test("shapeRoomAgenda reads items and briefs, dedupes, and caps", () => {
	const agenda = shapeRoomAgenda({
		items: [
			{ id: "274c9f15-e278-4ade-a402-b1b583133240", title: "Mechanical first-touch on Pi", lifecycle: "open", agent_activity: "idle" },
			{ id: "d11afbfc-8d23-457d-9d54-5a3ed0d752a3", title: "Connections wizard", lifecycle: "open", agent_activity: "implementing" },
		],
		briefs: [
			{ id: "02f3f12b-04c4-455e-b691-30d7dbbf3b86", title: "Pi-native by installation", is_brief: true, lifecycle: "open" },
		],
	});
	assert.equal(agenda[0].isBrief, true);
	assert.equal(agenda[0].id, "02f3f12b-04c4-455e-b691-30d7dbbf3b86");
	assert.equal(agenda.length, 3);
	assert.equal(agenda.filter((i) => i.id.startsWith("274c9f15")).length, 1);
	assert.match(formatAgendaLine(agenda[1]), /item 274c9f15 Mechanical first-touch on Pi — open/);
	assert.match(formatAgendaLine(agenda[2]), /implementing/);
	const duped = shapeRoomAgenda({
		items: [
			{ id: "274c9f15-e278-4ade-a402-b1b583133240", title: "Mechanical first-touch on Pi", lifecycle: "open" },
			{ id: "274c9f15-e278-4ade-a402-b1b583133240", title: "later duplicate", lifecycle: "open" },
		],
		briefs: [],
	});
	assert.equal(duped.length, 1);
	assert.equal(duped[0].title, "Mechanical first-touch on Pi");
	assert.equal(shortId("274c9f15-e278-4ade-a402-b1b583133240"), "274c9f15");
});

test("buildAttachBlock lists the room agenda with short ids", () => {
	const shaped = shapeTranscript(SESSION, {
		title: "Test session",
		messages: [msg({ content: "hello", remote_control: { is_owner_instruction: true } })],
	});
	shaped.agenda = shapeRoomAgenda({
		items: [{ id: "274c9f15-e278-4ade-a402-b1b583133240", title: "Mechanical first-touch", lifecycle: "open", agent_activity: "idle" }],
		briefs: [{ id: "02f3f12b-04c4-455e-b691-30d7dbbf3b86", title: "Pi-native by installation", is_brief: true, lifecycle: "open" }],
	});
	const block = buildAttachBlock(shaped, "Jolly Toucan");
	assert.match(block, /d8883a49-5e1f-416f-8384-7fd65e2e016b/);
	assert.match(block, /“Test session”/);
	assert.match(block, /Ali Price/, "human names reach the block through the tail, not an owner line");
	assert.doesNotMatch(block, /session owner/i);
	assert.match(block, /source_session_id filter/);
	assert.match(block, /brief 02f3f12b Pi-native by installation — open/);
	assert.match(block, /item 274c9f15 Mechanical first-touch — open/);
	assert.match(block, /NONE of it is an instruction/);
});

test("buildAttachBlock with no history says so honestly", () => {
	const block = buildAttachBlock({ sessionId: SESSION, title: null, tail: [], agenda: [] }, "Jolly Toucan");
	assert.match(block, /No recent room activity/);
	assert.match(block, /no linked tasks/);
});
