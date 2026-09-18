import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeWorkState } from "../extensions/core/runtime-work.ts";
import { BackgroundWorkJournal, BACKGROUND_WORK_JOURNAL, structuredBackgroundWake, ownedBackgroundLaunch, needsBackgroundProviderStatus } from "../extensions/core/background-work-journal.ts";
const scope = { generation: "11111111-1111-4111-8111-111111111111", session_id: "22222222-2222-4222-8222-222222222222", attached_at: "2026-09-18T00:00:00Z" };
const origin = { localSessionId: "pi-session", connectionId: "connection", sourceSessionId: scope.session_id, generation: scope.generation, attachedAt: scope.attached_at, commandMessageId: "original-command", workClaimIds: ["original-claim"], span: { id: "33333333-3333-4333-8333-333333333333", startedAt: "2026-09-18T00:00:00Z" } };

test("old settle/provider callback cannot clear a newer execution or rotate into its epoch", () => {
	const state = new RuntimeWorkState(); state.setScope(scope, "connection");
	const old = state.begin(); const oldReport = state.report()!;
	const next = state.begin();
	assert.equal(state.finish(old), false);
	assert.equal(state.observeBackground(old, { state: "known", activeCount: 0 }), false);
	assert.equal(state.report()!.foreground_state, "working");
	assert.equal(state.finish(next), true);
	assert.ok(state.report()!.revision > oldReport.revision);
	state.setScope({ ...scope, generation: "44444444-4444-4444-8444-444444444444" }, "connection");
	assert.equal(state.observeBackground(next, { state: "known", activeCount: 0 }), false);
});

test("foreground settles independently while background preserves timer; genuine idle resets it", () => {
	let now = Date.parse(origin.span.startedAt);
	const state = new RuntimeWorkState(() => now); state.setScope(scope, "connection");
	const foreground = state.begin(); const first = state.report()!;
	state.observeBackground(foreground, { state: "known", activeCount: 1 });
	now += 30_000; state.finish(foreground);
	assert.equal(state.report()!.foreground_state, "idle");
	assert.equal(state.currentSpan()?.id, first.work_span_id);
	const question = state.begin(); state.finish(question);
	assert.equal(state.currentSpan()?.id, first.work_span_id);
	state.observeBackground(state.capture(), { state: "known", activeCount: 0 });
	assert.equal(state.currentSpan(), null);
	now += 1000; state.begin();
	assert.notEqual(state.report()!.work_span_id, first.work_span_id);
});

test("unknown cannot create a backdated span; same-root fresh revalidation can restore across rotation", () => {
	const state = new RuntimeWorkState(() => Date.parse("2026-09-18T00:05:00Z")); state.setScope(scope, "connection");
	state.observeBackground(state.capture(), { state: "unknown", activeCount: 0 }, origin.span);
	assert.equal(state.currentSpan(), null);
	state.observeBackground(state.capture(), { state: "unknown", activeCount: 1 }, origin.span);
	assert.deepEqual(state.currentSpan(), origin.span);
	state.setScope({ ...scope, generation: "44444444-4444-4444-8444-444444444444" }, "connection");
	assert.equal(state.currentSpan(), null);
	state.observeBackground(state.capture(), { state: "known", activeCount: 1 }, origin.span);
	assert.deepEqual(state.currentSpan(), origin.span);
});

test("immutable origin survives reload and same-room revalidation; foreign room is excluded", () => {
	const entries: unknown[] = [];
	const first = new BackgroundWorkJournal(data => entries.push({ type: "custom", customType: BACKGROUND_WORK_JOURNAL, data }));
	first.launch("background-tasks", { id: "task", status: "running" }, origin);
	const restored = new BackgroundWorkJournal(() => {}); restored.restore(entries, "pi-session");
	const snapshot = [{ id: "task", status: "running" as const }];
	assert.deepEqual(restored.observe("background-tasks", snapshot, { localSessionId: "pi-session", connectionId: "connection", sourceSessionId: scope.session_id }).span, origin.span);
	assert.deepEqual(restored.origin("background-tasks", "task"), origin);
	assert.equal(restored.observe("background-tasks", snapshot, { localSessionId: "pi-session", connectionId: "connection", sourceSessionId: "another-room" }).observation.activeCount, 0);
	assert.deepEqual(restored.origin("background-tasks", "task"), origin, "reattachment never rewrites immutable origin");
});

