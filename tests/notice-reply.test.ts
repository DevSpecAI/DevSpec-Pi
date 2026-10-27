import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	advertisesNoticeReply,
	noticeIdsFromDelivery,
	noticeReplyFinalText,
	noticeReplyTerminalMessage,
	parseNoticeReplySnapshot,
	postNoticeReply,
	type NoticeReplyCallResult,
	type NoticeReplyCapture,
} from "../extensions/core/notice-reply.ts";
import { formatSystemNoticeMessage } from "../extensions/core/system-notice.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { openRoomStore, roomPrincipalFingerprint } from "../extensions/core/room-store.ts";
import { readLocalRoom } from "../extensions/core/room-reader.ts";
import { RoomSync } from "../extensions/core/room-sync.ts";
import { IDS, TEST_CONNECTION, systemNotice } from "./canonical-ingress-fixture.ts";
import { roomPoll } from "./room-context-fixture.ts";

// DevSpec item 6aad2b46: a notice-woken run's final message is posted into the room
// as a reply to that notice, and the room copy keeps what such a row answers.

const OTHER = "18181818-1818-4181-8181-181818181818";
const ROOM = "19191919-1919-4191-8191-191919191919";
const envelope = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const stored = (ids: string[], overrides: Record<string, unknown> = {}) => envelope({
	delivery: { status: "stored", message_id: "m1" }, message_id: "m1", session_id: ROOM, connection_id: IDS.connection, sort_key: 7,
	message_type: "external_agent", phase: "answer", notice_reply: { notice_ids: [...ids].sort() }, turn_effect: "none", complete_turn: false, ...overrides,
});
const refusal = (reason: string, error: string) => JSON.stringify({ delivery: { status: "rejected", reason, retryable: false }, error });
const capture = (overrides: Partial<NoticeReplyCapture> = {}): NoticeReplyCapture => ({
	connectionId: IDS.connection, noticeIds: [IDS.notice], roomPromised: true, finalText: "Your duplicate is closed.", ...overrides,
});
const attached = () => ({ connectionId: IDS.connection, sessionId: ROOM });
const snapshot = () => ({
	version: 1,
	notices: [{ notice_id: IDS.notice, kind: "server_notice", topic: "coherence_finding", notice_type: "duplicate", summary: "Confirmed duplicate", records: [{ label: "Duplicate record", record_type: "task", record_id: IDS.project, title: "B", url: "/projects/p/tasks?view=task%3Ar1" }] }],
});

function scripted(results: Array<NoticeReplyCallResult | Error>) {
	const sent: Record<string, unknown>[] = [];
	return { sent, call: async (args: Record<string, unknown>) => {
		sent.push(args);
		const next = results[sent.length - 1];
		if (!next) throw new Error("unexpected extra call");
		if (next instanceof Error) throw next;
		return next;
	} };
}

test("a stored reply names exactly its notices and carries nothing that could bind a command, turn or attempt", async () => {
	const wire = scripted([{ raw: stored([IDS.notice]) }]);
	const outcome = await postNoticeReply({ capture: capture(), current: attached, call: wire.call, extraArgs: { agent_name: "Pi", model: { providerID: "p", modelID: "m" }, connection_id: "spoofed", system_notice_ids: [] } });
	assert.deepEqual(outcome, { kind: "posted", messageId: "m1", sessionId: ROOM, idempotent: false });
	assert.deepEqual(wire.sent, [{ agent_name: "Pi", model: { providerID: "p", modelID: "m" }, connection_id: IDS.connection, message: "Your duplicate is closed.", system_notice_ids: [IDS.notice] }]);
	assert.equal(noticeReplyTerminalMessage(outcome, capture()), null, "a reply that landed needs no terminal note");
	const again = scripted([{ raw: stored([IDS.notice], { delivery: { status: "idempotently_stored", message_id: "m1" } }) }]);
	assert.deepEqual(await postNoticeReply({ capture: capture(), current: attached, call: again.call }), { kind: "posted", messageId: "m1", sessionId: ROOM, idempotent: true });
});

