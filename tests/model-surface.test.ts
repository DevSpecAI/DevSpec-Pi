import assert from "node:assert/strict";
import { test } from "node:test";
import { setBond } from "../extensions/core/bond-state.ts";
import { buildDevspecInstructions } from "../extensions/core/instructions.ts";
import {
	GATEWAY_TOOL_NAME,
	HOT_SET,
	HOT_SET_VERBS,
	PREFIX_TOKEN_MAX,
	SCOPE_KEY_SET,
	estimatePrefixTokens,
	gatewayInputSchema,
	isCallableModelVerb,
	isHotSetVerb,
	modelFacingSurface,
	rareModelVerbs,
	resolveGatewayVerb,
	slimSchema,
} from "../extensions/core/model-surface.ts";
import { modelFacingCatalog, stampKnownScope } from "../extensions/devspec-tools.ts";
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
	for (const name of required) {
		assert.ok(isHotSetVerb(name), `missing everyday verb ${name}`);
	}
});

test("rare verbs are not in the always-on hot set", () => {
	const rareMustStayOff = [
		"create_playbook",
		"claim_playbook_run",
		"get_claimable_reviews",
		"import_instruction_rules",
		"update_personal_instructions",
		"write_project_instruction_rule",
	];
	for (const name of rareMustStayOff) {
		assert.ok(!HOT_SET.has(name), `${name} leaked into the hot set`);
		assert.ok(rareModelVerbs().includes(name), `${name} missing from the gateway enum`);
		assert.ok(isCallableModelVerb(name));
	}
	assert.ok(!isCallableModelVerb("post_session_message"));
	assert.ok(!isCallableModelVerb("register_connection"));
});

test("slimed schemas never ask for stamped scope keys", () => {
	for (const entry of modelFacingSurface()) {
		const props = (entry.inputSchema.properties ?? {}) as Record<string, unknown>;
		for (const key of SCOPE_KEY_SET) {
			assert.ok(!(key in props), `${entry.name} still exposes ${key}`);
		}
		const required = (entry.inputSchema.required ?? []) as string[];
		for (const key of SCOPE_KEY_SET) {
			assert.ok(!required.includes(key), `${entry.name} still requires ${key}`);
		}
		assert.ok(entry.description.length <= 160, `${entry.name} description still an essay`);
	}
});

test("slimSchema drops nested scope keys and shortens descriptions", () => {
	const slimed = slimSchema({
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
	const props = slimed.properties as Record<string, Record<string, unknown>>;
	assert.ok(props.title);
	assert.equal(props.git_remote, undefined);
	assert.equal(props.title.description, "A long essay.");
	assert.deepEqual(slimed.required, ["title"]);
	const nested = props.nested as { properties: Record<string, unknown>; required?: string[] };
	assert.equal(nested.properties.project_id, undefined);
	assert.ok(nested.properties.ok);
	assert.deepEqual(nested.required, ["ok"]);
});

test("gateway enum is the rare set and excludes the hot set", () => {
	const schema = gatewayInputSchema();
	const verb = (schema.properties as { verb: { enum: string[] } }).verb;
	assert.deepEqual(new Set(verb.enum), new Set(rareModelVerbs()));
	for (const name of HOT_SET_VERBS) {
		assert.ok(!verb.enum.includes(name));
	}
	assert.equal(GATEWAY_TOOL_NAME, "devspec");
});

test("gateway verb resolver refuses hot-set and pump verbs", () => {
	assert.deepEqual(resolveGatewayVerb("create_playbook"), { ok: true, verb: "create_playbook" });
	assert.equal(resolveGatewayVerb("get_action_item").ok, false);
	assert.equal(resolveGatewayVerb("post_session_message").ok, false);
	assert.equal(resolveGatewayVerb("register_connection").ok, false);
	assert.equal(resolveGatewayVerb("").ok, false);
});

test("stampKnownScope drops model-supplied scope and adds the bond", () => {
	setBond({
		connectionId: "conn-1",
		sessionId: "sess-1",
		codename: "Restless Squirrel",
	});
	const stamped = stampKnownScope({
		title: "hello",
		git_remote: "git@example.com:nope.git",
		project_id: "should-not-pass",
		session_id: "model-invented",
	});
	assert.equal(stamped.title, "hello");
	assert.equal(stamped.git_remote, undefined);
	assert.equal(stamped.project_id, undefined);
	assert.equal(stamped.session_id, "sess-1");
	assert.equal(stamped.connection_id, "conn-1");
	setBond(null);
});

test("modelFacingCatalog is the hot set only", () => {
	const names = modelFacingCatalog().map((e) => e.name);
	assert.deepEqual(names, [...HOT_SET_VERBS]);
	assert.ok(!names.includes("post_session_message"));
	assert.ok(!names.includes("create_playbook"));
});

test("prefix estimate lands in the 2–8k token band", () => {
	const tokens = estimatePrefixTokens(buildDevspecInstructions());
	assert.ok(tokens >= 1500, `prefix too small to be real: ${tokens}`);
	assert.ok(tokens <= PREFIX_TOKEN_MAX, `prefix still too fat: ${tokens}`);
});
