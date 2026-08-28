import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setBond } from "../extensions/core/bond-state.ts";
import { buildDevspecInstructions } from "../extensions/core/instructions.ts";
import { jsonSchemaToTypebox } from "../extensions/core/json-schema.ts";
import {
	ACTIVATION_ONLY_VERBS,
	DIRECTED_QUESTION_TOOL_NAME,
	HOT_SET,
	HOT_SET_VERBS,
	PLAN_TOOL_NAME,
	POLL_TOOL_NAME,
	PREFIX_TOKEN_MAX,
	PREFIX_TOKEN_MIN,
	SCOPE_KEY_SET,
	TOOL_LOADER_DESCRIPTION,
	TOOL_LOADER_NAME,
	TOOL_LOADER_PROMPT_METADATA,
	allModelFacingTools,
	estimatePlanToolChars,
	estimatePrefixChars,
	estimatePrefixTokens,
	isCallableModelVerb,
	isHotSetVerb,
	modelFacingSurface,
	rareModelSurface,
	rareModelVerbs,
	searchRareModelTools,
	slimSchema,
	toolLoaderInputSchema,
	withDirectedQuestionToolActive,
	withPlanToolActive,
	withPollToolActive,
} from "../extensions/core/model-surface.ts";
import registerDevspecTools, {
	initialActiveTools,
	modelFacingCatalog,
	stampKnownScope,
} from "../extensions/devspec-tools.ts";
import { MODEL_VERB_NAMES, NEVER_MODEL_VERBS, PUMP_VERBS } from "../extensions/generated/mcp-catalog.ts";

test("hot set is a small everyday slice, not the full catalog", () => {
	assert.ok(HOT_SET_VERBS.length >= 12);
	assert.ok(HOT_SET_VERBS.length <= 18);
	assert.ok(HOT_SET_VERBS.length < MODEL_VERB_NAMES.length);
	for (const name of HOT_SET_VERBS) {
		assert.ok(MODEL_VERB_NAMES.includes(name), `hot set unknown verb ${name}`);
		assert.ok(!PUMP_VERBS.includes(name as (typeof PUMP_VERBS)[number]));
		assert.ok(!NEVER_MODEL_VERBS.includes(name as (typeof NEVER_MODEL_VERBS)[number]));
	}
});

test("everyday work is on the hot set", () => {
	const required = [
		"get_action_item",
		"search_action_items",
		"create_action_item",
		"claim_work_item",
		"record_implementation",
		"search_memories",
		"get_memory",
		"record_memory",
		"resolve_action_item_conflict",
		"record_criterion_verdicts",
		"get_session_transcript",
	];
	for (const name of required) assert.ok(isHotSetVerb(name), `missing everyday verb ${name}`);
});

test("all and only safe generated model verbs are model-facing", () => {
	assert.deepEqual(allModelFacingTools().map((entry) => entry.name), [...MODEL_VERB_NAMES]);
	assert.deepEqual(modelFacingCatalog().map((entry) => entry.name), [...MODEL_VERB_NAMES]);
	for (const name of [...PUMP_VERBS, ...NEVER_MODEL_VERBS]) {
		assert.equal(isCallableModelVerb(name), false, `${name} became model-callable`);
		assert.ok(!modelFacingCatalog().some((entry) => entry.name === name), `${name} was exposed`);
	}
});

test("rare verbs are searchable but not in the initial hot set", () => {
	const rareMustStayOff = [
		"create_playbook",
		"claim_playbook_run",
		"get_claimable_reviews",
		"import_instruction_rules",
		"update_personal_instructions",
		"write_project_instruction_rule",
		"search_sessions",
	];
	for (const name of rareMustStayOff) {
		assert.ok(!HOT_SET.has(name), `${name} leaked into the hot set`);
		assert.ok(rareModelVerbs().includes(name), `${name} missing from deferred tools`);
		assert.ok(isCallableModelVerb(name));
	}
	assert.equal(rareModelSurface().length, MODEL_VERB_NAMES.length - HOT_SET_VERBS.length - ACTIVATION_ONLY_VERBS.size);
	for (const activationOnly of [PLAN_TOOL_NAME, POLL_TOOL_NAME, DIRECTED_QUESTION_TOOL_NAME]) {
		assert.ok(!rareModelVerbs().includes(activationOnly), `${activationOnly} is activation-only, not searchable`);
		assert.ok(!rareModelSurface().some((entry) => entry.name === activationOnly));
	}
	assert.ok(!searchRareModelTools("manage plan shared session execution", 10).some((entry) => entry.name === PLAN_TOOL_NAME));
	assert.ok(!searchRareModelTools("create a session poll", 10).some((entry) => entry.name === POLL_TOOL_NAME));
	assert.ok(!searchRareModelTools("ask a directed question", 10).some((entry) => entry.name === DIRECTED_QUESTION_TOOL_NAME));
});

