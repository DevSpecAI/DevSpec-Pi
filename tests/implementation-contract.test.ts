import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URIS,
	buildImplementationKickoff,
	formatImplementationContext,
	loadImplementationContext,
	resetImplementationContractCache,
	type ImplementationContractLoader,
	type ImplementationExecutionMode,
} from "../extensions/core/implementation-contract.ts";

function effective(mode: ImplementationExecutionMode, version = "1.0.0") {
	return {
		kind: "devspec.product.effective_implementation_contract",
		schema_version: 1,
		contract_version: version,
		contract_hash: "sha256:contract",
		effective_hash: `sha256:${mode}`,
		execution_mode: mode,
		core_implementation_contract: {
			rules: [{ id: "core.claim-before-edit", phase: "claim", requirement: "Claim before editing.", enforcement: "server" }],
		},
		mode_overlay: {
			rules: [{ id: `${mode}.scope`, phase: "claim", requirement: `${mode} applies to this delivery.`, enforcement: "host" }],
		},
	};
}

function resource(mode: ImplementationExecutionMode, version = "1.0.0") {
	return { contents: [{ uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS[mode], text: JSON.stringify(effective(mode, version)) }] };
}

function loader(input: {
	resource?: unknown;
	compatibility?: unknown;
	resourceError?: Error;
	compatibilityError?: Error;
	counts?: { resource: number; compatibility: number };
	scope?: string;
}): ImplementationContractLoader {
	return {
		async cacheScope() { return input.scope ?? "test-authority"; },
		async readResource() {
			if (input.counts) input.counts.resource++;
			if (input.resourceError) throw input.resourceError;
			return input.resource;
		},
		async readCompatibilityBundle() {
			if (input.counts) input.counts.compatibility++;
			if (input.compatibilityError) throw input.compatibilityError;
			return input.compatibility;
		},
	};
}

test("mechanically reads, validates, formats, and caches an exact versioned contract", async () => {
	resetImplementationContractCache();
	const counts = { resource: 0, compatibility: 0 };
	const reference = {
		contract_version: "1.0.0",
		resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
	};
	const first = await loadImplementationContext({
		executionMode: "unattended",
		reference,
		loader: loader({ resource: resource("unattended"), counts }),
	});
	assert.equal(first.source, "resource");
	assert.equal(first.contractHash, "sha256:contract");
	assert.match(formatImplementationContext(first), /unattended\.scope/);
	assert.equal(counts.resource, 1);

	const second = await loadImplementationContext({
		executionMode: "unattended",
		reference,
		loader: loader({ resourceError: new Error("must not read"), counts }),
	});
	assert.equal(second.source, "cache");
	assert.equal(counts.resource, 1, "an exact immutable version is served from the prefix-safe cache");
});

test("cache entries are scoped to the authenticated endpoint/token authority", async () => {
	resetImplementationContractCache();
	const reference = {
		contract_version: "1.0.0",
		resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
	};
	await loadImplementationContext({
		executionMode: "attended",
		reference,
		loader: loader({ resource: resource("attended"), scope: "staging#token-a" }),
	});
	const counts = { resource: 0, compatibility: 0 };
	const second = await loadImplementationContext({
		executionMode: "attended",
		reference,
		loader: loader({ resource: resource("attended"), scope: "production#token-b", counts }),
	});
	assert.equal(second.source, "resource");
	assert.equal(counts.resource, 1, "another authority must not reuse the first authority's cache");
});

test("uses the get_workflow_rules compatibility bundle when MCP resource reading is unavailable", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		executionMode: "attended",
		reference: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
		},
		loader: loader({
			resourceError: new Error("resources unsupported"),
			compatibility: {
				implementation_contract: {
					contract_version: "1.0.0",
					contract_hash: "sha256:bundle",
					core_implementation_contract: effective("attended").core_implementation_contract,
					attended_overlay: effective("attended").mode_overlay,
					unattended_overlay: effective("unattended").mode_overlay,
				},
			},
		}),
	});
	assert.equal(context.source, "compatibility");
	assert.equal(context.contractHash, "sha256:bundle");
	assert.equal(context.executionMode, "attended");
});

test("rejects a resource response whose content URI does not match the requested contract", async () => {
	resetImplementationContractCache();
	const wrong = resource("unattended");
	const context = await loadImplementationContext({
		executionMode: "attended",
		reference: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
		},
		loader: loader({
			resource: wrong,
			compatibilityError: new Error("compatibility unavailable"),
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
	assert.match(context.warning ?? "", /did not return .*attended/);
});

test("fails closed to a tiny local claim-guard core when no authentic contract is available", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		executionMode: "unattended",
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		},
		loader: loader({
			resource: resource("unattended", "1.0.0"),
			compatibility: { implementation_contract: effective("unattended", "1.0.0") },
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
	assert.match(context.coreRules.map((rule) => rule.requirement).join("\n"), /Do not edit until claim_work_item succeeds/);
	assert.match(context.coreRules.map((rule) => rule.requirement).join("\n"), /Never force past/);
	assert.match(context.modeRules.map((rule) => rule.requirement).join("\n"), /fail_work_item or release_work_item/);
	const kickoff = buildImplementationKickoff({
		actionItemIds: ["item-remote"],
		assignmentId: "assignment-remote",
		context,
		contractReference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		},
	});
	assert.equal(kickoff.implementation_contract.contract_version, "2.0.0", "fallback must preserve the authenticated dispatch pointer");
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["legacy-item"],
		assignmentId: "legacy-assignment",
		context,
		contractReference: { resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended },
	}), /legacy implementation kickoff cannot identify a product contract/);
	assert.match(formatImplementationContext(context), /Local safety fallback/);
});

test("kickoff carries only work, explicit mode, and resolved contract identity", () => {
	const context = {
		executionMode: "attended" as const,
		contractVersion: "1.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
		source: "resource" as const,
		coreRules: [],
		modeRules: [],
	};
	assert.deepEqual(buildImplementationKickoff({
		actionItemIds: ["item-1", "item-1"],
		assignmentId: "assignment-1",
		context,
	}), {
		kind: "devspec.implementation_kickoff",
		schema_version: 1,
		work: { action_item_ids: ["item-1"], assignment_id: "assignment-1" },
		execution_mode: "attended",
		implementation_contract: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
		},
	});
});
