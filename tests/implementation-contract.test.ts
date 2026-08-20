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
			{ id: "core.claim-early", phase: "claim", requirement: "Claim early; missing claims never block repository work.", enforcement: "agent" },
			{ id: "core.truthful-handoff", phase: "failure", requirement: "Hand work back truthfully.", enforcement: "agent" },
		],
	};
}

function workEntrySection() {
	return {
		schema_version: 1,
		mutation_boundary: "An explicit implementation request authorizes work independently of claim state.",
		explicit_request_authority: "Explicit current requests select implementation work.",
		ordered_decisions: [
			{ outcome: "claim_active", requirement: "Continue the active item." },
			{ outcome: "reopen_incomplete", requirement: "Reopen incomplete work rather than duplicating it." },
			{ outcome: "create_linked_follow_up", requirement: "Link follow-up work to its predecessor." },
			{ outcome: "create_new", requirement: "Create only genuinely new work." },
		],
	} as const;
}

function provenanceSection() {
	return {
		schema_version: 1,
		authority_boundary: "Act only on Git artifacts the host honestly observes.",
		early_claiming: "Claim early; absence may nudge but never deny.",
		edit_behavior: "Never deny edits, execution, tests, worktrees, delegation, or follow-through for a missing claim.",
		commit_reference: {
			canonical_format: "[devspec:<action-item-uuid>]",
			accepted_local_shapes: ["full_uuid", "eight_character_hex_short_code"],
			multiplicity: "exactly_one",
			validates_link_not_live_claim: true,
		},
		validation: {
			local_outcomes: ["absent", "malformed", "ambiguous", "well_formed"],
			online_outcomes: ["valid", "not_found", "unavailable", "indeterminate"],
			unavailable_result: "allow_and_reconcile",
			indeterminate_result: "allow_and_reconcile",
			definitive_not_found_result: "non_terminating_recovery",
			network_dependency: "optional",
		},
		stamping: "Stamp only an honestly transformable first-class message with one unambiguous claim.",
		push_behavior: "Unknown or unsafe history warns or allows.",
		project_association: "Generic connection never writes the current folder.",
		universal_recovery: "Server ingestion and analyzer remain active for every provider.",
		independent_controls: "Authentication and independent safety controls are unchanged.",
	} as const;
}

const CURRENT_CONTRACT_VERSION = "4.2.0";

function bundle(version = CURRENT_CONTRACT_VERSION) {
	const input = {
		kind: "devspec.product.implementation_contract",
		schema_version: 1,
		contract_version: version,
		source: SOURCE,
		instruction_boundary: INSTRUCTION_BOUNDARY,
		core_implementation_contract: coreSection(),
		work_entry_contract: workEntrySection(),
		commit_provenance_contract: provenanceSection(),
	};
	return { ...input, contract_hash: hashContractValue(input) };
}

function resource(payload: unknown = bundle()) {
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

const REFERENCE = {
	contract_version: CURRENT_CONTRACT_VERSION,
	resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
};

test("mechanically reads, validates, formats, and caches the current v4.2 provenance contract", async () => {
	resetImplementationContractCache();
	const counts = { resource: 0, compatibility: 0 };
	const first = await loadImplementationContext({
		reference: REFERENCE,
		loader: loader({ resource: resource(), counts }),
	});
	assert.equal(first.source, "resource");
	assert.equal(first.contractVersion, CURRENT_CONTRACT_VERSION);
	assert.equal(first.contractHash, bundle().contract_hash);
	assert.deepEqual(first.workEntryContract, workEntrySection());
	assert.deepEqual(first.commitProvenanceContract, provenanceSection());
	assert.match(formatImplementationContext(first), /core\.claim-early/);
	assert.equal(counts.compatibility, 0, "the self-hashing resource needs no compatibility read");

	const second = await loadImplementationContext({
		reference: REFERENCE,
		loader: loader({ resourceError: new Error("must not read"), counts }),
	});
	assert.equal(second.source, "cache");
	assert.equal(counts.resource, 1);
});

test("cache v6 ignores every pre-cutover parser generation", async () => {
	resetImplementationContractCache();
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	for (const version of ["v1", "v2", "v3", "v4", "v5"]) {
		root[Symbol.for(`devspec.pi.implementation-contract.${version}`)] = {
			byIdentity: new Map([["poison", { contractVersion: "3.0.0", rules: [{ id: "poison" }] }]]),
			latestByResource: new Map(),
		};
	}
	const counts = { resource: 0, compatibility: 0 };
	const context = await loadImplementationContext({
		reference: REFERENCE,
		loader: loader({ resource: resource(), counts }),
	});
	assert.equal(context.source, "resource");
	assert.equal(counts.resource, 1);
	assert.doesNotMatch(context.rules.map((rule) => rule.id).join(","), /poison/);
});

test("resource fallback accepts only the same exact v4-compatible bundle", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: REFERENCE,
		loader: loader({
			resourceError: new Error("resource unsupported"),
			compatibility: { implementation_contract: bundle() },
		}),
	});
	assert.equal(context.source, "compatibility");
	assert.equal(context.contractHash, bundle().contract_hash);
});