test("slimmed schemas never ask for stamped scope keys", () => {
	assert.ok(SCOPE_KEY_SET.has("pinned_project_id"), "folder pins are host scope, never model identity");
	for (const entry of allModelFacingTools()) {
		const props = (entry.inputSchema.properties ?? {}) as Record<string, unknown>;
		for (const key of SCOPE_KEY_SET) assert.ok(!(key in props), `${entry.name} still exposes ${key}`);
		const required = (entry.inputSchema.required ?? []) as string[];
		for (const key of SCOPE_KEY_SET) assert.ok(!required.includes(key), `${entry.name} still requires ${key}`);
		assert.ok(entry.description.length <= 160, `${entry.name} description still an essay`);
	}
});

test("slimSchema drops nested scope keys and shortens descriptions", () => {
	const slimmed = slimSchema({
		type: "object",
		properties: {
			title: { type: "string", description: "A long essay. Second sentence stays out." },
			git_remote: { type: "string", description: "never shown" },
			nested: {
				type: "object",
				properties: {
					project_id: { type: "string" },
					ok: { type: "string", description: "Keep me." },
				},
				required: ["project_id", "ok"],
			},
		},
		required: ["title", "git_remote"],
	});
	const props = slimmed.properties as Record<string, Record<string, unknown>>;
	assert.ok(props.title);
	assert.equal(props.git_remote, undefined);
	assert.equal(props.title.description, "A long essay.");
	assert.deepEqual(slimmed.required, ["title"]);
	const nested = props.nested as { properties: Record<string, unknown>; required?: string[] };
	assert.equal(nested.properties.project_id, undefined);
	assert.ok(nested.properties.ok);
	assert.deepEqual(nested.required, ["ok"]);
});

test("natural-language rare-tool search is deterministic and relevance-ranked", () => {
	assert.equal(searchRareModelTools("create a reusable playbook")[0]?.name, "create_playbook");
	assert.equal(
		searchRareModelTools("update my personal instructions")[0]?.name,
		"update_personal_instructions",
	);
	const defaultMatches = searchRareModelTools("what database tables exist?");
	assert.deepEqual(defaultMatches.map((entry) => entry.name), ["get_database_schema"]);
	const first = searchRareModelTools("review playbook work", 7).map((entry) => entry.name);
	const second = searchRareModelTools("review playbook work", 7).map((entry) => entry.name);
	assert.deepEqual(first, second);
	assert.ok(first.length > 1, "an explicit larger limit should load a deliberate tool bundle");
	assert.deepEqual(searchRareModelTools("the and please"), []);
});

test("colloquial requests route across materially different rare tool families", () => {
	const cases = [
		["what tables exist?", "get_database_schema"],
		["give up the work I claimed", "release_work_item"],
		["I could not finish the claimed work", "fail_work_item"],
		["show me recent activity and conversations", "get_recent_sessions"],
		["list action items from one source session in chronological creation order", "get_action_items"],
		["list action items created in this session chronologically", "get_action_items"],
		["chronological action items in a session", "get_action_items"],
		["surface action items into their source session", "surface_session_action_items"],
		["surface chronological action items into this session", "surface_session_action_items"],
		["surface the oldest action items into their source session", "surface_session_action_items"],
		["surface action items created in this session", "surface_session_action_items"],
		["is there anything waiting for me to review?", "get_claimable_reviews"],
		["show my recurring automations", "get_playbooks"],
		["what objectives are we working toward?", "get_project_goals"],
		["what team policies should agents follow?", "get_project_instruction_rules"],
		["resolve an action item contradiction against a decision memory", "resolve_action_item_decision_flag"],
		["clear a contradicts_decision flag on an action item", "resolve_action_item_decision_flag"],
		["session search", "search_sessions"],
		["find conversation", "search_sessions"],
		["search transcripts", "search_sessions"],
		["which session talked about", "search_sessions"],
		["past discussion", "search_sessions"],
	] as const;
	for (const [query, expected] of cases) {
		const match = searchRareModelTools(query, 1)[0];
		assert.equal(match?.name, expected, `${JSON.stringify(query)} routed to ${match?.name}`);
		assert.ok(match.description.length <= 160, `${expected} result was not slimmed`);
	}
});

