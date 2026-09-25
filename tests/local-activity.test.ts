import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { startLocalActivity } from "../extensions/core/local-activity.ts";

const attemptId = "10000000-0000-4000-8000-000000000001";
const previousId = "10000000-0000-4000-8000-000000000002";
const scope = { connection_id: "connection", expected_session_id: "room", expected_attachment_id: "attachment", expected_attached_at: "2026-09-25T00:00:00Z" };
const receipt = (status = "working") => ({ ...scope, attempt_id: attemptId, status, already_started: false });
const base = { scope, attemptId, previousAttemptId: null, current: () => true };

test("local admission returns the exact receipt and no other identity", async () => {
	const calls: any[] = [];
	assert.equal(await startLocalActivity({ ...base, request: async args => { calls.push(args); return receipt(); } }), attemptId);
	assert.deepEqual(calls, [{ ...scope, attempt_id: attemptId, previous_attempt_id: null, local_activity_version: 1, local_turn: true }]);
});
test("one predecessor conflict retries the SAME execution only while current", async () => {
	const calls: any[] = [];
	assert.equal(await startLocalActivity({ ...base, request: async args => {
		calls.push(args); return calls.length === 1 ? { ...receipt("predecessor_changed"), previous_attempt_id: previousId } : receipt();
	} }), attemptId);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].attempt_id, attemptId);
	assert.equal(calls[1].previous_attempt_id, previousId);
});
test("repeated conflicts are bounded and never become a receipt", async () => {
	let calls = 0;
	assert.equal(await startLocalActivity({ ...base, request: async () => { calls++; return { ...receipt("predecessor_changed"), previous_attempt_id: previousId }; } }), null);
	assert.equal(calls, 2);
});
test("a newer foreground prevents an old conflict retry and old receipt adoption", async () => {
	for (const result of [receipt(), { ...receipt("predecessor_changed"), previous_attempt_id: previousId }]) {
		let current = true, calls = 0;
		assert.equal(await startLocalActivity({ ...base, current: () => current, request: async () => { calls++; current = false; return result; } }), null);
		assert.equal(calls, 1);
	}
});
test("unknown, denied, malformed, cross-room and cross-attempt receipts never grant completion", async () => {
	for (const result of [undefined, [], {}, receipt("foreground_owned"), receipt("superseded"),
		{ ...receipt(), attempt_id: previousId }, { ...receipt(), expected_session_id: "other" },
		{ ...receipt(), expected_attachment_id: "other" }, { ...receipt(), already_started: undefined },
		{ ...receipt(), expected_attached_at: "invalid" }]) {
		assert.equal(await startLocalActivity({ ...base, request: async () => result }), null);
	}
	assert.equal(await startLocalActivity({ ...base, request: async () => { throw new Error("offline"); } }), null);
});

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const start = source.indexOf("async function completeTurnActivity(");
const end = source.indexOf("/** Cap for the provider", start);
const helper = stripTypeScriptTypes(source.slice(start, end), { mode: "transform" });
test("local completion freezes its receipt before a reused segment changes", async () => {
	let release!: (id: string) => void;
	const ready = new Promise<string>(resolve => { release = resolve; });
	const calls: any[] = [];
	const ctx = vm.createContext({ reportComplete: (...args: unknown[]) => { calls.push(args); return true; }, interactionIdentity: () => undefined });
	vm.runInContext(helper, ctx);
	const turn: any = { localActivityReady: ready, canPost: () => true };
	const result = ctx.completeTurnActivity(turn, "turn_end");
	turn.localActivityReady = Promise.resolve(previousId);
	release(attemptId);
	assert.equal(await result, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][3], false, "never latest-unbound");
	assert.equal(calls[0][7], attemptId);
});
test("command and interaction completion keep their original exact identity", async () => {
	const calls: any[] = [];
	const identity = { attemptId, eventId: previousId };
	const ctx = vm.createContext({ reportComplete: (...args: unknown[]) => { calls.push(args); return true; }, interactionIdentity: (run: any) => run?.identity });
	vm.runInContext(helper, ctx);
	await ctx.completeTurnActivity({ commandTurnId: "turn-a", commandMessageId: "message-a", canPost: () => true }, "turn_end");
	await ctx.completeTurnActivity({ interaction: { identity }, canPost: () => true }, "turn_end");
	assert.deepEqual(calls[0].slice(0, 5), ["turn_end", "turn-a", "message-a", false, undefined]);
	assert.equal(calls[1][4], identity);
});
test("unknown local pickup never triggers pickup-at-drain or unbound completion", async () => {
	const ctx = vm.createContext({ reportComplete: () => { throw new Error("must not complete"); }, interactionIdentity: () => undefined });
	vm.runInContext(helper, ctx);
	assert.equal(await ctx.completeTurnActivity({ canPost: () => true }, "turn_end"), false);
	assert.equal(await ctx.completeTurnActivity({ localActivityReady: Promise.resolve(null), canPost: () => true }, "turn_end"), false);
});