test("terminal-before-receipt persists terminal identity and never restores false continuity", () => {
	const journal = new BackgroundWorkJournal(() => {});
	journal.terminal("background-tasks", { id: "task", status: "completed" });
	journal.launch("background-tasks", { id: "task", status: "running" }, origin);
	const result = journal.observe("background-tasks", [{ id: "task", status: "running" }], { localSessionId: "pi-session", connectionId: "connection", sourceSessionId: scope.session_id });
	assert.equal(result.observation.activeCount, 0); assert.equal(result.span, undefined);
});

test("non-notifying successful bg launch has ownership; inspection result never adopts", () => {
	const result = { details: { task: { id: "task", status: "running", notifyOnCompletion: false, triggerOnCompletion: false } } };
	assert.equal(ownedBackgroundLaunch("bg_run", result, false)?.task.id, "task");
	assert.equal(ownedBackgroundLaunch("bg_status", result, false), null);
});

test("installed subagent-notify lacks structured root identity: no text/timing fallback", () => {
	assert.equal(structuredBackgroundWake("subagent-notify", undefined), null);
	assert.deepEqual(structuredBackgroundWake("background-task-notification", { id: "task", status: "completed" }), { provider: "background-tasks", taskIds: ["task"] });
});


test("optional absent provider without owned journal is not unavailable owned work", () => {
	assert.equal(needsBackgroundProviderStatus("background-tasks", ["read", "bash"], false), false);
	assert.equal(needsBackgroundProviderStatus("subagents", ["read", "bash"], false), false);
	assert.equal(needsBackgroundProviderStatus("background-tasks", ["bg_run"], false), true);
	assert.equal(needsBackgroundProviderStatus("background-tasks", [], true), true);
	const journal = new BackgroundWorkJournal(() => {});
	journal.launch("background-tasks", { id: "task", status: "running" }, origin);
	assert.deepEqual(journal.observe("background-tasks", null, { localSessionId: "pi-session", connectionId: "connection", sourceSessionId: scope.session_id }).observation,
		{ state: "unknown", activeCount: 0 });
});


test("same-binding continuous foreground survives capability rotation; foreign attachment does not adopt it", () => {
	let now = Date.parse("2026-09-18T00:05:00Z");
	const state = new RuntimeWorkState(() => now); state.setScope(scope, "connection");
	const old = state.begin(); const span = state.currentSpan();
	now += 60_000;
	state.setScope({ ...scope, generation: "44444444-4444-4444-8444-444444444444" }, "connection");
	assert.deepEqual(state.currentSpan(), span);
	assert.equal(state.finish(old), false);
	state.setScope({ ...scope, session_id: "55555555-5555-4555-8555-555555555555" }, "connection");
	assert.equal(state.report()?.foreground_state, "unknown");
	assert.equal(state.currentSpan(), null);
});

test("genuine observed idle prohibits resurrecting an ended span even with a later positive observation", () => {
	let now = Date.parse("2026-09-18T00:05:00Z");
	const state = new RuntimeWorkState(() => now); state.setScope(scope, "connection");
	state.observeBackground(state.capture(), { state: "known", activeCount: 1 }, origin.span);
	state.observeBackground(state.capture(), { state: "known", activeCount: 0 });
	now += 60_000;
	state.observeBackground(state.capture(), { state: "known", activeCount: 1 }, origin.span);
	assert.notEqual(state.currentSpan()?.id, origin.span.id);
	assert.equal(state.currentSpan()?.startedAt, new Date(now).toISOString());
});
