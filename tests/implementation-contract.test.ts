import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	buildImplementationKickoff,
	formatImplementationContext,
	hashContractValue,
	loadImplementationContext,
	resetImplementationContractCache,
	type ImplementationContractLoader,
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
		rules: [
			{ id: "core.claim-before-edit", phase: "claim", requirement: "Claim before editing.", enforcement: "server" },
			{ id: "core.truthful-handoff", phase: "failure", requirement: "Hand work back truthfully.", enforcement: "agent" },
		],
	};
}

function workEntrySection() {
	return {
		schema_version: 1,
		mutation_boundary: "A successful claim_work_item result is required before mutation.",
		explicit_request_authority: "Explicit requests select work but do not replace a server claim.",
		ordered_decisions: [
			{ outcome: "claim_active", requirement: "Claim the active item." },
			{ outcome: "reopen_incomplete", requirement: "Reopen incomplete work rather than duplicating it." },
			{ outcome: "create_linked_follow_up", requirement: "Link follow-up work to its predecessor." },
			{ outcome: "create_new", requirement: "Create only genuinely new work." },
		],
	} as const;
}

/** One self-hashing contract; v3 adds its exact work-entry decision contract. */
function bundle(version = "2.0.0") {
	const input = {
		kind: "devspec.product.implementation_contract",
		schema_version: 1,
		contract_version: version,
		source: SOURCE,
		instruction_boundary: INSTRUCTION_BOUNDARY,
		core_implementation_contract: coreSection(),
		...(version === "3.0.0" ? { work_entry_contract: workEntrySection() } : {}),
	};
	return { ...input, contract_hash: hashContractValue(input) };
}

function resource(version = "2.0.0", payload: unknown = bundle(version)) {
	return { contents: [{ uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI, text: JSON.stringify(payload) }] };
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
		contract_version: "2.0.0",
		resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	};
	const first = await loadImplementationContext({
		reference,
		loader: loader({ resource: resource(), counts }),
	});
	assert.equal(first.source, "resource");
	assert.equal(first.contractHash, bundle().contract_hash);
	assert.match(formatImplementationContext(first), /core\.claim-before-edit/);
	assert.equal(counts.resource, 1);
	// The served document authenticates itself now: no second read to validate a
	// parent hash the projection could not cover (item 6d085535).
	assert.equal(counts.compatibility, 0, "one read is enough — the contract hashes its own content");

	const second = await loadImplementationContext({
		reference,
		loader: loader({ resourceError: new Error("must not read"), counts }),
	});
	assert.equal(second.source, "cache");
	assert.equal(counts.resource, 1, "an exact immutable version is served from the prefix-safe cache");
});

test("cache v5 ignores anything retained by older parser generations", async () => {
	resetImplementationContractCache();
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	const poison = {
		contractVersion: "2.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		rules: [{ id: "poison", requirement: "unvalidated" }],
	};
	for (const legacy of [
		"devspec.pi.implementation-contract.v1",
		"devspec.pi.implementation-contract.v2",
		"devspec.pi.implementation-contract.v3",
		"devspec.pi.implementation-contract.v4",
	]) {
		const legacyKey = Symbol.for(legacy);
		root[legacyKey] = {
			byIdentity: new Map([[`test-authority ${IMPLEMENTATION_CONTRACT_RESOURCE_URI} 2.0.0`, poison]]),
			latestByResource: new Map(),
			verifiedBundleHashes: new Map(),
		};
	}
	try {
		const counts = { resource: 0, compatibility: 0 };
		const context = await loadImplementationContext({
			reference: { contract_version: "2.0.0", resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
			loader: loader({ resource: resource(), counts }),
		});
		assert.equal(context.source, "resource");
		assert.equal(counts.resource, 1);
		assert.doesNotMatch(context.rules.map((rule) => rule.id).join(","), /poison/);
	} finally {
		delete root[Symbol.for("devspec.pi.implementation-contract.v1")];
		delete root[Symbol.for("devspec.pi.implementation-contract.v2")];
		delete root[Symbol.for("devspec.pi.implementation-contract.v3")];
		delete root[Symbol.for("devspec.pi.implementation-contract.v4")];
	}
});

test("cache entries are scoped to the authenticated endpoint/token authority", async () => {
	resetImplementationContractCache();
	const reference = {
		contract_version: "2.0.0",
		resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	};
	await loadImplementationContext({
		reference,
		loader: loader({ resource: resource(), scope: "staging#token-a" }),
	});
	const counts = { resource: 0, compatibility: 0 };
	const second = await loadImplementationContext({
		reference,
		loader: loader({ resource: resource(), scope: "production#token-b", counts }),
	});
	assert.equal(second.source, "resource");
	assert.equal(counts.resource, 1, "another authority must not reuse the first authority's cache");
});

test("uses the get_workflow_rules compatibility bundle when MCP resource reading is unavailable", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({
			resourceError: new Error("resources unsupported"),
			compatibility: { implementation_contract: bundle() },
		}),
	});
	assert.equal(context.source, "compatibility");
	assert.equal(context.contractHash, bundle().contract_hash);
});

