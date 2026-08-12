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
		ownerCommands: [],
		dispatchCount: 0,
	});
});

test("formatInboundMessage tags sender and codename", () => {
	const msg = formatInboundMessage({ text: "do the thing", userName: "Ali" }, "Ivory Panda");
	assert.equal(msg, "[DevSpec remote — message from Ali to Ivory Panda]\ndo the thing");
	assert.equal(
		formatInboundMessage({ text: "hi" }, "Ivory Panda"),
		"[DevSpec remote — message from owner to Ivory Panda]\nhi",
	);
});