test("initial activation preserves other tools and contains hot set plus loader only", () => {
	const initial = initialActiveTools(["read", "custom_tool", ...MODEL_VERB_NAMES]);
	assert.ok(initial.includes("read"));
	assert.ok(initial.includes("custom_tool"));
	assert.ok(initial.includes(TOOL_LOADER_NAME));
	for (const name of HOT_SET_VERBS) assert.ok(initial.includes(name));
	for (const name of rareModelVerbs()) assert.ok(!initial.includes(name), `${name} initially active`);
	assert.equal(initial.length, new Set(initial).size);
	assert.ok(!initial.includes(PLAN_TOOL_NAME), "plan schema stays cold until a bonded session or resume projection activates it");
	assert.ok(!initial.includes(POLL_TOOL_NAME), "poll schema stays cold until an attached capable bond activates it");
	assert.ok(!initial.includes(DIRECTED_QUESTION_TOOL_NAME), "question schema stays cold until an attached capable bond activates it");
});

test("directed-question activation is independent, capability-bound, and identity-free", () => {
	const before = ["read", "bash", ...HOT_SET_VERBS, TOOL_LOADER_NAME];
	const active = withDirectedQuestionToolActive(before, true);
	assert.equal(active.at(-1), DIRECTED_QUESTION_TOOL_NAME);
	assert.deepEqual(withDirectedQuestionToolActive(active, true), active);
	assert.deepEqual(withDirectedQuestionToolActive(active, false), before);
	assert.deepEqual(withPlanToolActive(active, true).slice(-2), [DIRECTED_QUESTION_TOOL_NAME, PLAN_TOOL_NAME]);
	assert.equal(withPollToolActive(active, true).at(-1), POLL_TOOL_NAME);
	assert.ok(allModelFacingTools().some((entry) => entry.name === DIRECTED_QUESTION_TOOL_NAME));
	const question = allModelFacingTools().find((entry) => entry.name === DIRECTED_QUESTION_TOOL_NAME)!;
	const properties = question.inputSchema.properties as Record<string, unknown>;
	assert.deepEqual((properties.action as { enum: string[] }).enum, ["create", "list", "get", "cancel"]);
	for (const identity of ["project_id", "session_id", "connection_id", "local_session_id", "responder_user_id"]) {
		assert.equal(properties[identity], undefined, `${identity} must remain capability-derived`);
	}
});

test("plan activation changes only one real schema and reports its before/after prefix cost", () => {
	const before = ["read", "bash", ...HOT_SET_VERBS, TOOL_LOADER_NAME];
	const active = withPlanToolActive(before, true);
	assert.deepEqual(active.slice(0, before.length), before);
	assert.equal(active.at(-1), PLAN_TOOL_NAME);
	assert.deepEqual(withPlanToolActive(active, true), active, "activation is idempotent");
	assert.deepEqual(withPlanToolActive(active, false), before);

	const plan = allModelFacingTools().find((entry) => entry.name === PLAN_TOOL_NAME);
	assert.ok(plan, "generated manage_plan must be a real model tool");
	const properties = plan.inputSchema.properties as Record<string, Record<string, unknown>>;
	assert.deepEqual(properties.action.enum, ["create", "list", "get", "update", "start_step", "complete_step", "skip_step", "fail_step", "advance", "complete", "abandon", "adopt"]);
	assert.ok(properties.steps);
	assert.ok(properties.expected_revision);
	for (const identity of ["project_id", "session_id", "connection_id", "local_session_id"]) {
		assert.equal(properties[identity], undefined, `${identity} must be host/server-derived`);
	}
	const beforeChars = estimatePrefixChars(buildDevspecInstructions());
	const delta = estimatePlanToolChars();
	assert.ok(delta > 1_000, `schema-complete plan delta unexpectedly small: ${delta}`);
	assert.ok(Math.ceil((beforeChars + delta) / 4) <= PREFIX_TOKEN_MAX, "one activated plan schema remains inside the prefix ceiling");
});