test("rejects a resource response whose content URI is not the one contract", async () => {
	resetImplementationContractCache();
	const wrong = {
		contents: [{
			uri: "devspec://product/implementation-contract/unattended",
			text: JSON.stringify(bundle()),
		}],
	};
	const context = await loadImplementationContext({
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({
			resource: wrong,
			compatibilityError: new Error("compatibility unavailable"),
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
	assert.match(context.warning ?? "", /did not return devspec:\/\/product\/implementation-contract/);
});

test("a delivery naming a retired mode-specific resource falls back rather than trusting it", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: {
			contract_version: "1.0.0",
			resource_uri: "devspec://product/implementation-contract/unattended",
		},
		loader: loader({ resource: resource() }),
	});
	assert.equal(context.source, "local_safety_fallback");
	assert.match(context.warning ?? "", /was not devspec:\/\/product\/implementation-contract/);
});

test("no contract and no exact cache retains only a local explanation and cannot start work", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: {
			contract_version: "3.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({
			resource: resource("2.0.0"),
			compatibility: { implementation_contract: bundle("2.0.0") },
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
	const requirements = context.rules.map((rule) => rule.requirement).join("\n");
	assert.match(requirements, /Do not edit until claim_work_item succeeds/);
	assert.match(requirements, /Never force past/);
	// The two rules that used to be the unattended overlay apply unconditionally now.
	assert.match(requirements, /Do not assume a human is present/);
	assert.match(requirements, /fail_work_item or release_work_item/);
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-remote"],
		assignmentId: "assignment-remote",
		context,
		contractReference: {
			contract_version: "3.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
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
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: {
			async cacheScope() { return "generation-one"; },
			async readResource() {
				resourceStarted();
				await gate;
				return resource();
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
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({ resource: resource(), scope: "generation-one", counts }),
	});
	assert.equal(next.source, "resource");
	assert.equal(counts.resource, 1, "revoked preparation must not seed the cache");
});

test("v3 parses and hashes the exact top-level work-entry contract", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: { contract_version: "3.0.0", resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: loader({ resource: resource("3.0.0") }),
	});
	assert.equal(context.source, "resource");
	assert.deepEqual(context.workEntryContract, workEntrySection());
	assert.deepEqual(
		context.workEntryContract?.ordered_decisions.map((decision) => decision.outcome),
		["claim_active", "reopen_incomplete", "create_linked_follow_up", "create_new"],
	);
});

test("v2 remains compatible without synthesizing a work-entry section", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: { contract_version: "2.0.0", resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: loader({ resource: resource("2.0.0") }),
	});
	assert.equal(context.source, "resource");
	assert.equal(context.workEntryContract, undefined);
});

test("v3 rejects malformed, reordered, unhashed, or extra work-entry fields", async (t) => {
	const cases: Array<[string, (section: Record<string, unknown>, root: Record<string, unknown>) => void]> = [
		["missing section", (_section, root) => { delete root.work_entry_contract; }],
		["wrong schema", (section) => { section.schema_version = 2; }],
		["empty mutation boundary", (section) => { section.mutation_boundary = " "; }],
		["empty explicit authority", (section) => { section.explicit_request_authority = ""; }],
		["reordered decisions", (section) => {
			const decisions = section.ordered_decisions as unknown[];
			[decisions[0], decisions[1]] = [decisions[1], decisions[0]];
		}],
		["missing decision", (section) => { (section.ordered_decisions as unknown[]).pop(); }],
		["unknown outcome", (section) => {
			(section.ordered_decisions as Array<Record<string, unknown>>)[0]!.outcome = "delivery_selected";
		}],
		["empty requirement", (section) => {
			(section.ordered_decisions as Array<Record<string, unknown>>)[2]!.requirement = "";
		}],
		["extra section field", (section) => { section.mutable_prose = true; }],
		["extra decision field", (section) => {
			(section.ordered_decisions as Array<Record<string, unknown>>)[0]!.extra = true;
		}],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			resetImplementationContractCache();
			const malformed = JSON.parse(JSON.stringify(bundle("3.0.0"))) as Record<string, unknown>;
			mutate(malformed.work_entry_contract as Record<string, unknown>, malformed);
			// Leave the original hash in place: exact parsing and whole-document hash
			// must both prevent mutable lifecycle prose from drifting independently.
			const context = await loadImplementationContext({
				reference: { contract_version: "3.0.0", resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
				loader: loader({
					resource: resource("3.0.0", malformed),
					compatibilityError: new Error("compatibility unavailable"),
				}),
			});
			assert.equal(context.source, "local_safety_fallback");
		});
	}
});

