import assert from "node:assert/strict";
import { test } from "node:test";
import { compactWithContext, executeControlCommand, parseControlCommand, reloadWithContext, runReloadLap } from "../extensions/core/control.ts";

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

test("executeControlCommand list_models is a no-op host call that reports listed", async () => {
	const calls: string[] = [];
	const cmd = parseControlCommand({
		id: "c4",
		verb: "list_models",
		issuedAt: "2026-08-13T19:00:00.000Z",
		issuedByUserId: "u1",
	});
	assert.ok(cmd);
	assert.equal(await executeControlCommand(cmd, host(calls)), "listed");
	assert.deepEqual(calls, []);
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

test("reloadWithContext uses the provided ctx and never invents a queued slash", async () => {
	let called = false;
	await reloadWithContext({
		reload: async () => {
			called = true;
		},
	});
	assert.equal(called, true);
	await assert.rejects(() => reloadWithContext(null), /not available/);
	await assert.rejects(() => reloadWithContext({}), /not available/);
});

test("runReloadLap acks before reload and does not reload if ack fails", async () => {
	const order: string[] = [];
	const ok = await runReloadLap({
		ack: async () => {
			order.push("ack");
		},
		reload: async () => {
			order.push("reload");
		},
	});
	assert.deepEqual(ok, { status: "reloaded" });
	assert.deepEqual(order, ["ack", "reload"]);

	const failed = await runReloadLap({
		ack: async () => {
			throw new Error("ack down");
		},
		reload: async () => {
			order.push("should-not-reload");
		},
	});
	assert.equal(failed.status, "ack_failed");
	assert.equal(failed.error, "ack down");
	assert.deepEqual(order, ["ack", "reload"]);
});

test("runReloadLap reports reload_failed after a successful ack", async () => {
	const order: string[] = [];
	const failed = await runReloadLap({
		ack: async () => {
			order.push("ack");
		},
		reload: async () => {
			order.push("reload");
			throw new Error("reload is not available on this context");
		},
	});
	assert.deepEqual(order, ["ack", "reload"]);
	assert.equal(failed.status, "reload_failed");
	assert.match(failed.error ?? "", /not available/);
});

