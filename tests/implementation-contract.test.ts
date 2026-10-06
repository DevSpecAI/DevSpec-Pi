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
		schema_version: 2,
		mutation_boundary: "Choose the tracking shape before implementation mutation.",
		explicit_request_authority: "Explicit current requests select implementation work.",
		tracking_basis: "Choose from durable outcome and material session progress only.",
		tracking_decisions: [
			{ outcome: "both", durable_outcome_required: true, material_session_progress_value: true, requirement: "Track durable work and useful session progress.", examples: ["Durable migration with handoff phases."] },
			{ outcome: "action_item", durable_outcome_required: true, material_session_progress_value: false, requirement: "Track durable work without a session plan.", examples: ["One bounded product fix."] },
			{ outcome: "session_plan", durable_outcome_required: false, material_session_progress_value: true, requirement: "Track material session-only progress.", examples: ["Administrative reconciliation phases."] },
			{ outcome: "neither", durable_outcome_required: false, material_session_progress_value: false, requirement: "Do not track routine work.", examples: ["Read and answer."] },
		],
		plan_threshold: "Create a plan only when material_session_progress_value is true.",
		plan_lifecycle: "Advance atomically, then complete, hand off/adopt, or abandon explicitly.",
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
			multiplicity: "one_or_more",
			validates_link_not_live_claim: true,
		},
		validation: {
			local_outcomes: ["absent", "malformed", "well_formed", "multi_reference"],
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

function authoritySection() {
	const outcomes = (viewer: string, reviewed_contributor: string, contributor: string, maintainer: string, unattended: string) =>
		({ viewer, reviewed_contributor, contributor, maintainer, unattended });
	return {
		schema_version: 1,
		decision: "One function judges every write from the verb, the role and whether the run is unattended.",
		roles: [
			{ role: "viewer", label: "Viewer", meaning: "Sees everything and takes part in the conversation." },
			{ role: "reviewed_contributor", label: "Reviewed Contributor", meaning: "Proposes new shared work and knowledge; a Maintainer reviews it." },
			{ role: "contributor", label: "Contributor", meaning: "Adds to the record; changes to what is settled are proposed." },
			{ role: "maintainer", label: "Maintainer", meaning: "Can overrule the record and accepts proposals." },
		],
		role_source_rule: "The effective project role is judged; an organization Owner or Admin is a Maintainer everywhere.",
		classes: [
			{ class: "talk", meaning: "Takes part in the conversation.", outcomes: outcomes("commit", "commit", "commit", "commit", "commit") },
			{ class: "add", meaning: "Adds to the record.", outcomes: outcomes("deny", "propose", "commit", "commit", "commit") },
			{ class: "overrule", meaning: "Changes what the project has settled.", outcomes: outcomes("deny", "propose", "propose", "commit", "propose") },
		],
		ownership_rule: "A verb may be an overrule only against someone else's row.",
		requester_rule: "A delegated command is judged by the REQUESTER's effective role.",
		unattended_rule: "An unattended run proposes every overrule; attended-versus-unattended is never the axis on its own.",
		proposal_outcome: {
			token: "queued_for_review",
			requirement: "A propose outcome returns queued_for_review with a proposal_id; the target is UNCHANGED until a Maintainer accepts.",
			because: ["unattended_run", "insufficient_role"],
			ledgers: { proposals: "A real queue.", pending: "No queue yet.", none: "Refused." },
		},
		contested_rule: "A queued pair ruling is a pair_judgement proposal and the pair is CONTESTED.",
		flag_ruling_rule: "A queued review-flag ruling is a real proposal and the flag stays lit until a Maintainer accepts it.",
		preview_rule: "A direct overrule shows the exact text first.",
		verbs: [
			{ id: "memory.record", class: "add", scope: "project", unattended: "propose", ledger: "proposals", description: "Record a memory" },
			{ id: "memory.supersede", class: "overrule", scope: "project", unattended: "propose", ledger: "proposals", description: "Supersede a memory" },
		],
	} as const;
}

const CURRENT_CONTRACT_VERSION = "4.5.0";

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
		authority_contract: authoritySection(),
	};
	return { ...input, contract_hash: hashContractValue(input) };
}

