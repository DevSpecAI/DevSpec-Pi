import assert from "node:assert/strict";
import { test } from "node:test";
import { executeControlCommand, parseControlCommand } from "../extensions/core/control.ts";

function host(calls: string[]) {
	return {
		isIdle: () => false,
		abort: () => calls.push("abort"),
		compact: () => calls.push("compact"),
		reload: async () => {
			calls.push("reload");
		},
		setThinkingLevel: (level: string) => calls.push(`think:${level}`),
		setModel: async () => true,
		notify: () => {},
	};
}

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
	const cmd = parseControlCommand({
		id: "c1",
		verb: "abort",
		issuedAt: "2026-08-13T19:00:00.000Z",
		issuedByUserId: "u1",
	});
	assert.ok(cmd);
	assert.equal(await executeControlCommand(cmd, host(calls)), "aborted");
	assert.deepEqual(calls, ["abort"]);
});

test("executeControlCommand reload calls the host reload", async () => {
	const calls: string[] = [];
	const cmd = parseControlCommand({
		id: "c2",
		verb: "reload",
		issuedAt: "2026-08-13T19:00:00.000Z",
		issuedByUserId: "u1",
	});
	assert.ok(cmd);
	assert.equal(await executeControlCommand(cmd, host(calls)), "reload requested");
	assert.deepEqual(calls, ["reload"]);
});
