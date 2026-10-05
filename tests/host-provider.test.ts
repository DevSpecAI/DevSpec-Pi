import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyCommitLedgerVerdict,
	stampKnownScope,
	stampHostLocalSession,
	stampHostProvider,
} from "../extensions/devspec-tools.ts";
import { MCP_CATALOG } from "../extensions/generated/mcp-catalog.ts";

const ATTRIBUTION_VERBS = ["claim_work_item", "record_implementation", "record_completed_work"];
const AUTOMATION_VERBS = ["claim_automation_run", "record_automation_run"];
const LOCAL_SESSION_VERBS = ["update_action_item", "record_automation_run", "claim_work_item", "record_implementation"];

test("every attribution verb is stamped with provider=pi", () => {
	for (const name of [...ATTRIBUTION_VERBS, ...AUTOMATION_VERBS]) {
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

test("the host local session wins over model-supplied resume identity", () => {
	for (const name of LOCAL_SESSION_VERBS) {
		const stamped = stampHostLocalSession(name, {
			local_session_id: "model-invented",
			action_item_id: "abc",
		}, "pi-runtime-session");
		assert.equal(stamped.local_session_id, "pi-runtime-session");
		assert.equal(stamped.action_item_id, "abc", "unrelated params must survive");
	}
});

test("verbs that do not carry local session attribution are untouched", () => {
	const params = { local_session_id: "caller-owned" };
	assert.equal(stampHostLocalSession("create_action_item", params, "pi-runtime-session"), params);
});

test("every generated local_session_id input is host stamped", () => {
	const accepting = MCP_CATALOG
		.filter((entry) => Object.hasOwn(entry.inputSchema.properties ?? {}, "local_session_id"))
		.map((entry) => entry.name);
	assert.deepEqual([...accepting].sort(), [...LOCAL_SESSION_VERBS].sort());
	for (const name of accepting) {
		assert.equal(stampHostLocalSession(name, {}, "pi-runtime-session").local_session_id, "pi-runtime-session");
	}
});

test("an explicit full-object verdict carries its message without inventing source attribution", () => {
	const stamped = applyCommitLedgerVerdict({
		commit_sha: "model-sha",
		commit_message: "model message",
		commit_provenance_source: "plugin_stamped",
	}, {
		ok: true,
		sha: "a".repeat(40),
		autoFilled: false,
		commitMessage: "actual commit\n\n[devspec:aaaaaaaa]",
	});
	assert.equal(stamped.commit_sha, "a".repeat(40));
	assert.equal(stamped.commit_message, "actual commit\n\n[devspec:aaaaaaaa]");
	assert.equal(stamped.commit_provenance_source, undefined, "the model cannot invent a host source report");
});

test("models cannot submit either provenance-source reporting field", () => {
	const stamped = stampKnownScope({
		provenance_source: "plugin_stamped",
		commit_provenance_source: "agent_authored",
		commit_sha: "abc1234",
	});
	assert.equal(stamped.provenance_source, undefined);
	assert.equal(stamped.commit_provenance_source, undefined);
	assert.equal(stamped.commit_sha, "abc1234");
});

test("verbs that do not carry provider are untouched", () => {
	const params = { title: "hello" };
	assert.deepEqual(stampHostProvider("create_action_item", params), params);
	assert.equal(stampHostProvider("get_action_items", {}).provider, undefined);
});

test("preferred_provider is an authoring choice and is never overwritten", () => {
	// create_automation/update_automation ask which agent the automation is written
	// FOR — that is the caller's decision, not a fact about this host.
	for (const name of ["create_automation", "update_automation"]) {
		const stamped = stampHostProvider(name, { preferred_provider: "opencode" });
		assert.equal(stamped.preferred_provider, "opencode");
		assert.equal(stamped.provider, undefined);
	}
});

test("every stamped verb really accepts provider, and pi is a legal value", () => {
	// Guards against stamping a verb whose schema has no provider (the server
	// would reject the call) or whose enum has not learned "pi" yet.
	for (const name of [...ATTRIBUTION_VERBS, ...AUTOMATION_VERBS]) {
		const entry = MCP_CATALOG.find((e) => e.name === name);
		assert.ok(entry, `${name} missing from the generated catalog`);
		const props = (entry.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
		const provider = props.provider as { enum?: string[] } | undefined;
		assert.ok(provider, `${name} has no provider property to stamp`);
		// Free-text provider (automation runs) has no enum; an enum must include pi.
		if (provider.enum) {
			assert.ok(provider.enum.includes("pi"), `${name} enum does not accept pi`);
		}
	}
});