test("a receipt that does not prove this exact reply is reported as unconfirmed, never as posted", async () => {
	for (const overrides of [{ turn_effect: undefined }, { notice_reply: { notice_ids: [OTHER] } }, { connection_id: OTHER }, { phase: "trail" }, { delivery: { status: "stored", message_id: "other" } }]) {
		const wire = scripted([{ raw: stored([IDS.notice], overrides) }]);
		const outcome = await postNoticeReply({ capture: capture(), current: attached, call: wire.call });
		assert.equal(outcome.kind, "unconfirmed", JSON.stringify(overrides));
		assert.match(noticeReplyTerminalMessage(outcome, capture())!, /may not have reached the room/);
	}
	// The server canonicalises (sorts, lower-cases) the ids it names back.
	const two = scripted([{ raw: stored([OTHER, IDS.notice]) }]);
	assert.equal((await postNoticeReply({ capture: capture({ noticeIds: [OTHER.toUpperCase(), IDS.notice] }), current: attached, call: two.call })).kind, "posted");
});

test("a refusal reaches the terminal with DevSpec's own reason, including a connection with no room", async () => {
	const words = `Nothing was posted. A reply can name only notices DevSpec delivered to this connection. ${IDS.notice}: DevSpec did not deliver this notice to this connection in this project.`;
	const refused = await postNoticeReply({ capture: capture(), current: attached, call: scripted([{ refusal: refusal("notice_refused", words) }]).call });
	assert.deepEqual(refused, { kind: "refused", reason: "notice_refused", detail: words });
	assert.equal(noticeReplyTerminalMessage(refused, capture()), `DevSpec: The reply to the DevSpec notice was not posted to the room (notice_refused). ${words}`);
	const noRoom = "Your connection is not attached to a room, so there is nowhere to post this reply. Nothing was posted: tell the person at your terminal instead.";
	const detached = await postNoticeReply({ capture: capture(), current: attached, call: scripted([{ refusal: refusal("not_attached", noRoom) }]).call });
	assert.match(noticeReplyTerminalMessage(detached, capture())!, new RegExp(`\\(not_attached\\)\\. ${noRoom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	// A refusal before anything was read is plain text; it is still shown verbatim.
	const plain = await postNoticeReply({ capture: capture({ noticeIds: [IDS.notice, OTHER] }), current: attached, call: scripted([{ refusal: "system_notice_ids requires connection_id." }]).call });
	assert.equal(noticeReplyTerminalMessage(plain, capture({ noticeIds: [IDS.notice, OTHER] })), "DevSpec: The reply to 2 DevSpec notices was not posted to the room (refused). system_notice_ids requires connection_id.");
});

test("a room change mid-post is sent once more, because DevSpec stores the same notices and text once", async () => {
	const wire = scripted([{ refusal: refusal("room_changed", "Your connection moved to another room while this reply was being posted. Nothing was posted; send it again.") }, { raw: stored([IDS.notice]) }]);
	assert.equal((await postNoticeReply({ capture: capture(), current: attached, call: wire.call })).kind, "posted");
	assert.equal(wire.sent.length, 2);
	assert.deepEqual(wire.sent[0], wire.sent[1], "the identical reply, never a variant");
	const twice = scripted([{ refusal: refusal("room_changed", "moved") }, { refusal: refusal("room_changed", "moved again") }]);
	assert.deepEqual(await postNoticeReply({ capture: capture(), current: attached, call: twice.call }), { kind: "refused", reason: "room_changed", detail: "moved again" });
});

test("no final text, no room or a different connection posts nothing; only a broken promise is said", async () => {
	const never = scripted([]);
	assert.deepEqual(await postNoticeReply({ capture: capture({ finalText: null }), current: attached, call: never.call }), { kind: "no_final_text" });
	const unattached = await postNoticeReply({ capture: capture(), current: () => ({ connectionId: IDS.connection, sessionId: null }), call: never.call });
	assert.deepEqual(unattached, { kind: "not_attached" });
	assert.equal(noticeReplyTerminalMessage(unattached, capture({ roomPromised: false })), null, "told at delivery that it stays in the terminal");
	assert.match(noticeReplyTerminalMessage(unattached, capture())!, /no longer attached to a room\. It stays here in the terminal\./);
	for (const current of [() => null, () => ({ connectionId: OTHER, sessionId: ROOM })]) {
		const changed = await postNoticeReply({ capture: capture(), current, call: never.call });
		assert.deepEqual(changed, { kind: "connection_changed" });
		assert.match(noticeReplyTerminalMessage(changed, capture())!, /connection changed during the run/);
	}
	assert.equal(never.sent.length, 0);
	const lost = await postNoticeReply({ capture: capture(), current: attached, call: scripted([new Error("Cannot reach DevSpec (fetch failed)")]).call });
	assert.deepEqual(lost, { kind: "unconfirmed", detail: "Cannot reach DevSpec (fetch failed)" });
});

test("the final reply is the run's last message, only when the model finished it", () => {
	assert.equal(noticeReplyFinalText({ text: "Told them.", stopReason: "stop" }), "Told them.");
	assert.equal(noticeReplyFinalText({ text: "Cut short", stopReason: "length" }), "Cut short");
	for (const stopReason of ["toolUse", "error", "aborted", null, undefined]) assert.equal(noticeReplyFinalText({ text: "partial", stopReason }), null, String(stopReason));
	assert.equal(noticeReplyFinalText({ text: " \n​", stopReason: "stop" }), null);
	assert.deepEqual(noticeIdsFromDelivery({ notices: [{ notice_id: IDS.notice }, { notice_id: IDS.notice }, { notice_id: "not-an-id" }, { notice_id: OTHER }], roomAttached: true }), [IDS.notice, OTHER]);
	assert.deepEqual(noticeIdsFromDelivery(undefined), []);
});

test("the notice framing says where the final message goes", () => {
	const notice = systemNotice();
	assert.match(formatSystemNoticeMessage([notice as never], { roomAttached: true }), /Your final message at the end of this run is posted to your DevSpec room as your reply to this notice; people there see it marked as a reply to a DevSpec notice, not to a person\. Write it to the person, briefly, as the notice's prompt asks, and say only what they need\./);
	assert.match(formatSystemNoticeMessage([notice as never], { roomAttached: false }), /You are not attached to a DevSpec room, so your final message stays in this terminal\./);
	assert.doesNotMatch(formatSystemNoticeMessage([notice as never]), /posted to your DevSpec room/);
});

test("the snapshot reads exactly what the server's schema accepts", () => {
	assert.deepEqual(parseNoticeReplySnapshot(snapshot()), snapshot());
	const empty = { ...snapshot(), notices: [{ ...snapshot().notices[0], summary: "", topic: "", records: [{ label: "", record_type: "", record_id: "", title: "", url: null }] }] };
	assert.deepEqual(parseNoticeReplySnapshot(empty), empty, "z.string() accepts empty strings");
	const many = { version: 1, notices: Array.from({ length: 25 }, () => snapshot().notices[0]) };
	assert.equal(parseNoticeReplySnapshot(many)?.notices.length, 25);
	const refused = [
		{ ...snapshot(), version: 2 },
		{ ...snapshot(), notices: [] },
		{ ...snapshot(), notices: [...many.notices, snapshot().notices[0]] },
		{ ...snapshot(), extra: true },
		{ ...snapshot(), notices: [{ ...snapshot().notices[0], prompt: "Tell the person." }] },
		{ ...snapshot(), notices: [{ ...snapshot().notices[0], notice_id: "17171717-1717-0171-8171-171717171717" }] },
		{ ...snapshot(), notices: [{ ...snapshot().notices[0], kind: "unreadable" }] },
		{ ...snapshot(), notices: [{ ...snapshot().notices[0], records: [{ ...snapshot().notices[0]!.records[0], text: "t" }] }] },
		{ ...snapshot(), notices: [{ ...snapshot().notices[0], records: [{ ...snapshot().notices[0]!.records[0], url: 7 }] }] },
		{ version: 1 },
		null,
	];
	for (const value of refused) assert.equal(parseNoticeReplySnapshot(value), null, JSON.stringify(value));
});

test("the room lane asks for snapshots only when the served contract advertises them", () => {
	const contract = { kind: "devspec.product.remote_ingress_contract", schema_version: 1, contract_version: "1.6.0", policy: { policy_version: "2026-09-24.1" }, activation: { room_context_negotiation_argument: "room_context_version", room_context_contract_requires: { ingress_version: 1, delegated_scope_version: 1, active_plan_projection_version: 1, system_notice_version: 1, sender_style_version: 1, room_context_version: 1 }, notice_reply_negotiation_argument: "notice_reply_version", notice_reply_requires: { room_context_version: 1, notice_reply_version: 1 } } };
	const served = (value: unknown) => ({ contents: [{ text: JSON.stringify(value) }] });
	assert.equal(advertisesNoticeReply(served(contract)), true);
	const { notice_reply_negotiation_argument: _a, notice_reply_requires: _b, ...older } = contract.activation;
	assert.equal(advertisesNoticeReply(served({ ...contract, activation: older })), false);
	assert.equal(advertisesNoticeReply(served({ ...contract, contract_version: "1.5.0" })), false);
	assert.equal(advertisesNoticeReply(null), false);
});

function replyRoomPoll(noticeReply: unknown) {
	const p = roomPoll();
	const row = p.ingress.room_context.messages.find((m) => m.message_id === IDS.agentContext)! as Record<string, unknown>;
	row.notice_reply = noticeReply;
	return p;
}
const lane = { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true };

test("a negotiated snapshot is kept on its row; without the opt-in it is refused like any unknown field", () => {
	const parsed = parsePollPayload(replyRoomPoll(snapshot()), TEST_CONNECTION, { ...lane, noticeReplyNegotiated: true });
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	assert.deepEqual(parsed.roomPage?.room.messages.find((m) => m.message_id === IDS.agentContext)?.notice_reply, snapshot());
	assert(parsed.ownerBundle, "the command in the same envelope is delivered");
	assert.equal(parsePollPayload(replyRoomPoll(snapshot()), TEST_CONNECTION, lane).canonicalState, "invalid");
});

test("a snapshot DevSpec's schema would refuse costs only that row's snapshot, says so once, and never the command", () => {
	const parsed = parsePollPayload(replyRoomPoll({ ...snapshot(), notices: [] }), TEST_CONNECTION, { ...lane, noticeReplyNegotiated: true });
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	assert(parsed.ownerBundle);
	assert.equal(parsed.roomPage?.room.messages.find((m) => m.message_id === IDS.agentContext)?.notice_reply, undefined);
	assert.deepEqual(parsed.advisoryRejections, ["notice_reply"]);
});

test("the room copy keeps a reply's snapshot, hands it over with the unread message, and drops it from a tombstone", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notice-reply-"));
	const fp = roomPrincipalFingerprint("fixture-token");
	const scope = { endpoint: "https://fixture.invalid", projectId: IDS.project, nativeSessionId: IDS.owner, connectionId: IDS.connection, sessionId: ROOM, attachmentId: IDS.step };
	const store = await openRoomStore(scope, { root, principalFingerprint: fp });
	try {
		store.apply(parsePollPayload(replyRoomPoll(snapshot()), TEST_CONNECTION, { ...lane, noticeReplyNegotiated: true }));
		const unread = await readLocalRoom(scope, fp, { view: "unread" }, { root }) as { messages: Array<Record<string, unknown>> };
		const row = unread.messages.find((m) => m.message_id === IDS.agentContext);
		assert.deepEqual(row?.notice_reply, snapshot());
		assert.equal(unread.messages.filter((m) => m.notice_reply).length, 1, "only the reply row carries one");
		// A later page that does not describe it (no opt-in, an open_check answer) keeps it.
		store.apply(parsePollPayload(roomPoll(), TEST_CONNECTION, lane));
		const message = await readLocalRoom(scope, fp, { view: "message", message_id: IDS.agentContext }, { root }) as { value: Record<string, unknown> };
		assert.deepEqual(message.value.notice_reply, snapshot());
		const deleted = replyRoomPoll(snapshot());
		deleted.ingress.room_context.messages.find((m) => m.message_id === IDS.agentContext)!.state = "deleted";
		deleted.ingress.room_context.coverage!.deleted_count = 1;
		store.apply(parsePollPayload(deleted, TEST_CONNECTION, { ...lane, noticeReplyNegotiated: true }));
		const tombstone = await readLocalRoom(scope, fp, { view: "message", message_id: IDS.agentContext }, { root }) as { value: Record<string, unknown> };
		assert.equal(tombstone.value.state, "deleted");
		assert.equal(Object.hasOwn(tombstone.value, "notice_reply"), false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("history recovery asks for the snapshot only when the copy negotiated it", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-notice-reply-sync-"));
	const scope = { endpoint: "https://fixture.invalid", projectId: IDS.project, nativeSessionId: IDS.owner, connectionId: IDS.connection, sessionId: ROOM, attachmentId: IDS.step };
	const store = await openRoomStore(scope, { root });
	try {
		for (const noticeReplyNegotiated of [true, false]) {
			const calls: Record<string, unknown>[] = [];
			const sync = new RoomSync({ store, noticeReplyNegotiated, current: () => true, liveCursor: () => "cursor", intervalMs: 60_000, fetchHistory: async (args) => { calls.push(args); throw new Error("stop after the request"); }, wake: () => {}, onError: () => {} });
			await sync.repairOnce();
			assert.equal(calls[0]?.notice_reply_version, noticeReplyNegotiated ? 1 : undefined);
			assert.deepEqual(sync.negotiationWatch(), noticeReplyNegotiated ? { notice_reply_version: 1 } : {});
		}
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