test("poll activation is independent, capability-bound, and identity-free", () => {
	const before = ["read", "bash", ...HOT_SET_VERBS, TOOL_LOADER_NAME];
	const active = withPollToolActive(before, true);
	assert.deepEqual(active.slice(0, before.length), before);
	assert.equal(active.at(-1), POLL_TOOL_NAME);
	assert.deepEqual(withPollToolActive(active, true), active, "activation is idempotent");
	assert.deepEqual(withPollToolActive(active, false), before);
	const poll = allModelFacingTools().find((entry) => entry.name === POLL_TOOL_NAME);
	assert.ok(poll, "generated manage_poll must be a real model tool");
	const properties = poll.inputSchema.properties as Record<string, Record<string, unknown>>;
	assert.deepEqual(properties.action.enum, ["create", "list", "get", "update", "end", "retract", "supersede"]);
	assert.ok(properties.expected_revision);
	assert.ok(properties.recommendation_index);
	for (const identity of ["project_id", "session_id", "connection_id", "local_session_id", "owner_user_id", "recommendation_option_id", "origin_connection_id"]) {
		assert.equal(properties[identity], undefined, `${identity} must remain capability-derived`);
	}
});

test("registration exposes complete real schemas and loader activation is purely additive", async () => {
	type ToolDef = {
		name: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: unknown;
		execute: (...args: any[]) => Promise<{ details?: { matches?: string[]; added?: string[] } }>;
	};
	const definitions: ToolDef[] = [];
	const handlers = new Map<string, () => void>();
	let active = ["read", "custom_tool"];
	const setCalls: string[][] = [];
	const pi = {
		registerTool(def: ToolDef) {
			definitions.push(def);
			active.push(def.name);
		},
		on(name: string, handler: () => void) {
			handlers.set(name, handler);
		},
		getActiveTools() {
			return [...active];
		},
		setActiveTools(names: string[]) {
			active = [...names];
			setCalls.push([...names]);
		},
	} as unknown as ExtensionAPI;

	registerDevspecTools(pi);
	assert.deepEqual(
		definitions.map((def) => def.name),
		[...MODEL_VERB_NAMES, TOOL_LOADER_NAME],
	);
	assert.ok(!definitions.some((def) => def.name === "devspec"), "opaque gateway remains registered");
	for (const forbidden of [...PUMP_VERBS, ...NEVER_MODEL_VERBS]) {
		assert.ok(!definitions.some((def) => def.name === forbidden), `${forbidden} registered`);
	}

	for (const rare of rareModelSurface()) {
		const rareDef = definitions.find((def) => def.name === rare.name);
		assert.ok(rareDef, `${rare.name} not registered`);
		assert.deepEqual(rareDef.parameters, jsonSchemaToTypebox(rare.inputSchema));
		assert.equal(rareDef.promptSnippet, undefined, `${rare.name} has an active-only snippet`);
		assert.equal(rareDef.promptGuidelines, undefined, `${rare.name} has active-only guidelines`);
	}
	assert.ok(definitions.find((def) => def.name === HOT_SET_VERBS[0])?.promptSnippet);

	handlers.get("session_start")?.();
	const beforeLoad = [...active];
	assert.deepEqual(
		active.filter((name) => MODEL_VERB_NAMES.includes(name as (typeof MODEL_VERB_NAMES)[number])),
		[...HOT_SET_VERBS],
	);
	assert.ok(active.includes(TOOL_LOADER_NAME));

	const loader = definitions.find((def) => def.name === TOOL_LOADER_NAME);
	assert.ok(loader);
	const result = await loader.execute("call-1", { query: "create a reusable playbook" });
	assert.deepEqual(result.details?.matches, ["create_playbook"]);
	assert.deepEqual(result.details?.added, ["create_playbook"]);
	assert.deepEqual(active.slice(0, beforeLoad.length), beforeLoad, "activation replaced or reordered tools");
	assert.equal(active.at(-1), "create_playbook");
	assert.equal(setCalls.length, 2, "expected initial reset and one additive activation");
});

