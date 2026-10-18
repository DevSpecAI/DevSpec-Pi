import assert from "node:assert/strict";
import { test } from "node:test";
import { isCallableModelVerb, modelFacingSurface } from "../extensions/core/model-surface.ts";
import { modelFacingCatalog } from "../extensions/devspec-tools.ts";
import {
	CATALOG_COUNTS,
	MCP_CATALOG,
	MODEL_VERB_NAMES,
	NEVER_MODEL_VERBS,
	PUMP_VERBS,
} from "../extensions/generated/mcp-catalog.ts";

test("memory reads expose optional history continuation on the native and wire surfaces", () => {
	const entry = MCP_CATALOG.find(e => e.name === "get_memory")!;
	for (const schema of [entry.inputSchema, entry.modelInputSchema]) {
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		assert.equal(properties.history_before?.type, "string");
		assert.equal(properties.history_limit?.maximum, 100);
		assert.deepEqual(schema.required, ["id"]);
	}
	assert.match(entry.description, /history_next_before/);
});

test("memory reads expose independent optional evidence continuation without enabling requirement writes", () => {
	const entry = MCP_CATALOG.find(e => e.name === "get_memory")!;
	for (const schema of [entry.inputSchema, entry.modelInputSchema]) {
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		assert.equal(properties.evidence_before?.type, "string");
		assert.equal(properties.evidence_before?.format, "uuid");
		assert.equal(properties.evidence_limit?.minimum, 1);
		assert.equal(properties.evidence_limit?.maximum, 100);
		assert.deepEqual(schema.required, ["id"]);
	}
	const writer = MCP_CATALOG.find(e => e.name === "record_memory")!;
	const types = (writer.inputSchema.properties as Record<string, { enum?: string[] }>).type.enum!;
	assert.ok(!types.includes("requirement"));
});

test("catalog classifies every host-only pump verb as non-model", () => {
	for (const name of PUMP_VERBS) {
		const entry = MCP_CATALOG.find((e) => e.name === name);
		assert.ok(entry, `missing pump verb ${name}`);
		assert.equal(entry.kind, "pump");
		assert.ok(!MODEL_VERB_NAMES.includes(name as (typeof MODEL_VERB_NAMES)[number]));
	}
	assert.equal(CATALOG_COUNTS.pump, PUMP_VERBS.length);
	assert.ok(PUMP_VERBS.includes("report_commit_provenance"));
});

test("post_session_message is never a model-facing tool", () => {
	assert.ok(NEVER_MODEL_VERBS.includes("post_session_message"));
	assert.ok(!modelFacingCatalog().some((e) => e.name === "post_session_message"));
	assert.ok(!isCallableModelVerb("post_session_message"));
});

test("catalog remains the complete wire map", () => {
	const required = [
		"record_criterion_verdicts",
		"supersede_task",
		"get_session_transcript",
		"search_sessions",
		"get_task_history",
		"classify_criterion",
		"verify_task",
	];
	for (const name of required) {
		assert.ok(MODEL_VERB_NAMES.includes(name as (typeof MODEL_VERB_NAMES)[number]), `missing wire verb ${name}`);
		assert.ok(isCallableModelVerb(name), `${name} must stay callable`);
	}
	assert.ok(modelFacingSurface().some((e) => e.name === "record_criterion_verdicts"));
	assert.ok(modelFacingSurface().some((e) => e.name === "get_session_transcript"));
	assert.ok(modelFacingSurface().some((e) => e.name === "search_sessions"));
	assert.ok(modelFacingSurface().some((e) => e.name === "get_task_history"));
	assert.ok(modelFacingSurface().some((e) => e.name === "classify_criterion"));
});

test("connection catalog matches server authority: exact commands and automation-only delivery", () => {
	const transcript = MCP_CATALOG.find((entry) => entry.name === "get_session_transcript");
	const inbox = MCP_CATALOG.find((entry) => entry.name === "get_connection_dispatch");
	const register = MCP_CATALOG.find((entry) => entry.name === "register_connection");
	const poll = MCP_CATALOG.find((entry) => entry.name === "poll_connection");
	assert.ok(transcript && inbox && register && poll);
	const pollProperties = (poll.inputSchema as { properties?: Record<string, unknown> }).properties;
	assert.ok(pollProperties?.delegated_scope_version, "poll_connection must advertise delegated scope negotiation");
	assert.ok(pollProperties?.active_plan_projection_version, "poll_connection must advertise active-plan projection negotiation");
	assert.deepEqual((pollProperties.delegated_scope_version as { enum?: unknown[] }).enum, [1]);
	const registerProperties = (register.inputSchema as { properties?: Record<string, unknown> }).properties;
	assert.deepEqual((registerProperties?.connection_capability_version as { enum?: unknown[] } | undefined)?.enum, [1]);
	const catalogText = JSON.stringify(MCP_CATALOG);
	assert.doesNotMatch(catalogText, /exact assignment id|ready to receive connection-native work dispatches|assignment routing hints/i);
});

test("generated manage_poll wire map is schema-complete and model-facing", () => {
	const poll = MCP_CATALOG.find((entry) => entry.name === "manage_poll");
	assert.ok(poll);
	assert.equal(poll.kind, "model");
	const properties = (poll.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties;
	assert.deepEqual(properties?.action.enum, ["create", "list", "get", "update", "end", "retract", "supersede"]);
	for (const field of ["poll_id", "expected_revision", "question", "options", "recommendation_index", "reason"]) {
		assert.ok(properties?.[field], `manage_poll missing ${field}`);
	}
	const keys = Object.keys(properties ?? {});
	for (const identity of ["connection_id", "session_id", "owner_user_id", "recommendation_option_id", "origin_connection_id"]) {
		assert.ok(!keys.includes(identity), `${identity} must not be a model argument`);
	}
});

test("generated manage_plan wire map is schema-complete and model-facing", () => {
	const plan = MCP_CATALOG.find((entry) => entry.name === "manage_plan");
	assert.ok(plan);
	assert.equal(plan.kind, "model");
	const properties = (plan.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties;
	assert.deepEqual(properties?.action.enum, ["create", "list", "get", "update", "start_step", "complete_step", "skip_step", "fail_step", "advance", "complete", "abandon", "adopt"]);
	for (const field of ["plan_id", "expected_revision", "title", "steps", "step_id", "current_step_id", "next_step_id", "reason", "retryable"]) {
		assert.ok(properties?.[field], `manage_plan missing ${field}`);
	}
});

test("every catalog entry has a schema and a name", () => {
	assert.ok(CATALOG_COUNTS.total >= 80);
	for (const entry of MCP_CATALOG) {
		assert.ok(entry.name.length > 0);
		assert.equal(typeof entry.inputSchema, "object");
		assert.ok(entry.inputSchema);
	}
});
