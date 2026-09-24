import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalPoll, IDS, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { advertisesRoomContext, parseActivityIndex } from "../extensions/core/room-context.ts";

import { roomPoll } from "./room-context-fixture.ts";
const options = { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true };

test("1.6 retains full exact command authority and actor-labelled record data separately", () => {
	const p = roomPoll({ body: "full command ".repeat(500) });
	const parsed = parsePollPayload(p, TEST_CONNECTION, options);
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	assert.equal(parsed.ownerBundle?.primaryCommand.text, "full command ".repeat(500));
	assert(parsed.ownerBundle?.primaryCommand.delivery.provenance_ref);
	assert.equal(parsed.roomPage?.records.length, p.ingress.window.returned);
	assert.equal(JSON.stringify(parsed.roomPage?.records).includes("provenance_ref"), false);
	assert.equal(JSON.stringify(parsed.roomPage?.records).includes("authority"), false);
});

test("metadata references for another agent survive without file hydration", () => {
	const p = roomPoll(); const m = p.ingress.room_context.messages.find(m => m.message_id === IDS.agentContext)!;
	m.addressee = { kind: "connection", connection_id: IDS.otherConnection, label: "Other agent" } as typeof m.addressee;
	m.attachments = [{ materialization: "metadata", filename: "old.png", mime_type: "image/png", type: "image", size_bytes: 12, resource_id: IDS.resource }];
	const parsed = parsePollPayload(p, TEST_CONNECTION, options);
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	assert.equal(parsed.roomPage?.room.messages.find(m => m.message_id === IDS.agentContext)?.attachments[0]?.resource_id, IDS.resource);
});

test("history and ambient room data cannot become a command", () => {
	for (const p of [roomPoll({ wakeKind: "history_reseed", deliveryState: "replay" }), roomPoll({ wakeKind: "advisory_update" })]) {
		const parsed = parsePollPayload(p, TEST_CONNECTION, options);
		assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
		assert.equal(parsed.ownerBundle, undefined); assert.equal(parsed.control, undefined);
		assert(parsed.roomPage);
	}
});

test("preserved1.3/1.4/1.5 lanes do not depend on room storage", () => {
	for (const [notices, style] of [[false, false], [true, false], [true, true]]) {
		const p = canonicalPoll({ systemNoticeNegotiated: notices, senderStyleNegotiated: style });
		const parsed = parsePollPayload(p, TEST_CONNECTION, { systemNoticeNegotiated: notices!, senderStyleNegotiated: style! });
		assert.equal(parsed.canonicalState, "valid", parsed.canonicalError); assert.equal(parsed.roomPage, undefined);
	}
	assert.equal(parsePollPayload(roomPoll(), TEST_CONNECTION, { systemNoticeNegotiated: true, senderStyleNegotiated: true }).canonicalState, "invalid");
	assert.equal(parsePollPayload(roomPoll(), TEST_CONNECTION, { systemNoticeNegotiated: false, roomContextNegotiated: true }).canonicalState, "invalid");
});

test("required room identity/state contradictions do not weaken canonical admission", () => {
	const mutations = [
		(p: ReturnType<typeof roomPoll>) => { p.ingress.room_context.messages.pop(); },
		(p: ReturnType<typeof roomPoll>) => { p.ingress.room_context.messages.find(m => m.message_id === IDS.command)!.state = "deleted"; },
		(p: ReturnType<typeof roomPoll>) => { p.ingress.room_context.coverage!.deleted_count = 100; },
		(p: ReturnType<typeof roomPoll>) => { p.ingress.connection.connection_id = IDS.otherConnection; },
	];
	for (const mutate of mutations) {
		const p = roomPoll(); mutate(p);
		const parsed = parsePollPayload(p, TEST_CONNECTION, options);
		assert.equal(parsed.canonicalState, "invalid"); assert.equal(parsed.ownerBundle, undefined); assert.equal(parsed.cursorV2, undefined);
	}
});

test("activity drops mutable record facts; malformed optional activity cannot drop commands", () => {
	const index = parseActivityIndex({ version: 1, advisory: true, status: "available", as_of: "2026-09-24T10:00:00Z", revision: "sha256:abc", truncated: true, entries: [{ id: IDS.resource, kind: "artifact", relation: "referenced", title: "OLD", status: "superseded", creator: { label: "Person" } }] });
	assert.deepEqual(index.entries, [{ id: IDS.resource, kind: "artifact", relation: "referenced" }]);
	const p = roomPoll(); Object.assign(p.ingress, { session_activity: { version: 99 } });
	const parsed = parsePollPayload(p, TEST_CONNECTION, options);
	assert.equal(parsed.canonicalState, "valid"); assert(parsed.ownerBundle); assert.equal(parsed.sessionActivity, null);
});

test("room negotiation requires the actual published capability, not a guessed version", () => {
	const document = { kind: "devspec.product.remote_ingress_contract", schema_version: 1, contract_version: "1.6.0", policy: { policy_version: "2026-09-24.1" }, activation: { room_context_negotiation_argument: "room_context_version", room_context_contract_requires: { ingress_version: 1, delegated_scope_version: 1, active_plan_projection_version: 1, system_notice_version: 1, sender_style_version: 1, room_context_version: 1 } } };
	assert.equal(advertisesRoomContext({ contents: [{ text: JSON.stringify(document) }] }), true);
	assert.equal(advertisesRoomContext({ contents: [{ text: JSON.stringify({ ...document, contract_version: "1.5.0" }) }] }), false);
	assert.equal(advertisesRoomContext({ contents: [{ text: "unavailable" }] }), false);
	assert.equal(advertisesRoomContext(null), false);
});
