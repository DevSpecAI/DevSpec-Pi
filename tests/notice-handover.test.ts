/**
 * The reply to a notice steered into a person's running turn (DevSpec item
 * da5cfae5): the host tool the agent hands it over with, and what the agent is
 * told DevSpec did with it. How the hand-over is posted, and what happens when
 * nothing is handed over, is in run-voice.test.ts against the real writers.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerDevspecTools from "../extensions/devspec-tools.ts";
import { setBond } from "../extensions/core/bond-state.ts";
import {
	NO_NOTICE_WAITING,
	NOTICE_REPLY_TOOL,
	NOTICE_REPLY_TOOL_DESCRIPTION,
	UNANSWERED_NOTICE_LINE,
	handOverNoticeReply,
	installNoticeHandover,
	noticeHandoverResult,
	withNoticeReplyToolActive,
} from "../extensions/core/notice-handover.ts";

afterEach(() => installNoticeHandover(null));

function registeredTool() {
	const definitions: any[] = [];
	const pi = {
		registerTool(def: any) { definitions.push(def); },
		on() {},
		getActiveTools: () => [],
		setActiveTools() {},
	} as unknown as ExtensionAPI;
	setBond(null);
	registerDevspecTools(pi);
	return definitions.find((def) => def.name === NOTICE_REPLY_TOOL);
}
const textOf = (result: { content: Array<{ text: string }> }) => result.content.map((block) => block.text).join("\n");

test("the tool hands the agent's words to the running turn and returns what DevSpec did with them", async () => {
	const tool = registeredTool();
	assert.ok(tool, "registered as a host tool");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["message"], "the agent passes its words and nothing else: Pi knows the notices");
	const handed: string[] = [];
	installNoticeHandover(async (message) => { handed.push(message); return { ok: true, text: "Posted to your room as your reply to the DevSpec notice." }; });
	const result = await tool.execute("call-1", { message: "  Your task clashes with Sam's decision.  " });
	assert.deepEqual(handed, ["Your task clashes with Sam's decision."]);
	assert.equal(textOf(result), "Posted to your room as your reply to the DevSpec notice.");
	// A reply that did not get through reaches the agent as an error, in DevSpec's own words.
	installNoticeHandover(async () => ({ ok: false, text: "DevSpec did not post the reply (room_changed). Refused." }));
	assert.equal(textOf(await tool.execute("call-2", { message: "Again." })), "Error: DevSpec did not post the reply (room_changed). Refused.");
});

test("with nothing to hand over to, or nothing said, the tool posts nothing", async () => {
	assert.deepEqual(await handOverNoticeReply("Your task clashes."), { ok: false, text: NO_NOTICE_WAITING });
	let called = 0;
	installNoticeHandover(async () => { called += 1; return { ok: true, text: "posted" }; });
	for (const empty of ["", "   ", undefined, 7, null]) {
		const result = await handOverNoticeReply(empty);
		assert.equal(result.ok, false);
		assert.match(result.text, /^Pass message/);
	}
	assert.equal(called, 0);
});

test("the tool is shown and hidden without disturbing the other tools", () => {
	assert.deepEqual(withNoticeReplyToolActive(["read", "get_task"], true), ["read", "get_task", NOTICE_REPLY_TOOL]);
	assert.deepEqual(withNoticeReplyToolActive(["read", NOTICE_REPLY_TOOL, "get_task"], true), ["read", "get_task", NOTICE_REPLY_TOOL], "never twice");
	assert.deepEqual(withNoticeReplyToolActive(["read", NOTICE_REPLY_TOOL, "get_task"], false), ["read", "get_task"]);
	assert.deepEqual(withNoticeReplyToolActive(["read"], false), ["read"]);
});

test("the agent is told what DevSpec did, and when DevSpec has decided nothing more is posted", () => {
	const posted = noticeHandoverResult({ kind: "posted", messageId: "row", sessionId: "room", idempotent: false });
	assert.deepEqual({ ok: posted.ok, done: posted.done }, { ok: true, done: true });
	const settled = noticeHandoverResult({ kind: "settled_housekeeping", housekeepingMessageId: "hk" });
	assert.deepEqual({ ok: settled.ok, done: settled.done }, { ok: true, done: true });
	assert.match(settled.text, /DevSpec posted no message/);
	const record = noticeHandoverResult({ kind: "for_the_record" });
	assert.deepEqual({ ok: record.ok, done: record.done }, { ok: true, done: true });
	// Each of the three tells the agent to keep it out of its own messages.
	for (const result of [posted, settled, record]) assert.match(result.text, /Say nothing about these notices in your own messages\.$/);
	const refused = noticeHandoverResult({ kind: "refused", reason: "not_delivered_to_connection", detail: "DevSpec did not deliver this notice to this connection." });
	assert.deepEqual(refused, { ok: false, done: true, text: "DevSpec did not post the reply (not_delivered_to_connection). DevSpec did not deliver this notice to this connection." });
	// Not decided: the notices stay waiting, and the end of the turn reports them.
	for (const outcome of [{ kind: "unconfirmed", detail: "socket hang up" }, { kind: "not_attached" }, { kind: "connection_changed" }, { kind: "no_final_text" }] as const) {
		const result = noticeHandoverResult(outcome);
		assert.deepEqual({ ok: result.ok, done: result.done }, { ok: false, done: false }, outcome.kind);
	}
});

test("the tool's description points at the served contract for what the room is shown, and the stand-in line is plain words", () => {
	assert.match(NOTICE_REPLY_TOOL_DESCRIPTION, /semantics\.notice_audience and semantics\.notice_reply in devspec:\/\/product\/remote-ingress-contract/);
	// The served rule on when a room hears of a notice is not restated here.
	assert.doesNotMatch(NOTICE_REPLY_TOOL_DESCRIPTION, /unresolved choice|hold, rejection|for the record|housekeeping/);
	// What the room may show under DevSpec's card names no internals (semantics.notice_reply.words).
	assert.doesNotMatch(UNANSWERED_NOTICE_LINE, /notice|DevSpec|check|id\b|tool/i);
});
