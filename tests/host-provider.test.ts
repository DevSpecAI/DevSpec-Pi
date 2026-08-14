import assert from "node:assert/strict";
import { test } from "node:test";
import { stampHostProvider } from "../extensions/devspec-tools.ts";
import { MCP_CATALOG } from "../extensions/generated/mcp-catalog.ts";

const ATTRIBUTION_VERBS = ["claim_work_item", "record_implementation", "record_completed_work"];
const PLAYBOOK_VERBS = ["get_playbook_runs", "claim_playbook_run", "record_playbook_run"];

test("every attribution verb is stamped with provider=pi", () => {
	for (const name of [...ATTRIBUTION_VERBS, ...PLAYBOOK_VERBS]) {
		assert.equal(stampHostProvider(name, {}).provider, "pi", `${name} was not stamped`);
	}
});

test("the host's identity wins over anything the model supplied", () => {
	// Pi is Pi. A model that names another tool would misattribute Pi's work,
	// so the stamp is applied after the model's params, not merged under them.
	for (const name of ATTRIBUTION_VERBS) {
		const stamped = stampHostProvider(name, { provider: "claude_code", action_item_id: "abc" });
		assert.equal(stamped.provider, "pi");
		assert.equal(stamped.action_item_id, "abc", "unrelated params must survive");
	}
});

test("verbs that do not carry provider are untouched", () => {
	const params = { title: "hello" };
	assert.deepEqual(stampHostProvider("create_action_item", params), params);
	assert.equal(stampHostProvider("get_action_items", {}).provider, undefined);
});

test("preferred_provider is an authoring choice and is never overwritten", () => {
	// create_playbook/update_playbook ask which agent the playbook is written
	// FOR — that is the caller's decision, not a fact about this host.
	for (const name of ["create_playbook", "update_playbook"]) {
		const stamped = stampHostProvider(name, { preferred_provider: "opencode" });
		assert.equal(stamped.preferred_provider, "opencode");
		assert.equal(stamped.provider, undefined);
	}
});

test("every stamped verb really accepts provider, and pi is a legal value", () => {
	// Guards against stamping a verb whose schema has no provider (the server
	// would reject the call) or whose enum has not learned "pi" yet.
	for (const name of [...ATTRIBUTION_VERBS, ...PLAYBOOK_VERBS]) {
		const entry = MCP_CATALOG.find((e) => e.name === name);
		assert.ok(entry, `${name} missing from the generated catalog`);
		const props = (entry.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
		const provider = props.provider as { enum?: string[] } | undefined;
		assert.ok(provider, `${name} has no provider property to stamp`);
		// Free-text provider (playbook runs) has no enum; an enum must include pi.
		if (provider.enum) {
			assert.ok(provider.enum.includes("pi"), `${name} enum does not accept pi`);
		}
	}
});
