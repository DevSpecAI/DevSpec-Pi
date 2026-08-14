import assert from "node:assert/strict";
import { test } from "node:test";
import {
	noteInjectedContext,
	noteModelToolResult,
	noteStaticContextBudget,
	registerContextBudgetToolNames,
	resetContextBudgetState,
	takeContextBudgetReport,
} from "../extensions/core/context-budget.ts";

test("context budget report contains numeric attribution and generated safe tool names only", () => {
	resetContextBudgetState();
	registerContextBudgetToolNames(["search_action_items", "get_memory", "BAD NAME", ""]);
	noteStaticContextBudget({
		systemPromptChars: 24_000,
		activeToolCount: 16,
		activeToolDefinitionChars: 18_500,
		contextFileCount: 2,
		contextFileChars: 8_000,
		skillCount: 3,
		skillChars: 4_000,
	});
	noteInjectedContext("attach", 900);
	noteInjectedContext("recall", 1_200);
	noteInjectedContext("conflictNudge", 300);
	noteModelToolResult("search_action_items", 4_170);
	noteModelToolResult("search_action_items", 3_000);
	noteModelToolResult("get_memory", 3_379);
	noteModelToolResult("unknown_tool_WITH_PRIVATE_BODY", 99_999);

	const report = takeContextBudgetReport();
	assert.deepEqual(report.static, {
		systemPromptChars: 24_000,
		activeToolCount: 16,
		activeToolDefinitionChars: 18_500,
		contextFileCount: 2,
		contextFileChars: 8_000,
		skillCount: 3,
		skillChars: 4_000,
	});
	assert.deepEqual(report.injected, {
		attachChars: 900,
		roomDigestChars: 0,
		recallChars: 1_200,
		conflictNudgeChars: 300,
		totalChars: 2_400,
	});
	assert.deepEqual(report.toolResults, {
		calls: 3,
		chars: 10_549,
		maxChars: 4_170,
		byVerb: [
			{ verb: "search_action_items", calls: 2, chars: 7_170, maxChars: 4_170 },
			{ verb: "get_memory", calls: 1, chars: 3_379, maxChars: 3_379 },
		],
	});
	assert.doesNotMatch(JSON.stringify(report), /PRIVATE_BODY|unknown_tool/);
});

test("settling clears dynamic counters while retaining the latest static footprint", () => {
	const next = takeContextBudgetReport();
	assert.equal(next.static.systemPromptChars, 24_000);
	assert.equal(next.injected.totalChars, 0);
	assert.equal(next.toolResults.calls, 0);
});

test("invalid and negative numeric inputs collapse safely to zero", () => {
	resetContextBudgetState();
	noteStaticContextBudget({ systemPromptChars: Number.NaN, activeToolCount: -2 });
	noteInjectedContext("recall", -1);
	const report = takeContextBudgetReport();
	assert.equal(report.static.systemPromptChars, 0);
	assert.equal(report.static.activeToolCount, 0);
	assert.equal(report.injected.totalChars, 0);
});
