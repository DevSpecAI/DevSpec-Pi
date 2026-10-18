import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	parseDuplicateToolNames,
	planDuplicateRecovery,
	RECOVERY_ENTRY_TYPE,
	scanTranscriptToolState,
	withRestoredTools,
} from "../extensions/core/activation-recovery.ts";
import registerDevspecTools from "../extensions/devspec-tools.ts";

/**
 * Item dc8f52d4: a rare tool announced twice in one transcript reaches the
 * provider wire twice under Pi's Kimi deferred-tools serializer (400
 * "duplicate tool names", session bricked). These tests pin the extension-side
 * contract: resume restores prior announcements so the loader never
 * re-announces, and a duplicate-tools error triggers recovery, not a brick.
 */

function toolResultEntry(addedToolNames: string[]): SessionEntry {
	return {
		type: "message",
		id: Math.random().toString(36).slice(2),
		parentId: null,
		timestamp: "2026-09-15T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "search_devspec_tools",
			content: [{ type: "text", text: "Loaded DevSpec tools" }],
			addedToolNames,
		},
	} as unknown as SessionEntry;
}

function recoveryEntry(denied: string[]): SessionEntry {
	return {
		type: "custom",
		id: Math.random().toString(36).slice(2),
		parentId: null,
		timestamp: "2026-09-15T00:00:00.000Z",
		customType: RECOVERY_ENTRY_TYPE,
		data: { denied },
	} as unknown as SessionEntry;
}

test("parseDuplicateToolNames reads single- and double-quoted name lists", () => {
	assert.deepEqual(
		parseDuplicateToolNames(
			'400: {"object":"error","message":"duplicate tool names are not allowed: [\'get_tasks\']"}',
		),
		["get_tasks"],
	);
	assert.deepEqual(
		parseDuplicateToolNames('duplicate tool names are not allowed: ["a", \'b\']'),
		["a", "b"],
	);
	assert.deepEqual(parseDuplicateToolNames("some other provider error"), []);
});

test("scanTranscriptToolState restores only rare verbs, once, in announcement order", () => {
	const rare = new Set(["get_tasks", "create_automation"]);
	const isRare = (name: string) => rare.has(name);
	const entries = [
		toolResultEntry(["get_tasks", "get_project_summary", "not_a_tool"]),
		toolResultEntry(["create_automation", "get_tasks"]),
	];
	const state = scanTranscriptToolState(entries, isRare);
	assert.deepEqual(state.restore, ["get_tasks", "create_automation"]);
	assert.deepEqual(state.denied, []);
});

test("scanTranscriptToolState honours recorded recoveries and ignores lookalikes", () => {
	const isRare = () => true;
	const entries = [
		toolResultEntry(["get_tasks", "create_automation"]),
		recoveryEntry(["get_tasks"]),
		// A model-visible custom message is not a recovery record.
		{
			type: "custom_message",
			id: "m1",
			parentId: null,
			timestamp: "2026-09-15T00:00:00.000Z",
			customType: RECOVERY_ENTRY_TYPE,
			content: "Deactivated after a provider duplicate-tool error",
			display: false,
		} as unknown as SessionEntry,
		recoveryEntry(["not_an_array_test" as unknown as string]),
	];
	const state = scanTranscriptToolState(entries, isRare);
	assert.deepEqual(state.restore, ["create_automation"]);
	assert.deepEqual(state.denied, ["get_tasks", "not_an_array_test"]);
});

test("withRestoredTools appends only missing names and never duplicates", () => {
	assert.deepEqual(withRestoredTools(["a", "b"], ["b", "c"]), ["a", "b", "c"]);
	assert.deepEqual(withRestoredTools(["a"], []), ["a"]);
});

test("planDuplicateRecovery selects active catalog tools from the latest matching error", () => {
	const error = "duplicate tool names are not allowed: ['get_tasks', 'foreign_tool']";
	const plan = planDuplicateRecovery([{ role: "assistant", errorMessage: error }], {
		isCatalogTool: (name) => name !== "foreign_tool",
		isActive: () => true,
		isDenied: () => false,
	});
	assert.deepEqual(plan?.names, ["get_tasks"]);
});