/**
 * A served document changed the way DevSpec would change it: the mutation is made
 * and the hash recomputed, so what is tested is the reader, not a hash mismatch.
 */
function served(mutate: (root: Record<string, unknown>) => void, version = CURRENT_CONTRACT_VERSION) {
	const { contract_hash: _hash, ...input } = JSON.parse(JSON.stringify(bundle(version))) as Record<string, unknown>;
	mutate(input);
	return { ...input, contract_hash: hashContractValue(input) };
}

async function load(payload: unknown) {
	resetImplementationContractCache();
	return loadImplementationContext({
		reference: REFERENCE,
		loader: loader({ resource: resource(payload), compatibilityError: new Error("unavailable") }),
	});
}

const UPDATE = /pi update --extensions/;

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

test("mechanically reads, validates, formats, and caches the current v4.3 tracking/plan contract", async () => {
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
	assert.match(formatImplementationContext(first), /material_session_progress_value/);
	assert.match(formatImplementationContext(first), /plan_threshold/);
	assert.equal(counts.compatibility, 0, "the self-hashing resource needs no compatibility read");

	const second = await loadImplementationContext({
		reference: REFERENCE,
		loader: loader({ resourceError: new Error("must not read"), counts }),
	});
	assert.equal(second.source, "cache");
	assert.equal(counts.resource, 1);
});

test("cache v12 ignores every earlier parser generation", async () => {
	resetImplementationContractCache();
	const root = globalThis as typeof globalThis & Record<symbol, unknown>;
	for (const version of ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11"]) {
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

test("the product's contract version is not a compatibility gate; a non-version is refused", async (t) => {
	for (const version of ["3.0.0", "5.0.0", "12.4.1"]) {
		await t.test(`${version} loads`, async () => {
			resetImplementationContractCache();
			const context = await loadImplementationContext({
				reference: { ...REFERENCE, contract_version: version },
				loader: loader({ resource: resource(bundle(version)), compatibilityError: new Error("unavailable") }),
			});
			assert.equal(context.source, "resource");
			assert.equal(context.contractVersion, version);
		});
	}
	for (const version of ["4.2", " 4.2.0"]) {
		await t.test(`${JSON.stringify(version)} is refused`, async () => {
			resetImplementationContractCache();
			const context = await loadImplementationContext({
				reference: { ...REFERENCE, contract_version: version },
				loader: loader({ resource: resource(bundle(version)), compatibilityError: new Error("unavailable") }),
			});
			assert.equal(context.source, "local_safety_fallback");
		});
	}
});

// Item 39c05c1f. From 2026-09-14 to 2026-10-06 every contract DevSpec served
// carried a field inside a section this parser checked exactly, and /devspec.work
// ran on five generic rules the whole time. A change inside one section must cost
// at most that section.
test("changes inside the commit-provenance section never take the contract down", async (t) => {
	const cases: Array<[string, (section: Record<string, unknown>) => void]> = [
		["an extra field", (section) => { section.mutable_policy = true; }],
		["a new schema_version", (section) => { section.schema_version = 2; }],
		["reordered outcomes", (section) => { ((section.validation as { local_outcomes: string[] }).local_outcomes).reverse(); }],
		["a changed value", (section) => { (section.validation as Record<string, unknown>).network_dependency = "required"; }],
		// What DevSpec staging serves until server PR #182 lands, and what it says after.
		["exactly one reference, with the ambiguous outcome", (section) => {
			(section.commit_reference as Record<string, unknown>).multiplicity = "exactly_one";
			(section.validation as Record<string, unknown>).local_outcomes = ["absent", "malformed", "ambiguous", "well_formed"];
		}],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const context = await load(served((root) => mutate(root.commit_provenance_contract as Record<string, unknown>)));
			assert.equal(context.source, "resource");
			assert.equal(context.rules.length, coreSection().rules.length);
			assert.ok(context.workEntryContract);
			assert.ok(context.authorityContract);
			assert.equal(context.warning, undefined, "Pi carries this section without interpreting it");
		});
	}
	await t.test("the section is absent", async () => {
		const context = await load(served((root) => { delete root.commit_provenance_contract; }));
		assert.equal(context.source, "resource");
		assert.equal(context.commitProvenanceContract, undefined);
		assert.ok(context.authorityContract);
	});
});

test("the work-entry section is shown exactly as served, at any schema_version", async (t) => {
	const cases: Array<[string, (section: Record<string, unknown>) => void]> = [
		["a new field", (section) => { section.handoff_rule = "Hand over through the plan."; }],
		["a fifth tracking outcome", (section) => { (section.tracking_decisions as unknown[]).push({ outcome: "watch" }); }],
		["schema_version 3", (section) => { section.schema_version = 3; }],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const payload = served((root) => mutate(root.work_entry_contract as Record<string, unknown>));
			const context = await load(payload);
			assert.equal(context.source, "resource");
			assert.deepEqual(context.workEntryContract, (payload as Record<string, unknown>).work_entry_contract);
			assert.ok(formatImplementationContext(context).includes(JSON.stringify((payload as Record<string, unknown>).work_entry_contract)));
			assert.ok(context.authorityContract);
			assert.equal(context.warning, undefined);
		});
	}
});