test("older compatible v4 contract versions remain dynamically consumable", async () => {
	resetImplementationContractCache();
	const version = "4.0.0";
	const context = await loadImplementationContext({
		reference: { ...REFERENCE, contract_version: version },
		loader: loader({ resource: resource(bundle(version)) }),
	});
	assert.equal(context.source, "resource");
	assert.equal(context.contractVersion, version);
});

test("non-v4 and malformed versions are rejected by the schema-v1 compatibility boundary", async (t) => {
	for (const version of ["2.0.0", "3.0.0", "5.0.0", "4.2", " 4.2.0"]) {
		await t.test(version, async () => {
			resetImplementationContractCache();
			const context = await loadImplementationContext({
				reference: { ...REFERENCE, contract_version: version },
				loader: loader({
					resource: resource(bundle(version)),
					compatibilityError: new Error("unavailable"),
				}),
			});
			assert.equal(context.source, "local_safety_fallback");
		});
	}
});

test("malformed, reordered, or extra provenance fields fail exact parsing", async (t) => {
	const cases: Array<[string, (section: Record<string, unknown>, root: Record<string, unknown>) => void]> = [
		["missing section", (_section, root) => { delete root.commit_provenance_contract; }],
		["wrong schema", (section) => { section.schema_version = 2; }],
		["extra field", (section) => { section.mutable_policy = true; }],
		["reordered local outcomes", (section) => {
			const validation = section.validation as { local_outcomes: string[] };
			validation.local_outcomes.reverse();
		}],
		["network dependency", (section) => {
			(section.validation as Record<string, unknown>).network_dependency = "required";
		}],
		["claim validation", (section) => {
			(section.commit_reference as Record<string, unknown>).validates_link_not_live_claim = false;
		}],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			resetImplementationContractCache();
			const malformed = JSON.parse(JSON.stringify(bundle())) as Record<string, unknown>;
			mutate(malformed.commit_provenance_contract as Record<string, unknown>, malformed);
			const context = await loadImplementationContext({
				reference: REFERENCE,
				loader: loader({
					resource: resource(malformed),
					compatibilityError: new Error("unavailable"),
				}),
			});
			assert.equal(context.source, "local_safety_fallback");
		});
	}
});

test("offline fallback is fail-open and still builds the immutable work kickoff", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: REFERENCE,
		loader: loader({
			resourceError: new Error("offline"),
			compatibilityError: new Error("offline"),
		}),
	});
	assert.equal(context.source, "local_safety_fallback");
	const requirements = context.rules.map((rule) => rule.requirement).join("\n");
	assert.match(requirements, /absent claim never blocks local repository work/i);
	assert.match(requirements, /server reconciliation/i);
	assert.doesNotMatch(requirements, /Do not edit until|stop and retry/i);
	const kickoff = buildImplementationKickoff({
		actionItemIds: ["item-local"],
		context,
		contractReference: REFERENCE,
	});
	assert.equal(kickoff.implementation_contract.contract_version, CURRENT_CONTRACT_VERSION);
	assert.match(formatImplementationContext(context), /Local fail-open fallback/);
});

test("an unversioned local delivery retains the latest compatible v4 contract during an outage", async () => {
	resetImplementationContractCache();
	await loadImplementationContext({ reference: REFERENCE, loader: loader({ resource: resource() }) });
	const retained = await loadImplementationContext({
		reference: { resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: loader({ resourceError: new Error("offline"), compatibilityError: new Error("offline") }),
	});
	assert.equal(retained.source, "cache");
	assert.match(retained.warning ?? "", /retained 4\.2\.0 contract/);
});

test("wrong resource pointers never become trusted but remain non-blocking guidance", async () => {
	resetImplementationContractCache();
	const context = await loadImplementationContext({
		reference: {
			contract_version: CURRENT_CONTRACT_VERSION,
			resource_uri: "devspec://product/implementation-contract/unattended",
		},
		loader: loader({ resource: resource() }),
	});
	assert.equal(context.source, "local_safety_fallback");
	assert.match(context.warning ?? "", /was not devspec:\/\/product\/implementation-contract/);
});

test("kickoff validates canonical resource/version and carries no execution mode", () => {
	const context = {
		contractVersion: CURRENT_CONTRACT_VERSION,
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource" as const,
		rules: [],
	};
	assert.throws(() => buildImplementationKickoff({
		actionItemIds: ["item-1"],
		context,
		contractReference: { ...REFERENCE, contract_version: "4.2.1" },
	}), /version did not match/);
	const kickoff = buildImplementationKickoff({
		actionItemIds: ["item-1", "item-1"],
		context,
	});
	assert.deepEqual(kickoff.work, { action_item_ids: ["item-1"] });
	assert.equal(kickoff.implementation_contract.contract_version, CURRENT_CONTRACT_VERSION);
	assert.doesNotMatch(JSON.stringify(kickoff), /assignment|attended|execution_mode/);
});