test("planDuplicateRecovery never loops: denied, inactive, or foreign names yield null", () => {
	const error = "duplicate tool names are not allowed: ['get_tasks']";
	assert.equal(
		planDuplicateRecovery([{ errorMessage: error }], {
			isCatalogTool: () => true,
			isActive: () => true,
			isDenied: () => true,
		}),
		null,
	);
	assert.equal(
		planDuplicateRecovery([{ errorMessage: error }], {
			isCatalogTool: () => true,
			isActive: () => false,
			isDenied: () => false,
		}),
		null,
	);
	assert.equal(
		planDuplicateRecovery([{ errorMessage: "rate limit exceeded" }], {
			isCatalogTool: () => true,
			isActive: () => true,
			isDenied: () => false,
		}),
		null,
	);
});

test("resume restores announced rare tools, the loader never re-announces, and a duplicate error recovers", async () => {
	type ToolDef = {
		name: string;
		parameters: unknown;
		execute: (...args: any[]) => Promise<{
			content?: { type: string; text: string }[];
			details?: { matches?: Array<{ name: string }>; added?: string[]; unavailable?: string[] };
		}>;
	};
	const definitions: ToolDef[] = [];
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	let active = ["read"];
	const appended: { customType: string; data: unknown }[] = [];
	const userMessages: string[] = [];
	const pi = {
		registerTool(def: ToolDef) {
			definitions.push(def);
			active.push(def.name);
		},
		on(name: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
			handlers.set(name, handler);
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active = [...names];
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ customType, data });
		},
		sendUserMessage(content: string) {
			userMessages.push(content);
		},
	} as unknown as ExtensionAPI;

	registerDevspecTools(pi);

	// Resume: the branch carries two pre-crash announcements (item dc8f52d4).
	const branch = [toolResultEntry(["get_tasks", "create_automation"])];
	const ctx = { sessionManager: { getBranch: () => branch }, hasUI: false };
	handlers.get("session_start")?.({}, ctx);

	assert.ok(active.includes("get_tasks"), "announced rare tool restored on resume");
	assert.ok(active.includes("create_automation"), "second announced rare tool restored");
	assert.equal(
		active.filter((name) => name === "get_tasks").length,
		1,
		"restore never duplicates",
	);

	// The loader must now report the restored tool as already active — no
	// second announcement, so no second Kimi injection, so no duplicate.
	const loader = definitions.find((def) => def.name === "search_devspec_tools");
	assert.ok(loader);
	const reload = await loader.execute("call-1", { query: "get_tasks", limit: 5 });
	assert.ok(reload.details?.matches?.some(hit => hit.name === "get_tasks"), "fixture query must find the tool");
	assert.ok(
		!reload.details?.added?.includes("get_tasks"),
		"restored tool is never re-announced by the loader",
	);

	// A legacy double announcement still 400s once: the agent_end hook
	// deactivates the tool, persists the denial, and nudges the turn to
	// continue — instead of bricking the session.
	const errorMessage = "400: duplicate tool names are not allowed: ['get_tasks']";
	await handlers.get("agent_end")?.({ messages: [{ role: "assistant", errorMessage }] }, ctx);
	assert.ok(!active.includes("get_tasks"), "offending tool deactivated");
	assert.deepEqual(appended, [
		{ customType: RECOVERY_ENTRY_TYPE, data: { denied: ["get_tasks"], error: errorMessage } },
	]);
	assert.equal(userMessages.length, 1, "one continue nudge");

	// The same error firing again must not loop: names are already denied.
	await handlers.get("agent_end")?.({ messages: [{ role: "assistant", errorMessage }] }, ctx);
	assert.equal(userMessages.length, 1, "no repeated nudge for an already-handled error");

	// And the loader explains the denial instead of re-loading the tool.
	const after = await loader.execute("call-2", { query: "get_tasks", limit: 5 });
	assert.ok(!after.details?.added?.includes("get_tasks"));
	assert.deepEqual(after.details?.unavailable, ["get_tasks"]);
	assert.match(after.content?.[0]?.text ?? "", /Unavailable here/);
});

test("fresh sessions announce nothing, so session_start restores nothing", () => {
	const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
	let active = ["read"];
	const pi = {
		registerTool() {},
		on(name: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
			handlers.set(name, handler);
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active = [...names];
		},
	} as unknown as ExtensionAPI;
	registerDevspecTools(pi);
	const ctx = { sessionManager: { getBranch: () => [] }, hasUI: false };
	handlers.get("session_start")?.({}, ctx);
	assert.ok(active.includes("get_tasks"));
	assert.ok(active.includes("create_automation"));
	assert.ok(active.includes("search_tasks"), "hot set untouched");
});