test("core rules: an unfamiliar phase is shown, an unreadable rule is skipped and counted", async () => {
	const context = await load(served((root) => {
		const rules = (root.core_implementation_contract as { rules: Array<Record<string, unknown>> }).rules;
		rules[0]!.phase = "review";
		rules[0]!.owner = "agent";
		rules.push({ id: "core.no-text" });
	}));
	assert.equal(context.source, "resource");
	assert.deepEqual(context.rules.map((rule) => rule.id), ["core.claim-early", "core.truthful-handoff"]);
	assert.equal(context.rules[0]!.phase, "review");
	assert.equal(context.skippedRules, 1);
	assert.match(context.warning ?? "", /1 of DevSpec's core rules could not be read/);
	assert.match(context.warning ?? "", UPDATE);
});

test("unreadable core rules: Pi's built-in rules beside the section as served, the rest in force", async () => {
	const context = await load(served((root) => { root.core_implementation_contract = { schema_version: 2, steps: [{ id: "x" }] }; }));
	assert.equal(context.source, "resource");
	assert.ok(context.rules.every((rule) => rule.id.startsWith("pi-fallback.")));
	assert.deepEqual(context.unreadSections?.map((entry) => entry.section), ["core_implementation_contract"]);
	assert.ok(context.authorityContract);
	const text = formatImplementationContext(context);
	assert.match(text, /core_implementation_contract, exactly as DevSpec sent it/);
	assert.ok(text.includes(JSON.stringify({ schema_version: 2, steps: [{ id: "x" }] })));
	assert.match(context.warning ?? "", /could not fully read the core rules/);
	assert.match(context.warning ?? "", /next to Pi's built-in rules/);
	assert.match(context.warning ?? "", UPDATE);
});

test("a section this Pi does not implement is carried as a notice, not a rejection (689d44cb)", async () => {
	// Adding a section to the served contract used to invalidate the whole document
	// and drop Pi to five generic local rules — twice. The served hash still has to
	// cover the part Pi cannot read.
	const context = await load(served((root) => { root.future_section = { schema_version: 1, note: "a section from a newer DevSpec" }; }));
	assert.equal(context.source, "resource");
	assert.equal(context.rules.length, coreSection().rules.length);
	assert.ok(context.workEntryContract);
	assert.ok(context.commitProvenanceContract);
	assert.ok(context.authorityContract);
	assert.deepEqual(context.unknownSections, ["future_section"]);
	assert.match(context.warning ?? "", /future_section/);
	assert.match(context.warning ?? "", /get_workflow_rules/);
	assert.match(context.warning ?? "", UPDATE);
	assert.match(formatImplementationContext(context), /future_section/);
});

test("an unknown section outside the served hash is still refused", async () => {
	resetImplementationContractCache();
	const tampered = { ...bundle(), future_section: { injected: true } };
	const context = await loadImplementationContext({
		reference: REFERENCE,
		loader: loader({ resource: resource(tampered), compatibilityError: new Error("unavailable") }),
	});
	assert.equal(context.source, "local_safety_fallback");
});

test("only a document Pi cannot read at all falls back, and it says what to do; an absent one says unavailable", async (t) => {
	const cases: Array<[string, unknown]> = [
		["a new document format", served((root) => { root.schema_version = 2; })],
		["not DevSpec's product contract", served((root) => { root.source = { authority: "someone_else", tier: "product_implementation_contract" }; })],
		["a hash that does not cover what was served", { ...bundle(), contract_version: "4.9.9" }],
	];
	for (const [name, payload] of cases) {
		await t.test(name, async () => {
			const rejected = await load(payload);
			assert.equal(rejected.source, "local_safety_fallback");
			assert.match(rejected.warning ?? "", /cannot read/);
			assert.match(rejected.warning ?? "", UPDATE);
			assert.doesNotMatch(rejected.warning ?? "", /could not be fetched/);
		});
	}
	await t.test("nothing served", async () => {
		resetImplementationContractCache();
		const offline = await loadImplementationContext({
			reference: REFERENCE,
			loader: loader({ resourceError: new Error("offline"), compatibilityError: new Error("offline") }),
		});
		assert.equal(offline.source, "local_safety_fallback");
		assert.match(offline.warning ?? "", /could not be fetched/);
		assert.doesNotMatch(offline.warning ?? "", UPDATE);
	});
});

test("source metadata and the instruction boundary may grow without refusal", async () => {
	const context = await load(served((root) => {
		(root.source as Record<string, unknown>).served_by = "api";
		((root.instruction_boundary as Record<string, unknown>).customer_tiers_excluded as string[]).push("team_playbooks");
	}));
	assert.equal(context.source, "resource");
	assert.equal(context.warning, undefined);
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

test("an unversioned local delivery retains the latest compatible contract during an outage", async () => {
	resetImplementationContractCache();
	await loadImplementationContext({ reference: REFERENCE, loader: loader({ resource: resource() }) });
	const retained = await loadImplementationContext({
		reference: { resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URI },
		loader: loader({ resourceError: new Error("offline"), compatibilityError: new Error("offline") }),
	});
	assert.equal(retained.source, "cache");
	assert.match(retained.warning ?? "", /retained 4\.5\.0 contract/);
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

test("the authority section is carried to the model", async () => {
	const context = await load(bundle());
	assert.equal(context.source, "resource");
	assert.equal(context.authorityContract?.classes.map((c) => c.class).join(","), "talk,add,overrule");
	assert.equal(context.authorityContract?.proposal_outcome?.token, "queued_for_review");
	const text = formatImplementationContext(context);
	assert.match(text, /Write authority \(authority_contract/);
	assert.match(text, /overrule: .* viewer deny, reviewed contributor propose, contributor propose, maintainer commit, unattended propose/);
	// The class table alone says an `add` commits unattended; the served unattended
	// rule is what makes memory.record a proposal. Both must reach the model, or the
	// summary misstates the write an agent makes most (item 689d44cb).
	assert.match(text, /Ownership rule: A verb may be an overrule only against someone else's row\./);
	assert.match(text, /Unattended rule: An unattended run proposes every overrule/);
	assert.match(text, /Requester rule: A delegated command is judged by the REQUESTER/);
	assert.match(text, /queued_for_review: A propose outcome/);
	assert.match(text, /Contested rulings:/);
	assert.match(text, /Queued review-flag rulings: A queued review-flag ruling/);
	assert.doesNotMatch(text, /preview_rule|Preview rule|role_source_rule/);
});

test("the authority section grows without a Pi release", async (t) => {
	await t.test("a role DevSpec adds is shown with its outcome", async () => {
		const context = await load(served((root) => {
			for (const cls of (root.authority_contract as { classes: Array<{ outcomes: Record<string, string> }> }).classes) cls.outcomes.guest = "deny";
		}));
		assert.equal(context.source, "resource");
		assert.match(formatImplementationContext(context), /talk: .* unattended commit, guest deny\./);
		assert.equal(context.warning, undefined);
	});
	await t.test("a rule DevSpec adds is quoted under its own name", async () => {
		const context = await load(served((root) => {
			(root.authority_contract as Record<string, unknown>).handover_rule = "A run hands its claims back when it stops.";
		}));
		assert.match(formatImplementationContext(context), /- Handover rule: A run hands its claims back when it stops\./);
	});
	await t.test("fields Pi does not show, unfamiliar outcomes and an empty verb list are carried", async () => {
		const context = await load(served((root) => {
			const section = root.authority_contract as Record<string, unknown>;
			section.mutable_policy = true;
			section.verbs = [];
			((section.classes as Array<{ outcomes: Record<string, string> }>)[0]!).outcomes.viewer = "ask";
			(section.proposal_outcome as Record<string, unknown>).token = "pending_review";
		}));
		assert.equal(context.source, "resource");
		const text = formatImplementationContext(context);
		assert.match(text, /talk: .* viewer ask,/);
		assert.match(text, /- pending_review: A propose outcome/);
	});
	await t.test("a rule DevSpec stops serving is simply not shown", async () => {
		const context = await load(served((root) => { delete (root.authority_contract as Record<string, unknown>).contested_rule; }));
		assert.equal(context.source, "resource");
		assert.doesNotMatch(formatImplementationContext(context), /Contested rulings/);
		assert.equal(context.warning, undefined);
	});
});

test("an authority section Pi cannot read is shown as served; every other section stays in force", async (t) => {
	const cases: Array<[string, (section: Record<string, unknown>) => void]> = [
		["schema_version 2", (section) => { section.schema_version = 2; }],
		["a class without its meaning", (section) => { delete ((section.classes as Array<Record<string, unknown>>)[1]!).meaning; }],
		["classes in a new shape", (section) => { section.classes = { talk: "commit" }; }],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const payload = served((root) => mutate(root.authority_contract as Record<string, unknown>)) as Record<string, unknown>;
			const context = await load(payload);
			assert.equal(context.source, "resource");
			assert.equal(context.authorityContract, undefined);
			assert.equal(context.rules.length, coreSection().rules.length);
			assert.ok(context.workEntryContract);
			assert.deepEqual(context.unreadSections, [{ section: "authority_contract", value: payload.authority_contract }]);
			const text = formatImplementationContext(context);
			assert.match(text, /authority_contract, exactly as DevSpec sent it/);
			assert.ok(text.includes(JSON.stringify(payload.authority_contract)));
			assert.match(context.warning ?? "", /could not fully read the rules for who may change the project's record/);
			assert.match(context.warning ?? "", /Everything else is loaded and in force/);
			assert.match(context.warning ?? "", UPDATE);
		});
	}
	await t.test("a section DevSpec stops serving is not a notice", async () => {
		const context = await load(served((root) => { delete root.authority_contract; }));
		assert.equal(context.source, "resource");
		assert.equal(context.authorityContract, undefined);
		assert.equal(context.warning, undefined);
	});
});
