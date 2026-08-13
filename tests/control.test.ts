import assert from "node:assert/strict";
import { test } from "node:test";
import { executeControlCommand, parseControlCommand } from "../extensions/core/control.ts";

test("parseControlCommand accepts abort and rejects chat-shaped payloads", () => {
	assert.equal(parseControlCommand({ hello: "world" }), null);
	const cmd = parseControlCommand({
		id: "c1",
		verb: "abort",
		issuedAt: "2026-08-13T19:00:00.000Z",
		issuedByUserId: "u1",
	});
	assert.equal(cmd?.verb, "abort");
});

test("executeControlCommand abort stops a busy host and is a no-op when idle", async () => {
	const calls: string[] = [];
	const host = {
		isIdle: () => false,
		abort: () => calls.push("abort"),
		compact: () => calls.push("compact"),
		setThinkingLevel: (level: string) => calls.push(`think:${level}`),
		setModel: async () => true,
		notify: () => {},
	};
	const cmd = parseControlCommand({
		id: "c1",
		verb: "abort",
		issuedAt: "2026-08-13T19:00:00.000Z",
		issuedByUserId: "u1",
	});
	assert.ok(cmd);
	assert.equal(await executeControlCommand(cmd, host), "aborted");
	assert.deepEqual(calls, ["abort"]);
});