test("unsupported contract versions fail closed even with internally consistent hashes", async (t) => {
	for (const version of ["1.9.9", "2.0.1", "3.0.1", "4.0.0"]) {
		await t.test(version, async () => {
			resetImplementationContractCache();
			const context = await loadImplementationContext({
				reference: { contract_version: version, resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
				loader: loader({
					resource: resource(version),
					compatibilityError: new Error("compatibility unavailable"),
				}),
			});
			assert.equal(context.source, "local_safety_fallback");
		});
	}
});

test("padded contract values are rejected and never normalized before hashing", async (t) => {
	const cases: Array<[string, (payload: Record<string, unknown>) => void]> = [
		["version", (payload) => { payload.contract_version = " 2.0.0"; }],
		["rule id", (payload) => {
			const rules = (payload.core_implementation_contract as { rules: Array<Record<string, unknown>> }).rules;
			rules[0]!.id = ` ${String(rules[0]!.id)}`;
		}],
		["rule requirement", (payload) => {
			const rules = (payload.core_implementation_contract as { rules: Array<Record<string, unknown>> }).rules;
			rules[0]!.requirement = `${String(rules[0]!.requirement)} `;
		}],
		["v3 mutation boundary", (payload) => {
			(payload.work_entry_contract as Record<string, unknown>).mutation_boundary = " padded ";
		}],
		["v3 decision requirement", (payload) => {
			const decisions = (payload.work_entry_contract as { ordered_decisions: Array<Record<string, unknown>> }).ordered_decisions;
			decisions[0]!.requirement = " padded ";
		}],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			resetImplementationContractCache();
			const version = name.startsWith("v3") ? "3.0.0" : "2.0.0";
			const malformed = JSON.parse(JSON.stringify(bundle(version))) as Record<string, unknown>;
			mutate(malformed);
			malformed.contract_hash = hashContractValue(Object.fromEntries(
				Object.entries(malformed).filter(([key]) => key !== "contract_hash"),
			));
			const context = await loadImplementationContext({
				reference: { contract_version: version, resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
				loader: loader({
					resource: resource(version, malformed),
					compatibilityError: new Error("compatibility unavailable"),
				}),
			});
			assert.equal(context.source, "local_safety_fallback");
		});
	}
});

