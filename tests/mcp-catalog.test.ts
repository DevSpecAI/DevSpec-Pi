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
		"resolve_action_item_conflict",
		"get_session_transcript",
		"get_action_item_history",
		"classify_criterion",
		"verify_action_item",
	];
	for (const name of required) {
		assert.ok(MODEL_VERB_NAMES.includes(name as (typeof MODEL_VERB_NAMES)[number]), `missing wire verb ${name}`);
		assert.ok(isCallableModelVerb(name), `${name} must stay callable`);
	}
	assert.ok(modelFacingSurface().some((e) => e.name === "record_criterion_verdicts"));
	assert.ok(modelFacingSurface().some((e) => e.name === "get_session_transcript"));
	assert.ok(!modelFacingSurface().some((e) => e.name === "get_action_item_history"));
	assert.ok(!modelFacingSurface().some((e) => e.name === "classify_criterion"));
});

test("connection catalog matches server authority: exact commands and playbook-only delivery", () => {
	const transcript = MCP_CATALOG.find((entry) => entry.name === "get_session_transcript");
	const inbox = MCP_CATALOG.find((entry) => entry.name === "get_connection_dispatch");
	const register = MCP_CATALOG.find((entry) => entry.name === "register_connection");
	const poll = MCP_CATALOG.find((entry) => entry.name === "poll_connection");
	assert.ok(transcript && inbox && register && poll);
	assert.match(transcript.description, /is_controller_instruction/);
	assert.match(transcript.description, /owner or delegated human command/);
	assert.match(inbox.description, /PLAYBOOK RUNS ONLY/);
	assert.match(inbox.description, /never contain action-item work/);
	assert.match(poll.description, /owner-scoped waiting playbook runs only/);
	assert.match(poll.description, /never routed through this array/);
	const pollProperties = (poll.inputSchema as { properties?: Record<string, unknown> }).properties;
	assert.ok(pollProperties?.delegated_scope_version, "poll_connection must advertise delegated scope negotiation");
	assert.ok(pollProperties?.active_plan_projection_version, "poll_connection must advertise active-plan projection negotiation");
	assert.deepEqual(pollProperties.delegated_scope_version, {
		type: "integer",
		enum: [1],
		description: "Explicit delegated project-scope capability negotiation. Version 1 enables delegated commands with per-command project_scope and selects canonical contract 1.2.0 / policy 2026-08-19.3. Omit for the 1.1.0 / 2026-08-19.2 owner-command-compatible shape; a package containing delegated authority returns a retryable upgrade-required tool error before opening any delivery or consuming the prior cursor. Unknown versions fail closed.",
	});
	const registerProperties = (register.inputSchema as { properties?: Record<string, unknown> }).properties;
	assert.deepEqual(registerProperties?.connection_capability_version, {
		type: "number",
		enum: [1],
		description: "Mechanical host negotiation. Version 1 returns a rotated per-connection capability in MCP result _meta; never expose that value to the model.",
	});
	assert.match(register.description, /registration never routes or assigns action-item work/);
	assert.match(register.description, /server alone stamps exact-target command authority and immutable requester provenance/i);
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
	assert.match(poll.description, /DevSpec helper/);
	assert.match(poll.description, /Votes are not commands/);
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
	assert.match(plan.description, /capability negotiated by the host/);
	assert.match(plan.description, /Omit plan_id to target this connection's own active plan/);
	assert.match(plan.description, /supplying plan_id explicitly marks intentional cross-plan targeting/);
	assert.match(plan.description, /Use advance to complete the current milestone, optionally amend, and start the next atomically/);
	assert.match(plan.description, /Adoption succeeds only for an orphaned same-owner plan/);
});

test("every catalog entry has a schema and a name", () => {
	assert.ok(CATALOG_COUNTS.total >= 80);
	for (const entry of MCP_CATALOG) {
		assert.ok(entry.name.length > 0);
		assert.equal(typeof entry.inputSchema, "object");
		assert.ok(entry.inputSchema);
	}
});
