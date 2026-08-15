import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URIS,
	buildImplementationKickoff,
	formatImplementationContext,
	hashContractValue,
	loadImplementationContext,
	resetImplementationContractCache,
	type ImplementationContractLoader,
	type ImplementationExecutionMode,
} from "../extensions/core/implementation-contract.ts";

const SOURCE = { authority: "devspec_product", tier: "product_implementation_contract" } as const;
const INSTRUCTION_BOUNDARY = {
	customer_tiers_excluded: ["project_custom_instructions", "project_agent_rules", "owner_agent_rules", "live_owner_command"],
	non_overridable: ["all_product_contract_rules"],
	contextual_precedence_high_to_low: ["live_owner_command", "owner_agent_rules", "project_agent_rules", "project_custom_instructions"],
	override_policy: {
		product_contract_rules: "never_override",
		project_shared_repo_safety: "never_weaken",
		other_customer_context: "higher_tier_specializes_lower_tier_when_non_conflicting",
	},
} as const;

function coreSection() {
	return {
		rules: [{ id: "core.claim-before-edit", phase: "claim", requirement: "Claim before editing.", enforcement: "server" }],
	};
}

function modeSection(mode: ImplementationExecutionMode) {
	return {
		rules: [{ id: `${mode}.scope`, phase: "claim", requirement: `${mode} applies to this delivery.`, enforcement: "host" }],
	};
}

function bundle(version = "1.0.0") {
	const input = {
		kind: "devspec.product.implementation_contract",
		schema_version: 1,
		contract_version: version,
		source: SOURCE,
		instruction_boundary: INSTRUCTION_BOUNDARY,
		core_implementation_contract: coreSection(),
		attended_overlay: modeSection("attended"),
		unattended_overlay: modeSection("unattended"),
	} as const;
	return { ...input, contract_hash: hashContractValue(input) };
}

function effective(mode: ImplementationExecutionMode, version = "1.0.0") {
	const input = {
		kind: "devspec.product.effective_implementation_contract",
		schema_version: 1,
		contract_version: version,
		execution_mode: mode,
		source: SOURCE,
		instruction_boundary: INSTRUCTION_BOUNDARY,
		core_implementation_contract: coreSection(),
		mode_overlay: modeSection(mode),
	} as const;
	return {
		...input,
		contract_hash: bundle(version).contract_hash,
		effective_hash: hashContractValue(input),
	};
}

function resource(mode: ImplementationExecutionMode, version = "1.0.0", payload: unknown = effective(mode, version)) {
	return { contents: [{ uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS[mode], text: JSON.stringify(payload) }] };
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
			return input.compatibility ?? { implementation_contract: bundle() };
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
	assert.equal(first.contractHash, bundle().contract_hash);
	assert.match(formatImplementationContext(first), /unattended\.scope/);
	assert.equal(counts.resource, 1);
	assert.equal(counts.compatibility, 1, "the full bundle validates the resource's parent hash once");

	const second = await loadImplementationContext({
		executionMode: "unattended",
		reference,
		loader: loader({ resourceError: new Error("must not read"), counts }),
	});
	assert.equal(second.source, "cache");
	assert.equal(counts.resource, 1, "an exact immutable version is served from the prefix-safe cache");
});

test("strict parser cache v2 ignores contracts retained by the former permissive cache across reload", async () => {
	resetImplementationContractCache();
	const legacyKey = Symbol.for("devspec.pi.implementation-contract.v1");
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	root[legacyKey] = {
		byIdentity: new Map([["test-authority\u0000devspec://product/implementation-contract/unattended\u00001.0.0", {
			executionMode: "unattended",
			contractVersion: "1.0.0",
			resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
			coreRules: [{ id: "poison", requirement: "unvalidated" }],
			modeRules: [{ id: "poison", requirement: "unvalidated" }],
		}]]),
		latestByResource: new Map(),
	};
	try {
		const counts = { resource: 0, compatibility: 0 };
		const context = await loadImplementationContext({
			executionMode: "unattended",
			reference: {
				contract_version: "1.0.0",
				resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
			},
			loader: loader({ resource: resource("unattended"), counts }),
		});
		assert.equal(context.source, "resource");
		assert.equal(counts.resource, 1);
		assert.doesNotMatch(context.coreRules.map((rule) => rule.id).join(","), /poison/);
	} finally {
		delete root[legacyKey];
	}
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
			compatibility: { implementation_contract: bundle() },
		}),
	});
	assert.equal(context.source, "compatibility");
	assert.equal(context.contractHash, bundle().contract_hash);
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

test("no contract and no exact cache retains only a local explanation and cannot start unattended work", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		executionMode: "unattended",
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		},
		loader: loader({
			resource: resource("unattended", "1.0.0"),
			compatibility: { implementation_contract: bundle("1.0.0") },
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
	assert.match(context.coreRules.map((rule) => rule.requirement).join("\n"), /Do not edit until claim_work_item succeeds/);
	assert.match(context.coreRules.map((rule) => rule.requirement).join("\n"), /Never force past/);
	assert.match(context.modeRules.map((rule) => rule.requirement).join("\n"), /fail_work_item or release_work_item/);
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-remote"],
		assignmentId: "assignment-remote",
		context,
		contractReference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		},
	}), /work was not started and remains retryable/);
	assert.match(formatImplementationContext(context), /Local safety fallback/);
});

