import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractOwnerCommands,
	formatInboundMessage,
	parsePollPayload,
} from "../extensions/core/remote-payload.ts";

const ME = "conn-123";

test("extracts only owner commands addressed to this connection", () => {
	const payload = {
		commands: [
			{ id: "m1", content: "fix the flaky test", user_name: "Ali", addressed_to: { connection_id: ME }, authority: { kind: "owner" } },
			{ id: "m2", content: "not for me", addressed_to: { connection_id: "other" }, authority: { kind: "owner" } },
			{ id: "m3", content: "advisory only", addressed_to: { connection_id: ME }, authority: { kind: "controller_other_connection" } },
			{ id: "m4", content: "missing stamps — fail closed" },
		],
	};
	const cmds = extractOwnerCommands(payload, ME);
	assert.equal(cmds.length, 1);
	assert.equal(cmds[0].text, "fix the flaky test");
	assert.equal(cmds[0].userName, "Ali");
	assert.equal(cmds[0].id, "m1");
});

test("acts on a delegated command, but still refuses an unknown authority kind", () => {
	// Decision A (DevSpec memory 61ba9948): a teammate the owner authorised sends
	// `delegated`. Equally valid, identical capabilities — the difference is whose
	// name goes on the work, not what the work may be.
	const payload = {
		commands: [
			{ id: "d1", content: "check why staging is red", user_name: "Brandon", addressed_to: { connection_id: ME }, authority: { kind: "delegated" } },
			// A kind we have never heard of must still fail closed, so a future
			// server value cannot switch itself on here.
			{ id: "d2", content: "escalate", addressed_to: { connection_id: ME }, authority: { kind: "superuser" } },
			// Widening WHO may command must not widen WHICH agent acts.
			{ id: "d3", content: "for another agent", addressed_to: { connection_id: "other" }, authority: { kind: "delegated" } },
		],
	};
	const cmds = extractOwnerCommands(payload, ME);
	assert.equal(cmds.length, 1);
	assert.equal(cmds[0].id, "d1");
	assert.equal(cmds[0].userName, "Brandon");
});

test("extractOwnerCommands stamps created_at from the poll payload", () => {
	const cmds = extractOwnerCommands(
		{
			commands: [
				{
					id: "m1",
					content: "can you pick up from here?",
					created_at: "2026-08-13T14:02:55.257Z",
					addressed_to: { connection_id: ME },
					authority: { kind: "owner" },
				},
			],
		},
		ME,
	);
	assert.equal(cmds[0].createdAt, "2026-08-13T14:02:55.257Z");
});

test("text can live in message/text/body fields", () => {
	const payload = {
		commands: [
			{ message: "via message", addressed_to: { connection_id: ME }, authority: { kind: "owner" } },
			{ text: "via text", addressed_to: { connection_id: ME }, authority: { kind: "owner" } },
			{ body: "via body", addressed_to: { connection_id: ME }, authority: { kind: "owner" } },
			{ content: "   ", addressed_to: { connection_id: ME }, authority: { kind: "owner" } },
		],
	};
	const cmds = extractOwnerCommands(payload, ME);
	assert.deepEqual(cmds.map((c) => c.text), ["via message", "via text", "via body"]);
});

test("parsePollPayload pulls cursors, dispatch count, and changed flag", () => {
	const pkg = parsePollPayload(
		{
			changed: true,
			cursor: "cur-9",
			dispatch_cursor: "dcur-4",
			dispatches: [{}, {}],
			commands: [{ content: "hi", addressed_to: { connection_id: ME }, authority: { kind: "owner" } }],
		},
		ME,
	);
	assert.equal(pkg.changed, true);
	assert.equal(pkg.cursor, "cur-9");
	assert.equal(pkg.dispatchCursor, "dcur-4");
	assert.equal(pkg.dispatchCount, 2);
	assert.equal(pkg.ownerCommands.length, 1);
});

test("parsePollPayload tolerates empty/garbage", () => {
	assert.deepEqual(parsePollPayload(null, ME), {
		changed: false,
		cursor: undefined,
		dispatchCursor: undefined,
		control: undefined,
		ownerCommands: [],
		dispatchCount: 0,
	});
});

test("formatInboundMessage tags sender and codename", () => {
	const msg = formatInboundMessage({ text: "do the thing", userName: "Ali" }, "Ivory Panda");
	assert.equal(msg, "[DevSpec remote — message from Ali to Ivory Panda] do the thing");
	assert.equal(
		formatInboundMessage({ text: "hi" }, "Ivory Panda"),
		"[DevSpec remote — message from owner to Ivory Panda] hi",
	);
});

test("the envelope's first line always carries content (2b072496 — the queued-follow-up preview)", () => {
	// Single-line: body rides the header line, which is all the TUI preview shows.
	const short = formatInboundMessage({ text: "looks good, ship it", userName: "Ali" }, "Jolly Toucan");
	assert.equal(short.split("\n")[0], "[DevSpec remote — message from Ali to Jolly Toucan] looks good, ship it");

	// Multiline: line one leads with an excerpt of the content.
	const long = formatInboundMessage(
		{ text: "first line of a long message\nsecond line\nthird", userName: "Ali" },
		"Jolly Toucan",
	);
	const longFirstLine = long.split("\n")[0];
	assert.match(longFirstLine, /^\[DevSpec remote — message from Ali to Jolly Toucan\] — “first line of a long message …”$/);
	// The full body survives intact below the excerpt.
	assert.ok(long.endsWith("first line of a long message\nsecond line\nthird"));
});

test("empty commands never become turns (the extractor drops them)", () => {
	const payload = {
		changed: true,
		commands: [
			{ id: "1", addressed_to: { connection_id: "c1" }, authority: { kind: "owner" }, content: "" },
			{ id: "2", addressed_to: { connection_id: "c1" }, authority: { kind: "owner" }, content: "   " },
			{ id: "3", addressed_to: { connection_id: "c1" }, authority: { kind: "owner" }, content: "real" },
		],
	};
	const cmds = extractOwnerCommands(payload, "c1");
	assert.deepEqual(cmds.map((c) => c.text), ["real"]);
});

test("the envelope stamps the session id and prefers real names (9dcbd157)", () => {
	const bond = { sessionId: "d8883a49-5e1f-416f-8384-7fd65e2e016b", sessionTitle: "Test DevSpec UI message delivery", ownerName: "Ali Price" };
	const msg = formatInboundMessage({ text: "do the thing" }, "Jolly Toucan", bond);
	assert.equal(
		msg.split("\n")[0],
		"[DevSpec remote — message from Ali Price to Jolly Toucan · “Test DevSpec UI message d…” (d8883a49)] do the thing",
	);
	// Title unknown yet (job-generated) — the id still stamps, no dangling quotes.
	const untitled = formatInboundMessage(
		{ text: "hi" },
		"Jolly Toucan",
		{ sessionId: "d8883a49-5e1f-416f-8384-7fd65e2e016b", ownerName: "Ali Price" },
	);
	assert.equal(
		untitled.split("\n")[0],
		"[DevSpec remote — message from Ali Price to Jolly Toucan · (d8883a49)] hi",
	);
	// No bond context at all — unchanged legacy shape.
	assert.equal(
		formatInboundMessage({ text: "hi" }, "Jolly Toucan").split("\n")[0],
		"[DevSpec remote — message from owner to Jolly Toucan] hi",
	);
});