test("v2 rejects a v3 work-entry section instead of silently ignoring it", async () => {
	resetImplementationContractCache();
	const malformed = JSON.parse(JSON.stringify(bundle("2.0.0"))) as Record<string, unknown>;
	malformed.work_entry_contract = workEntrySection();
	malformed.contract_hash = hashContractValue(Object.fromEntries(
		Object.entries(malformed).filter(([key]) => key !== "contract_hash"),
	));
	const context = await loadImplementationContext({
		reference: { contract_version: "2.0.0", resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: loader({
			resource: resource("2.0.0", malformed),
			compatibilityError: new Error("compatibility unavailable"),
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
});

test("malformed canonical metadata and inconsistent hashes are rejected and never cached", async (t) => {
	const cases: Array<[string, (payload: Record<string, unknown>) => void]> = [
		["kind", (payload) => { payload.kind = "devspec.product.lookalike"; }],
		["schema", (payload) => { payload.schema_version = 2; }],
		["source", (payload) => { payload.source = { authority: "plugin", tier: "product_implementation_contract" }; }],
		["instruction boundary", (payload) => { payload.instruction_boundary = { customer_tiers_excluded: [] }; }],
		["contract hash shape", (payload) => { payload.contract_hash = "sha256:not-a-hash"; }],
		["inconsistent hash", (payload) => { payload.contract_hash = `sha256:${"0".repeat(64)}`; }],
		["a resurrected overlay", (payload) => {
			payload.unattended_overlay = { rules: [{ id: "unattended.x", phase: "claim", requirement: "x", enforcement: "host" }] };
		}],
		["a resurrected mode", (payload) => { payload.execution_mode = "unattended"; }],
		["rule metadata", (payload) => {
			const section = payload.core_implementation_contract as { rules: Array<Record<string, unknown>> };
			section.rules[0]!.phase = "unknown";
		}],
		["extra rule field", (payload) => {
			const section = payload.core_implementation_contract as { rules: Array<Record<string, unknown>> };
			section.rules[0]!.unexpected = "ignored by a permissive parser";
		}],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			resetImplementationContractCache();
			const malformed = JSON.parse(JSON.stringify(bundle())) as Record<string, unknown>;
			mutate(malformed);
			const rejected = await loadImplementationContext({
				reference: {
					contract_version: "2.0.0",
					resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
				},
				loader: loader({
					resource: resource("2.0.0", malformed),
					compatibilityError: new Error("compatibility unavailable"),
				}),
			});
			assert.equal(rejected.source, "local_safety_fallback");

			const counts = { resource: 0, compatibility: 0 };
			const recovered = await loadImplementationContext({
				reference: {
					contract_version: "2.0.0",
					resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
				},
				loader: loader({ resource: resource(), counts }),
			});
			assert.equal(recovered.source, "resource");
			assert.equal(counts.resource, 1, "a rejected payload must not poison the exact cache");
		});
	}
});

test("a resource that fails its own hash falls through to the compatibility bundle", async () => {
	resetImplementationContractCache();
	const contradictory = { ...bundle(), contract_hash: `sha256:${"0".repeat(64)}` };
	const context = await loadImplementationContext({
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({
			resource: resource("2.0.0", contradictory),
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
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({
			resourceError: new Error("resource unavailable"),
			compatibility: { implementation_contract: malformed },
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
});

test("an unversioned delivery may use a fresh canonical read", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: { resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: loader({ resource: resource() }),
	});
	assert.equal(context.source, "resource");
	assert.equal(context.contractVersion, "2.0.0");
});

test("an unversioned delivery may retain the latest validated contract during an outage", async () => {
	// This used to be an attended-only allowance. It never depended on the mode: a
	// delivery that names no version was promised none, so the latest validated
	// contract is exactly what it asked for.
	resetImplementationContractCache();
	await loadImplementationContext({
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({ resource: resource() }),
	});
	const retained = await loadImplementationContext({
		reference: { resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: loader({
			resourceError: new Error("offline"),
			compatibilityError: new Error("offline"),
		}),
	});
	assert.equal(retained.source, "cache");
	assert.match(retained.warning ?? "", /using the retained 2\.0\.0 contract/);
});

test("a versioned delivery is still blocked by an outage — its exact version or nothing", async () => {
	resetImplementationContractCache();
	await loadImplementationContext({
		reference: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({ resource: resource() }),
	});
	const blocked = await loadImplementationContext({
		reference: {
			contract_version: "3.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
		loader: loader({
			resourceError: new Error("offline"),
			compatibilityError: new Error("offline"),
		}),
	});
	assert.equal(blocked.source, "local_safety_fallback");
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-3"],
		assignmentId: "assignment-3",
		context: blocked,
		contractReference: {
			contract_version: "3.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
	}), /remains retryable/);
});

test("a blocked delivery recovers when its exact canonical contract becomes available", async () => {
	resetImplementationContractCache();
	const reference = {
		contract_version: "3.0.0",
		resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	};
	const blocked = await loadImplementationContext({
		reference,
		loader: loader({
			resourceError: new Error("offline"),
			compatibilityError: new Error("offline"),
		}),
	});
	assert.equal(blocked.source, "local_safety_fallback");

	const recovered = await loadImplementationContext({
		reference,
		loader: loader({
			resource: resource("3.0.0"),
			compatibility: { implementation_contract: bundle("3.0.0") },
		}),
	});
	assert.equal(recovered.source, "resource");
	assert.equal(buildImplementationKickoff({
		actionItemIds: ["item-3"],
		assignmentId: "assignment-3",
		context: recovered,
		contractReference: reference,
	}).implementation_contract.contract_version, "3.0.0");
});

test("kickoff carries only work and resolved contract identity — no mode", () => {
	const context = {
		contractVersion: "2.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource" as const,
		rules: [],
	};
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-1"],
		context,
		contractReference: {
			contract_version: "3.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
	}), /version did not match the loaded canonical contract/);
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-1"],
		context,
		contractReference: {
			contract_version: "2.0.0",
			resource_uri: "devspec://product/implementation-contract/attended",
		},
	}), /resource did not match the loaded canonical contract/);
	const kickoff = buildImplementationKickoff({
		actionItemIds: ["item-1", "item-1"],
		assignmentId: "assignment-1",
		context,
	});
	assert.deepEqual(kickoff, {
		kind: "devspec.implementation_kickoff",
		schema_version: 1,
		work: { action_item_ids: ["item-1"], assignment_id: "assignment-1" },
		implementation_contract: {
			contract_version: "2.0.0",
			resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		},
	});
	assert.doesNotMatch(JSON.stringify(kickoff), /attended|execution_mode/);
});