test("stampKnownScope drops model-supplied scope and adds the bond", () => {
	setBond({ connectionId: "conn-1", sessionId: "sess-1", codename: "Restless Squirrel" });
	const stamped = stampKnownScope({
		title: "hello",
		git_remote: "git@example.com:nope.git",
		project_id: "should-not-pass",
		pinned_project_id: "model-invented-pin",
		session_id: "model-invented",
		local_session_id: "model-invented-local",
	});
	assert.equal(stamped.title, "hello");
	assert.equal(stamped.git_remote, undefined);
	assert.equal(stamped.project_id, undefined);
	assert.equal(stamped.pinned_project_id, undefined);
	assert.equal(stamped.local_session_id, undefined);
	assert.equal(stamped.session_id, "sess-1");
	assert.equal(stamped.connection_id, "conn-1");
	const planScoped = stampKnownScope({
		action: "complete",
		plan_id: "plan-1",
		expected_revision: 4,
		project_id: "model-project",
		pinned_project_id: "model-pin",
		connection_id: "model-connection",
		session_id: "model-session",
	}, PLAN_TOOL_NAME);
	assert.deepEqual(planScoped, { action: "complete", plan_id: "plan-1", expected_revision: 4 });
	const pollScoped = stampKnownScope({
		action: "create",
		question: "Ship tonight?",
		options: ["yes", "no"],
		recommendation_index: 0,
		connection_id: "model-connection",
		session_id: "model-session",
		project_id: "model-project",
	}, POLL_TOOL_NAME);
	assert.deepEqual(pollScoped, {
		action: "create",
		question: "Ship tonight?",
		options: ["yes", "no"],
		recommendation_index: 0,
	});
	setBond(null);
});

test("search_sessions is a schema-complete deferred tool activated by ordinary language", () => {
	const entry = allModelFacingTools().find((tool) => tool.name === "search_sessions");
	assert.ok(entry, "generated catalog must include search_sessions");
	assert.equal(isHotSetVerb("search_sessions"), false);
	assert.ok(rareModelVerbs().includes("search_sessions"));
	const properties = entry.inputSchema.properties as Record<string, unknown>;
	assert.ok(properties.query);
	assert.ok(properties.limit);
	for (const identity of ["project_id", "git_remote", "session_id", "connection_id"]) {
		assert.equal(properties[identity], undefined, `${identity} must remain stamped`);
	}
	assert.deepEqual(entry.inputSchema.required, ["query"]);
	assert.ok(entry.description.length <= 160);
	for (const query of [
		"session search",
		"find conversation",
		"search transcripts",
		"which session talked about",
		"past discussion",
	]) {
		const match = searchRareModelTools(query, 1)[0];
		assert.equal(match?.name, "search_sessions", `${JSON.stringify(query)} routed to ${match?.name}`);
		assert.deepEqual((match.inputSchema.properties as Record<string, unknown>).query, properties.query);
	}
});

test("prefix estimate includes Pi's active snippets and lands in the 2–8k token band", () => {
	const instructions = buildDevspecInstructions();
	const hotTools = modelFacingSurface();
	const schemaChars = JSON.stringify(
		hotTools.map((entry) => ({
			name: entry.name,
			description: entry.description,
			inputSchema: entry.inputSchema,
		})),
	).length;
	const loaderChars = JSON.stringify({
		name: TOOL_LOADER_NAME,
		description: TOOL_LOADER_DESCRIPTION,
		inputSchema: toolLoaderInputSchema(),
	}).length;
	const availableToolLines = [
		...hotTools.map((entry) => `- ${entry.name}: ${entry.promptSnippet}`),
		`- ${TOOL_LOADER_NAME}: ${TOOL_LOADER_PROMPT_METADATA.promptSnippet}`,
	].join("\n");
	assert.equal(
		estimatePrefixChars(instructions),
		schemaChars + loaderChars + instructions.length + availableToolLines.length,
	);

	const tokens = estimatePrefixTokens(instructions);
	assert.ok(tokens >= PREFIX_TOKEN_MIN, `prefix too small to be real: ${tokens}`);
	assert.ok(tokens <= PREFIX_TOKEN_MAX, `prefix still too fat: ${tokens}`);
	assert.deepEqual(hotTools.map((entry) => entry.name), [...HOT_SET_VERBS]);
});
