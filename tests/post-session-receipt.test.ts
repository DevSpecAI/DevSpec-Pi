import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePostSessionReceipt, TrailDeliveryState } from "../extensions/core/post-session-receipt.ts";

const expected = { connectionId: "connection", sessionId: "session", phase: "answer" };
const envelope = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const answer = { message_id: "message", session_id: "session", connection_id: "connection", sort_key: 3,
	turn_kind: "agent", message_type: "external_agent", phase: "answer", complete_turn: true };

for (const [name, data, request] of [
	["final-only answer", answer, expected],
	["in-place final answer", { ...answer, response_status: "completed", closed_trail_turn: true }, expected],
	["mid-turn speech", { ...answer, complete_turn: undefined }, expected],
	["local_prompt", { ...answer, turn_kind: "local_prompt", message_type: "local_user_prompt", complete_turn: undefined }, { ...expected, turnKind: "local_prompt" }],
	["trail", { message_id: "message", session_id: "session", connection_id: "connection", phase: "trail", response_status: "streaming", sort_key: 3, work_trail_chars: 100 }, { ...expected, phase: "trail" }],
] as const) {
	test(`accepts deployed ${name} text-JSON and structured MCP envelopes`, () => {
		for (const raw of [envelope(data), { structuredContent: data, content: [] }]) {
			assert.deepEqual(parsePostSessionReceipt(raw, request), { status: "stored", messageId: "message" });
		}
	});
}

test("typed exact storage and idempotent receipts require matching durable row identity", () => {
	for (const status of ["stored", "idempotently_stored"] as const) {
		assert.deepEqual(parsePostSessionReceipt(envelope({ ...answer, delivery: { status, message_id: "message" } }), expected), { status, messageId: "message" });
	}
	assert.equal(parsePostSessionReceipt(envelope({ ...answer, delivery: { status: "stored", message_id: "other" } }), expected).status, "malformed");
});

test("non-error noop/skips cannot masquerade as storage, even with a row id", () => {
	for (const data of [
		{ session_id: "session", connection_id: "connection", phase: "trail", skipped: true, noop: true, retryable: false, reason: "stale_generation" },
		{ ...answer, noop: true, already_finalized: true },
		{ ...answer, delivery: { status: "skipped", reason: "already_finalized", retryable: false } },
	]) assert.equal(parsePostSessionReceipt(envelope(data), expected).status, "skipped");
});

test("MCP refusals and malformed envelopes never acknowledge storage", () => {
	assert.equal(parsePostSessionReceipt({ ...envelope(answer), isError: true }, expected).status, "rejected");
	assert.equal(parsePostSessionReceipt(envelope({ delivery: { status: "rejected", reason: "stale_generation", retryable: false } }), expected).status, "rejected");
	for (const raw of [null, {}, answer, envelope({}), envelope([]), { content: [{ type: "text", text: "{broken" }] },
		envelope({ ...answer, message_id: "" }), envelope({ ...answer, session_id: "wrong-room" }),
		envelope({ ...answer, phase: "trail" }), envelope({ ...answer, connection_id: "other" }),
		envelope({ ...answer, delivery: { status: "maybe" } })]) {
		assert.equal(parsePostSessionReceipt(raw, expected).status, "malformed");
	}
});

test("failed snapshots stay dirty and stop automatic replay; only acknowledged revisions clean", () => {
	const failed = new TrailDeliveryState();
	failed.markDirty();
	const snapshot = failed.begin()!;
	assert.equal(failed.dirty, true);
	failed.finish(snapshot, false);
	assert.equal(failed.dirty, true);
	assert.equal(failed.blocked, true);
	assert.equal(failed.begin(), null);
	const successful = new TrailDeliveryState();
	successful.markDirty();
	const first = successful.begin()!;
	successful.markDirty();
	successful.finish(first, true);
	assert.equal(successful.dirty, true, "in-flight updates remain pending");
	successful.finish(successful.begin()!, true);
	assert.equal(successful.dirty, false);
});

test("source-aware receipt requires exact source, room, kind and typed storage, never legacy success", () => {
	const sourceExpected = { ...expected, turnKind: "agent", assistantSourceId: "source-uuid" };
	const sourceAnswer = { ...answer, assistant_source_id: "source-uuid", complete_turn: false,
		delivery: { status: "stored", message_id: "message" } };
	for (const status of ["stored", "idempotently_stored"] as const) {
		assert.deepEqual(parsePostSessionReceipt(envelope({ ...sourceAnswer,
			delivery: { status, message_id: "message" } }), sourceExpected), { status, messageId: "message" });
	}
	for (const altered of [
		{ assistant_source_id: "other-source" }, { assistant_source_id: undefined },
		{ session_id: "foreign-room" }, { turn_kind: "local_prompt" },
		{ delivery: undefined }, { delivery: { status: "stored", message_id: "other-row" } },
	]) assert.equal(parsePostSessionReceipt(envelope({ ...sourceAnswer, ...altered }), sourceExpected).status, "malformed");
	assert.equal(parsePostSessionReceipt(envelope({ ...sourceAnswer, error: "source_content_conflict" }), sourceExpected).status, "rejected");
});
