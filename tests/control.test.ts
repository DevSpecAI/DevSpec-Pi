import assert from "node:assert/strict";
import { test } from "node:test";
import { compactWithContext, executeControlCommand, parseControlCommand } from "../extensions/core/control.ts";

function host(calls: string[]) {
	return {
		isIdle: () => false,
		abort: () => calls.push("abort"),
		compact: async () => {
			calls.push("compact");
		},
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

test("executeControlCommand compact awaits the host and reports compacted", async () => {
	const calls: string[] = [];
	const cmd = parseControlCommand({
		id: "c3",
		verb: "compact",
		issuedAt: "2026-08-13T19:00:00.000Z",
		issuedByUserId: "u1",
	});
	assert.ok(cmd);
	assert.equal(await executeControlCommand(cmd, host(calls)), "compacted");
	assert.deepEqual(calls, ["compact"]);
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
	assert.equal(await executeControlCommand(cmd, host(calls)), "reloaded");
	assert.deepEqual(calls, ["reload"]);
});

test("compactWithContext uses the provided ctx even when lastCtx would be null", async () => {
	let called = false;
	const live = {
		compact: (opts?: { onComplete?: (result: unknown) => void }) => {
			called = true;
			opts?.onComplete?.({ ok: true });
		},
	};
	await compactWithContext(live);
	assert.equal(called, true);
	await assert.rejects(() => compactWithContext(null), /not available/);
});

test("compactWithContext times out when neither callback fires", async () => {
	const hanging = { compact: () => {} };
	await assert.rejects(() => compactWithContext(hanging, 20), /timed out/);
});

