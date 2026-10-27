import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentStatsReport, refreshAgentStatsReport, TelemetryCollector } from "../extensions/core/telemetry.ts";

test("TelemetryCollector sums message usages within a turn and folds into the session at settle", () => {
	const c = new TelemetryCollector();
	c.addMessageUsage({ input: 100, output: 20, cacheRead: 900, cacheWrite: 50, cost: { total: 0.01 } });
	c.addMessageUsage({ input: 200, output: 30, cacheRead: 800, cacheWrite: 0, cost: { total: 0.02 } });
	const first = c.settleTurn();
	assert.deepEqual(first.turn, { input: 300, output: 50, cacheRead: 1700, cacheWrite: 50, costUsd: 0.03, messages: 2 });
	assert.equal(first.session.turns, 1);
	assert.equal(first.session.input, 300);

	// Next turn starts clean; the session keeps accumulating.
	c.addMessageUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } });
	const second = c.settleTurn();
	assert.equal(second.turn.messages, 1);
	assert.equal(second.turn.input, 10);
	assert.equal(second.session.input, 310);
	assert.equal(second.session.turns, 2);
	assert.equal(second.session.costUsd, 0.035);
});

test("TelemetryCollector tolerates missing/garbage usage fields", () => {
	const c = new TelemetryCollector();
	c.addMessageUsage(undefined); // no-op: no usage object, nothing counted
	c.addMessageUsage({ input: Number.NaN, output: -5, cost: { total: Number.POSITIVE_INFINITY } });
	c.addMessageUsage({});
	const { turn } = c.settleTurn();
	assert.deepEqual(turn, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 2 });
});

test("buildAgentStatsReport shapes the wire report and rounds cost/percent", () => {
	const report = buildAgentStatsReport({
		turn: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.123456789, messages: 1 },
		session: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 1, turns: 3 },
		model: { provider: "anthropic", id: "claude-opus-4.1" },
		thinkingLevel: "high",
		context: { tokens: 12345.6, contextWindow: 200000, percent: 61.72 },
		contextBudget: {
			v: 1,
			static: { systemPromptChars: 20_000, activeToolCount: 16, activeToolDefinitionChars: 12_000, contextFileCount: 1, contextFileChars: 4_000, skillCount: 2, skillChars: 3_000 },
			injected: { attachChars: 0, roomDigestChars: 0, recallChars: 900, conflictNudgeChars: 0, totalChars: 900 },
			toolResults: { calls: 1, chars: 4_000, maxChars: 4_000, byVerb: [{ verb: "search_tasks", calls: 1, chars: 4_000, maxChars: 4_000 }] },
		},
		now: "2026-08-12T00:00:00.000Z",
	});
	assert.equal(report.v, 1);
	assert.deepEqual(report.model, { provider: "anthropic", id: "claude-opus-4.1" });
	assert.equal(report.thinkingLevel, "high");
	assert.deepEqual(report.context, { tokens: 12346, window: 200000, percent: 61.7 });
	assert.equal(report.contextBudget?.toolResults.byVerb[0]?.verb, "search_tasks");
	assert.equal(report.at, "2026-08-12T00:00:00.000Z");
});

test("refreshAgentStatsReport updates runtime identity without inventing a turn or losing usage", () => {
	const initial = buildAgentStatsReport({
		turn: { input: 10, output: 4, cacheRead: 20, cacheWrite: 0, costUsd: 0.01, messages: 1 },
		session: { input: 50, output: 12, cacheRead: 80, cacheWrite: 0, costUsd: 0.05, turns: 3 },
		model: { provider: "anthropic", id: "claude-opus-4.1" },
		thinkingLevel: "medium",
		now: "2026-08-12T00:00:00.000Z",
	});
	const refreshed = refreshAgentStatsReport({
		previous: initial,
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "high",
		now: "2026-08-12T00:01:00.000Z",
	});
	assert.deepEqual(refreshed.turn, initial.turn);
	assert.deepEqual(refreshed.session, initial.session);
	assert.deepEqual(refreshed.model, { provider: "openai-codex", id: "gpt-5.6-sol" });
	assert.equal(refreshed.thinkingLevel, "high");
	assert.equal(refreshed.contextBudget, initial.contextBudget);

	const startup = refreshAgentStatsReport({
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "low",
	});
	assert.equal(startup.turn.messages, 0);
	assert.equal(startup.session.turns, 0);
});

test("buildAgentStatsReport tolerates unknown model and null context", () => {
	const report = buildAgentStatsReport({
		turn: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 },
		session: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 },
		model: undefined,
		context: undefined,
	});
	assert.equal(report.model, null);
	assert.equal(report.context, null);
	assert.equal(report.thinkingLevel, null);
});

test("agent_stats carries a capability snapshot and omits unknown capabilities", () => {
	const supportedThinkingLevels = ["off", "high", "max"];
	const initial = refreshAgentStatsReport({
		model: { provider: "custom", id: "alias" }, supportedThinkingLevels,
	});
	assert.deepEqual(initial.supportedThinkingLevels, ["off", "high", "max"]);
	supportedThinkingLevels.push("xhigh");
	assert.deepEqual(initial.supportedThinkingLevels, ["off", "high", "max"], "snapshot must not alias runtime input");

	const changed = refreshAgentStatsReport({
		previous: initial, model: { provider: "custom", id: "non-reasoning" },
		supportedThinkingLevels: ["off"], thinkingLevel: "off",
	});
	assert.deepEqual(changed.supportedThinkingLevels, ["off"]);
	assert.deepEqual(changed.model, { provider: "custom", id: "non-reasoning" });
	assert.deepEqual(changed.turn, initial.turn);
	assert.deepEqual(changed.session, initial.session);

	const unknown = refreshAgentStatsReport({ previous: changed });
	assert.equal(unknown.model, null);
	assert.equal(Object.hasOwn(unknown, "supportedThinkingLevels"), false, "never retain prior-model capabilities");
	assert.equal(Object.hasOwn(refreshAgentStatsReport({ model: initial.model }), "supportedThinkingLevels"), false);
});