test("authority revocation during a paused resource read aborts before compatibility or cache side effects", async () => {
	resetImplementationContractCache();
	let current = true;
	let releaseResource!: () => void;
	let resourceStarted!: () => void;
	const started = new Promise<void>((resolve) => { resourceStarted = resolve; });
	const gate = new Promise<void>((resolve) => { releaseResource = resolve; });
	let compatibilityReads = 0;
	const pending = loadImplementationContext({
		executionMode: "unattended",
		reference: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		},
		loader: {
			async cacheScope() { return "generation-one"; },
			async readResource() {
				resourceStarted();
				await gate;
				return resource("unattended");
			},
			async readCompatibilityBundle() {
				compatibilityReads++;
				return { implementation_contract: bundle() };
			},
		},
		assertCurrent: () => {
			if (!current) throw new Error("stale generation");
		},
	});
	await started;
	current = false;
	releaseResource();
	await assert.rejects(pending, /stale generation/);
	assert.equal(compatibilityReads, 0);

	const counts = { resource: 0, compatibility: 0 };
	const next = await loadImplementationContext({
		executionMode: "unattended",
		reference: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		},
		loader: loader({ resource: resource("unattended"), scope: "generation-one", counts }),
	});
	assert.equal(next.source, "resource");
	assert.equal(counts.resource, 1, "revoked preparation must not seed the cache");
});

test("malformed canonical metadata and inconsistent hashes are rejected and never cached", async (t) => {
	const cases: Array<[string, (payload: Record<string, unknown>) => void]> = [
		["kind", (payload) => { payload.kind = "devspec.product.lookalike"; }],
		["schema", (payload) => { payload.schema_version = 2; }],
		["source", (payload) => { payload.source = { authority: "plugin", tier: "product_implementation_contract" }; }],
		["instruction boundary", (payload) => { payload.instruction_boundary = { customer_tiers_excluded: [] }; }],
		["effective hash", (payload) => { payload.effective_hash = `sha256:${"0".repeat(64)}`; }],
		["contract hash shape", (payload) => { payload.contract_hash = "sha256:not-a-hash"; }],
		["unverified parent hash", (payload) => { payload.contract_hash = `sha256:${"0".repeat(64)}`; }],
		["rule metadata", (payload) => {
			const section = payload.core_implementation_contract as { rules: Array<Record<string, unknown>> };
			section.rules[0]!.phase = "unknown";
		}],
		["extra rule field", (payload) => {
			const section = payload.core_implementation_contract as { rules: Array<Record<string, unknown>> };
			section.rules[0]!.unexpected = "ignored by the old projection";
		}],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			resetImplementationContractCache();
			const malformed = JSON.parse(JSON.stringify(effective("unattended"))) as Record<string, unknown>;
			mutate(malformed);
			const rejected = await loadImplementationContext({
				executionMode: "unattended",
				reference: {
					contract_version: "1.0.0",
					resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
				},
				loader: loader({
					resource: resource("unattended", "1.0.0", malformed),
					compatibilityError: new Error("compatibility unavailable"),
				}),
			});
			assert.equal(rejected.source, "local_safety_fallback");

			const counts = { resource: 0, compatibility: 0 };
			const recovered = await loadImplementationContext({
				executionMode: "unattended",
				reference: {
					contract_version: "1.0.0",
					resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
				},
				loader: loader({ resource: resource("unattended"), counts }),
			});
			assert.equal(recovered.source, "resource");
			assert.equal(counts.resource, 1, "a rejected payload must not poison the exact cache");
		});
	}
});

test("a resource with a contradictory parent hash is discarded in favor of the validated bundle", async () => {
	resetImplementationContractCache();
	const contradictory = { ...effective("attended"), contract_hash: `sha256:${"0".repeat(64)}` };
	const context = await loadImplementationContext({
		executionMode: "attended",
		reference: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
		},
		loader: loader({
			resource: resource("attended", "1.0.0", contradictory),
			compatibility: { implementation_contract: bundle() },
		}),
	});
	assert.equal(context.source, "compatibility");
	assert.equal(context.contractHash, bundle().contract_hash);
});

test("compatibility bundle hash inconsistency is rejected", async () => {
	resetImplementationContractCache();
	const malformed = { ...bundle(), contract_hash: `sha256:${"0".repeat(64)}` };
	const context = await loadImplementationContext({
		executionMode: "attended",
		reference: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
		},
		loader: loader({
			resourceError: new Error("resource unavailable"),
			compatibility: { implementation_contract: malformed },
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
});

test("a blocked delivery recovers when its exact canonical contract becomes available", async () => {
	resetImplementationContractCache();
	const reference = {
		contract_version: "2.0.0",
		resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
	};
	const blocked = await loadImplementationContext({
		executionMode: "unattended",
		reference,
		loader: loader({
			resourceError: new Error("offline"),
			compatibilityError: new Error("offline"),
		}),
	});
	assert.equal(blocked.source, "local_safety_fallback");
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-2"],
		assignmentId: "assignment-2",
		context: blocked,
		contractReference: reference,
	}), /remains retryable/);

	const recovered = await loadImplementationContext({
		executionMode: "unattended",
		reference,
		loader: loader({
			resource: resource("unattended", "2.0.0"),
			compatibility: { implementation_contract: bundle("2.0.0") },
		}),
	});
	assert.equal(recovered.source, "resource");
	assert.equal(buildImplementationKickoff({
		actionItemIds: ["item-2"],
		assignmentId: "assignment-2",
		context: recovered,
		contractReference: reference,
	}).implementation_contract.contract_version, "2.0.0");
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
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-1"],
		context,
		contractReference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
		},
	}), /version did not match the loaded canonical contract/);
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-1"],
		context,
		contractReference: {
			contract_version: "1.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.unattended,
		},
	}), /resource did not match the loaded canonical contract/);
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
