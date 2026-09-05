import { createHash } from "node:crypto";
import { resolveEndpoint } from "./auth-store.ts";
import { callDevspec, MODEL_TIMEOUT_MS, readDevspecResource } from "./client.ts";
import { unwrapMcpResult } from "./result.ts";

/**
 * The product implementation contract, as Pi loads and verifies it.
 *
 * THERE IS NO EXECUTION MODE (DevSpec item 6d085535). DevSpec used to serve two
 * resources — `…/attended` and `…/unattended` — each a projection of one core
 * contract plus a mode overlay, and a delivery named which projection applied.
 * Both are gone: the overlays collapsed into core, the projection went with them,
 * and there is one document at one URI.
 *
 * That removes a whole verification dance as well as a concept. A projection could
 * not authenticate its own parent (`effective_hash` deliberately excluded
 * `contract_hash`), so Pi had to read the compatibility bundle once per
 * authority/version just to confirm the parent hash it had been handed. The served
 * document now hashes its own entire content, so one read verifies itself and the
 * compatibility bundle is only a fallback for a host that cannot read resources.
 *
 * Nothing replaced the mode — no timeout, no patience window, no ask-policy. The
 * rules that used to live in the unattended overlay ("do not assume a human is
 * present", "hand work back truthfully") were never about who was watching, so they
 * are simply core rules now, and the local safety fallback below carries them
 * unconditionally.
 */

export const IMPLEMENTATION_CONTRACT_RESOURCE_URI = "devspec://product/implementation-contract";

export interface ImplementationContractReference {
	contract_version?: string;
	resource_uri: string;
}

export interface ImplementationKickoff {
	kind: "devspec.implementation_kickoff";
	schema_version: 1;
	work: {
		action_item_ids: string[];
	};
	implementation_contract: {
		contract_version: string;
		resource_uri: string;
	};
}

export interface ImplementationRule {
	id: string;
	phase?: string;
	requirement: string;
	enforcement?: string;
}

export type WorkEntryOutcome =
	| "claim_active"
	| "reopen_incomplete"
	| "create_linked_follow_up"
	| "create_new";

export type TrackingDecisionOutcome = "action_item" | "session_plan" | "both" | "neither";

export interface TrackingDecision {
	outcome: TrackingDecisionOutcome;
	durable_outcome_required: boolean;
	material_session_progress_value: boolean;
	requirement: string;
	examples: string[];
}

export interface WorkEntryContract {
	schema_version: 1 | 2;
	mutation_boundary: string;
	explicit_request_authority: string;
	tracking_basis?: string;
	tracking_decisions?: TrackingDecision[];
	plan_threshold?: string;
	plan_lifecycle?: string;
	ordered_decisions: Array<{
		outcome: WorkEntryOutcome;
		requirement: string;
	}>;
}

export interface CommitProvenanceContract {
	schema_version: 1;
	authority_boundary: string;
	early_claiming: string;
	edit_behavior: string;
	commit_reference: {
		canonical_format: "[devspec:<action-item-uuid>]";
		accepted_local_shapes: ["full_uuid", "eight_character_hex_short_code"];
		multiplicity: "exactly_one";
		validates_link_not_live_claim: true;
	};
	validation: {
		local_outcomes: ["absent", "malformed", "ambiguous", "well_formed"];
		online_outcomes: ["valid", "not_found", "unavailable", "indeterminate"];
		unavailable_result: "allow_and_reconcile";
		indeterminate_result: "allow_and_reconcile";
		definitive_not_found_result: "non_terminating_recovery";
		network_dependency: "optional";
	};
	stamping: string;
	push_behavior: string;
	project_association: string;
	universal_recovery: string;
	independent_controls: string;
}

/**
 * Who may change the project's record (DevSpec item ff803a1a). Served beside the
 * work-entry and commit-provenance sections from contract 4.4.0; Pi shows it to the
 * model and relays its proposal outcome, and never restates it in its own prose.
 */
export type AuthorityWriteClass = "talk" | "add" | "overrule";
export type AuthorityWriteOutcome = "commit" | "propose" | "deny";

export interface AuthorityContract {
	schema_version: 1;
	decision: string;
	roles: Array<{ role: string; label: string; meaning: string }>;
	role_source_rule: string;
	classes: Array<{
		class: AuthorityWriteClass;
		meaning: string;
		outcomes: Record<"guest" | "contributor" | "maintainer" | "unattended", AuthorityWriteOutcome>;
	}>;
	ownership_rule: string;
	requester_rule: string;
	unattended_rule: string;
	proposal_outcome: {
		token: "queued_for_review";
		requirement: string;
		because: string[];
		ledgers: Record<string, string>;
	};
	contested_rule: string;
	preview_rule: string;
	verbs: Array<{
		id: string;
		class: AuthorityWriteClass;
		scope: string;
		unattended: string;
		ledger: string;
		overrule_when?: string;
		description: string;
	}>;
}

export interface ImplementationContractContext {
	contractVersion: string;
	contractHash?: string;
	resourceUri: string;
	source: "resource" | "compatibility" | "cache" | "local_safety_fallback";
	rules: ImplementationRule[];
	workEntryContract?: WorkEntryContract;
	commitProvenanceContract?: CommitProvenanceContract;
	authorityContract?: AuthorityContract;
	/**
	 * Top-level sections this Pi does not implement, present in the document it
	 * verified. Not an error — see `parseContractBundle`.
	 */
	unknownSections?: string[];
	warning?: string;
}

export interface ImplementationContractLoader {
	/** Stable, non-secret authority identity (endpoint + token fingerprint). */
	cacheScope(): Promise<string>;
	readResource(uri: string): Promise<unknown>;
	readCompatibilityBundle(): Promise<unknown>;
}

interface CachedContract extends Omit<ImplementationContractContext, "source" | "warning"> {}

interface ContractCache {
	byIdentity: Map<string, CachedContract>;
	latestByResource: Map<string, CachedContract>;
}

// v7 added the canonical work-entry v2 tracking/plan boundary; v8 added the
// authority_contract section (contract 4.4.0); v9 records unknown top-level
// sections instead of rejecting the document for carrying one. Older parser
// caches cannot authorize: they either did not validate those sections, or
// carry no record of a section this generation would have warned about.
const CACHE_KEY = Symbol.for("devspec.pi.implementation-contract.v9");

function cache(): ContractCache {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	const current = root[CACHE_KEY];
	if (!current || !(current.byIdentity instanceof Map) || !(current.latestByResource instanceof Map)) {
		root[CACHE_KEY] = {
			byIdentity: new Map(),
			latestByResource: new Map(),
		};
	}
	return root[CACHE_KEY]!;
}

function cacheIdentity(scope: string, resourceUri: string, contractVersion: string): string {
	return `${scope}\0${resourceUri}\0${contractVersion}`;
}

function latestIdentity(scope: string, resourceUri: string): string {
	return `${scope}\0${resourceUri}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Contract fields are canonical data: padding is invalid, not normalized. */
function exactContractString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value === value.trim() ? value : undefined;
}

const CONTRACT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
/** Schema v1 contracts remain compatible within the product's v4 major line. */
const CONTRACT_VERSION_PATTERN = /^4\.\d+\.\d+$/;
const RULE_PHASES = new Set([
	"discovery", "claim", "implementation", "verification", "delivery", "completion", "failure", "governance",
]);
const RULE_ENFORCEMENTS = new Set(["server", "host", "agent", "human"]);
const WORK_ENTRY_OUTCOMES: readonly WorkEntryOutcome[] = [
	"claim_active",
	"reopen_incomplete",
	"create_linked_follow_up",
	"create_new",
];
const PRODUCT_SOURCE = {
	authority: "devspec_product",
	tier: "product_implementation_contract",
} as const;
const INSTRUCTION_BOUNDARY = {
	customer_tiers_excluded: [
		"project_custom_instructions",
		"project_agent_rules",
		"owner_agent_rules",
		"live_owner_command",
	],
	non_overridable: ["all_product_contract_rules"],
	contextual_precedence_high_to_low: [
		"live_owner_command",
		"owner_agent_rules",
		"project_agent_rules",
		"project_custom_instructions",
	],
	override_policy: {
		product_contract_rules: "never_override",
		project_shared_repo_safety: "never_weaken",
		other_customer_context: "higher_tier_specializes_lower_tier_when_non_conflicting",
	},
} as const;

function normalizeForCanonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
				.map(([key, nested]) => [key, normalizeForCanonicalJson(nested)]),
		);
	}
	return value;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeForCanonicalJson(value));
}

export function hashContractValue(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function exactMetadata(value: unknown, expected: unknown): boolean {
	return canonicalJson(value) === canonicalJson(expected);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** Keys the document must carry, in any order. */
function missingKeys(value: Record<string, unknown>, expected: readonly string[]): string[] {
	return expected.filter((key) => !Object.hasOwn(value, key));
}

/** Keys the document carries that this parser knows nothing about. */
function extraKeys(value: Record<string, unknown>, expected: readonly string[]): string[] {
	return Object.keys(value).filter((key) => !expected.includes(key)).sort();
}

function parseRules(value: unknown): ImplementationRule[] | null {
	const section = asRecord(value);
	if (!section || !hasExactKeys(section, ["rules"]) || !Array.isArray(section.rules)) return null;
	const rules: ImplementationRule[] = [];
	for (const candidate of section.rules) {
		const row = asRecord(candidate);
		if (!row || !hasExactKeys(row, ["id", "phase", "requirement", "enforcement"])) return null;
		const id = exactContractString(row.id);
		const phase = exactContractString(row.phase);
		const requirement = exactContractString(row.requirement);
		const enforcement = exactContractString(row.enforcement);
		if (
			!id || !phase || !RULE_PHASES.has(phase) || !requirement ||
			!enforcement || !RULE_ENFORCEMENTS.has(enforcement)
		) return null;
		rules.push({ id, phase, requirement, enforcement });
	}
	return rules.length > 0 ? rules : null;
}

function parseWorkEntryContract(value: unknown): WorkEntryContract | null {
	const section = asRecord(value);
	if (!section || (section.schema_version !== 1 && section.schema_version !== 2)) return null;
	const v2 = section.schema_version === 2;
	const expectedKeys = v2
		? ["schema_version", "mutation_boundary", "explicit_request_authority", "tracking_basis", "tracking_decisions", "plan_threshold", "plan_lifecycle", "ordered_decisions"]
		: ["schema_version", "mutation_boundary", "explicit_request_authority", "ordered_decisions"];
	if (!hasExactKeys(section, expectedKeys) || !Array.isArray(section.ordered_decisions)) return null;
	const mutationBoundary = exactContractString(section.mutation_boundary);
	const explicitRequestAuthority = exactContractString(section.explicit_request_authority);
	if (!mutationBoundary || !explicitRequestAuthority || section.ordered_decisions.length !== WORK_ENTRY_OUTCOMES.length) {
		return null;
	}
	const orderedDecisions: WorkEntryContract["ordered_decisions"] = [];
	for (const [index, candidate] of section.ordered_decisions.entries()) {
		const row = asRecord(candidate);
		if (!row || !hasExactKeys(row, ["outcome", "requirement"])) return null;
		const outcome = exactContractString(row.outcome);
		const requirement = exactContractString(row.requirement);
		if (outcome !== WORK_ENTRY_OUTCOMES[index] || !requirement) return null;
		orderedDecisions.push({ outcome, requirement });
	}
	if (!v2) {
		return {
			schema_version: 1,
			mutation_boundary: mutationBoundary,
			explicit_request_authority: explicitRequestAuthority,
			ordered_decisions: orderedDecisions,
		};
	}

	const trackingBasis = exactContractString(section.tracking_basis);
	const planThreshold = exactContractString(section.plan_threshold);
	const planLifecycle = exactContractString(section.plan_lifecycle);
	if (!trackingBasis || !planThreshold || !planLifecycle || !Array.isArray(section.tracking_decisions)) return null;
	const expectedTracking = [
		["both", true, true],
		["action_item", true, false],
		["session_plan", false, true],
		["neither", false, false],
	] as const;
	if (section.tracking_decisions.length !== expectedTracking.length) return null;
	const trackingDecisions: TrackingDecision[] = [];
	for (const [index, candidate] of section.tracking_decisions.entries()) {
		const row = asRecord(candidate);
		if (!row || !hasExactKeys(row, [
			"outcome", "durable_outcome_required", "material_session_progress_value", "requirement", "examples",
		])) return null;
		const [outcome, durable, progress] = expectedTracking[index]!;
		const requirement = exactContractString(row.requirement);
		if (row.outcome !== outcome || row.durable_outcome_required !== durable ||
			row.material_session_progress_value !== progress || !requirement || !Array.isArray(row.examples)) return null;
		const examples = row.examples.map(exactContractString);
		if (examples.length === 0 || examples.some((entry) => !entry)) return null;
		trackingDecisions.push({
			outcome,
			durable_outcome_required: durable,
			material_session_progress_value: progress,
			requirement,
			examples: examples as string[],
		});
	}
	return {
		schema_version: 2,
		mutation_boundary: mutationBoundary,
		explicit_request_authority: explicitRequestAuthority,
		tracking_basis: trackingBasis,
		tracking_decisions: trackingDecisions,
		plan_threshold: planThreshold,
		plan_lifecycle: planLifecycle,
		ordered_decisions: orderedDecisions,
	};
}

function exactStringTuple(value: unknown, expected: readonly string[]): boolean {
	return Array.isArray(value) && value.length === expected.length &&
		value.every((entry, index) => entry === expected[index]);
}

function parseCommitProvenanceContract(value: unknown): CommitProvenanceContract | null {
	const section = asRecord(value);
	if (!section || !hasExactKeys(section, [
		"schema_version", "authority_boundary", "early_claiming", "edit_behavior",
		"commit_reference", "validation", "stamping", "push_behavior",
		"project_association", "universal_recovery", "independent_controls",
	]) || section.schema_version !== 1) return null;
	for (const key of [
		"authority_boundary", "early_claiming", "edit_behavior", "stamping", "push_behavior",
		"project_association", "universal_recovery", "independent_controls",
	]) {
		if (!exactContractString(section[key])) return null;
	}
	const reference = asRecord(section.commit_reference);
	const validation = asRecord(section.validation);
	if (
		!reference || !hasExactKeys(reference, [
			"canonical_format", "accepted_local_shapes", "multiplicity", "validates_link_not_live_claim",
		]) ||
		reference.canonical_format !== "[devspec:<action-item-uuid>]" ||
		!exactStringTuple(reference.accepted_local_shapes, ["full_uuid", "eight_character_hex_short_code"]) ||
		reference.multiplicity !== "exactly_one" || reference.validates_link_not_live_claim !== true ||
		!validation || !hasExactKeys(validation, [
			"local_outcomes", "online_outcomes", "unavailable_result", "indeterminate_result",
			"definitive_not_found_result", "network_dependency",
		]) ||
		!exactStringTuple(validation.local_outcomes, ["absent", "malformed", "ambiguous", "well_formed"]) ||
		!exactStringTuple(validation.online_outcomes, ["valid", "not_found", "unavailable", "indeterminate"]) ||
		validation.unavailable_result !== "allow_and_reconcile" ||
		validation.indeterminate_result !== "allow_and_reconcile" ||
		validation.definitive_not_found_result !== "non_terminating_recovery" ||
		validation.network_dependency !== "optional"
	) return null;
	return section as unknown as CommitProvenanceContract;
}

const AUTHORITY_CLASSES: readonly AuthorityWriteClass[] = ["talk", "add", "overrule"];
const AUTHORITY_OUTCOMES = new Set<string>(["commit", "propose", "deny"]);
const AUTHORITY_OUTCOME_KEYS = ["guest", "contributor", "maintainer", "unattended"] as const;

function parseAuthorityContract(value: unknown): AuthorityContract | null {
	const section = asRecord(value);
	if (!section || !hasExactKeys(section, [
		"schema_version", "decision", "roles", "role_source_rule", "classes", "ownership_rule",
		"requester_rule", "unattended_rule", "proposal_outcome", "contested_rule", "preview_rule", "verbs",
	]) || section.schema_version !== 1) return null;
	for (const key of ["decision", "role_source_rule", "ownership_rule", "requester_rule", "unattended_rule", "contested_rule", "preview_rule"]) {
		if (!exactContractString(section[key])) return null;
	}
	if (!Array.isArray(section.roles) || section.roles.length === 0) return null;
	for (const candidate of section.roles) {
		const row = asRecord(candidate);
		if (!row || !hasExactKeys(row, ["role", "label", "meaning"])) return null;
		if (!exactContractString(row.role) || !exactContractString(row.label) || !exactContractString(row.meaning)) return null;
	}
	if (!Array.isArray(section.classes) || section.classes.length !== AUTHORITY_CLASSES.length) return null;
	for (const [index, candidate] of section.classes.entries()) {
		const row = asRecord(candidate);
		if (!row || !hasExactKeys(row, ["class", "meaning", "outcomes"]) || row.class !== AUTHORITY_CLASSES[index]) return null;
		if (!exactContractString(row.meaning)) return null;
		const outcomes = asRecord(row.outcomes);
		if (!outcomes || !hasExactKeys(outcomes, AUTHORITY_OUTCOME_KEYS)) return null;
		for (const key of AUTHORITY_OUTCOME_KEYS) {
			if (typeof outcomes[key] !== "string" || !AUTHORITY_OUTCOMES.has(outcomes[key] as string)) return null;
		}
	}
	const proposal = asRecord(section.proposal_outcome);
	if (
		!proposal || !hasExactKeys(proposal, ["token", "requirement", "because", "ledgers"]) ||
		proposal.token !== "queued_for_review" || !exactContractString(proposal.requirement) ||
		!Array.isArray(proposal.because) || proposal.because.length === 0 ||
		!proposal.because.every((entry) => exactContractString(entry)) ||
		!asRecord(proposal.ledgers)
	) return null;
	if (!Array.isArray(section.verbs) || section.verbs.length === 0) return null;
	for (const candidate of section.verbs) {
		const row = asRecord(candidate);
		if (!row || !exactContractString(row.id) || !exactContractString(row.class) || !AUTHORITY_CLASSES.includes(row.class as AuthorityWriteClass)) return null;
	}
	return section as unknown as AuthorityContract;
}

function parseJsonText(value: unknown, expectedResourceUri: string): unknown {
	const root = asRecord(value);
	if (!root || !Array.isArray(root.contents)) return value;
	const matching = root.contents
		.map(asRecord)
		.find((entry) => entry?.uri === expectedResourceUri && nonEmptyString(entry.text));
	const text = nonEmptyString(matching?.text);
	if (!text) throw new Error(`implementation contract resource did not return ${expectedResourceUri}`);
	return JSON.parse(text);
}

/**
 * One parser for both delivery paths, because both now carry the same document.
 * `contract_hash` covers every other served field, so a bundle authenticates
 * itself: no second read, and no mode to reconcile.
 *
 * A section this Pi does not implement is NOT a reason to reject the document
 * (DevSpec item 689d44cb). Every section named below still has to be present and
 * exactly the shape this parser verifies, and the hash still has to cover the
 * whole served document — including the part Pi cannot read, so nothing is
 * accepted unverified. What changes is what happens when DevSpec adds a section:
 * Pi keeps the sixteen rules plus work entry, provenance and authority it does
 * understand, and says which section it did not, instead of throwing all of it
 * away for five generic local ones. Failing closed on an ADDITION is not the
 * safer choice — it is a silent, total loss of the contract, and it has happened
 * twice (4.4.0 adding `authority_contract` was the second time).
 */
function parseContractBundle(root: Record<string, unknown>, resourceUri: string): CachedContract | null {
	const contractVersion = exactContractString(root.contract_version);
	if (!contractVersion || !CONTRACT_VERSION_PATTERN.test(contractVersion)) return null;
	const expectedKeys = [
		"kind", "schema_version", "contract_version", "contract_hash", "source", "instruction_boundary",
		"core_implementation_contract", "work_entry_contract", "commit_provenance_contract", "authority_contract",
	];
	const unknownSections = extraKeys(root, expectedKeys);
	if (
		missingKeys(root, expectedKeys).length > 0 ||
		root.kind !== "devspec.product.implementation_contract" ||
		root.schema_version !== 1 ||
		!exactMetadata(root.source, PRODUCT_SOURCE) ||
		!exactMetadata(root.instruction_boundary, INSTRUCTION_BOUNDARY)
	) return null;
	const contractHash = exactContractString(root.contract_hash);
	const rules = parseRules(root.core_implementation_contract);
	const workEntryContract = parseWorkEntryContract(root.work_entry_contract);
	const commitProvenanceContract = parseCommitProvenanceContract(root.commit_provenance_contract);
	const authorityContract = parseAuthorityContract(root.authority_contract);
	if (
		!contractHash || !CONTRACT_HASH_PATTERN.test(contractHash) || !rules ||
		!workEntryContract || !commitProvenanceContract || !authorityContract
	) return null;
	// Hash exactly what was served. Validation above guarantees the shape and
	// canonical strings; no trimming or reconstructed value may authenticate a
	// differently encoded document.
	const { contract_hash: _contractHash, ...contractHashInput } = root;
	if (hashContractValue(contractHashInput) !== contractHash) return null;
	return {
		contractVersion,
		contractHash,
		resourceUri,
		rules,
		workEntryContract,
		commitProvenanceContract,
		authorityContract,
		...(unknownSections.length > 0 ? { unknownSections } : {}),
	};
}

function contractFromResourcePayload(payload: unknown, resourceUri: string): CachedContract | null {
	const root = asRecord(parseJsonText(payload, resourceUri));
	return root ? parseContractBundle(root, resourceUri) : null;
}

function contractFromCompatibilityPayload(payload: unknown, resourceUri: string): CachedContract | null {
	const root = asRecord(payload);
	if (!root) return null;
	const bundle = asRecord(root.implementation_contract) ?? root;
	return parseContractBundle(bundle, resourceUri);
}

/**
 * What Pi teaches when it cannot get the canonical contract at all. These are
 * deliberately the same in every situation: the two rules that used to be the
 * unattended overlay are here unconditionally, because "do not invent authority"
 * was never contingent on nobody watching.
 */
function localSafetyFallback(resourceUri: string, warning: string): ImplementationContractContext {
	return {
		contractVersion: "pi-local-fail-open-v1",
		resourceUri,
		source: "local_safety_fallback",
		warning,
		rules: [
			{
				id: "pi-fallback.claim-early",
				phase: "claim",
				requirement: "Search, reuse or create the smallest covering item and claim it early when DevSpec is available; an absent claim never blocks local repository work.",
				enforcement: "agent",
			},
			{
				id: "pi-fallback.commit-link",
				phase: "delivery",
				requirement: "Prefer one full [devspec:<action-item-id>] commit reference and use record_implementation for authoritative post-commit linkage; unsupported Git surfaces rely on server reconciliation.",
				enforcement: "agent",
			},
			{
				id: "pi-fallback.no-human-assumption",
				phase: "implementation",
				requirement: "Do not assume a human is present and do not invent authority or intent.",
				enforcement: "agent",
			},
			{
				id: "pi-fallback.stop-at-implemented",
				phase: "completion",
				requirement: "Record implementation after pushing and stop at implemented; never mark the item done.",
				enforcement: "server",
			},
			{
				id: "pi-fallback.truthful-handoff",
				phase: "failure",
				requirement: "On failure, use fail_work_item or release_work_item truthfully; never leave failed work implementing.",
				enforcement: "agent",
			},
		],
	};
}

function validateResourceUri(uri: string): boolean {
	return uri === IMPLEMENTATION_CONTRACT_RESOURCE_URI;
}

function storeContract(scope: string, value: CachedContract): void {
	const current = cache();
	current.byIdentity.set(cacheIdentity(scope, value.resourceUri, value.contractVersion), value);
	current.latestByResource.set(latestIdentity(scope, value.resourceUri), value);
}

/**
 * The notice an accepted contract carries. A section Pi does not implement is
 * worth saying out loud — the model is reading a contract that has more in it
 * than this plugin can show — but it never downgrades the sections Pi did read.
 */
function unknownSectionNotice(contract: CachedContract): string | undefined {
	const unknown = contract.unknownSections ?? [];
	if (unknown.length === 0) return undefined;
	return `This DevSpec serves ${unknown.length === 1 ? "a contract section" : "contract sections"} this Pi does not understand (${unknown.join(", ")}); everything else in the contract is loaded and in force. Update the DevSpec Pi plugin to read ${unknown.length === 1 ? "it" : "them"}.`;
}

function acceptedContract(
	contract: CachedContract,
	source: "resource" | "compatibility" | "cache",
	warning?: string,
): ImplementationContractContext {
	const notice = unknownSectionNotice(contract);
	const combined = [warning, notice].filter(Boolean).join(" ");
	return { ...contract, source, ...(combined ? { warning: combined } : {}) };
}

function cachedContract(
	scope: string,
	resourceUri: string,
	expectedVersion?: string,
): ImplementationContractContext | null {
	const current = cache();
	const value = expectedVersion
		? current.byIdentity.get(cacheIdentity(scope, resourceUri, expectedVersion))
		: current.latestByResource.get(latestIdentity(scope, resourceUri));
	return value ? acceptedContract(value, "cache") : null;
}

/**
 * Load the product contract at work entry. A delivery that names a version can use
 * that exact immutable cache entry; an unversioned one refreshes and may fall back
 * to the latest cached contract, because there is no version it was promised.
 */
export async function loadImplementationContext(input: {
	reference?: ImplementationContractReference;
	loader: ImplementationContractLoader;
	/** Pump/bond authority checkpoint for each asynchronous preparation stage. */
	assertCurrent?: () => void;
}): Promise<ImplementationContractContext> {
	const resourceUri = input.reference?.resource_uri ?? IMPLEMENTATION_CONTRACT_RESOURCE_URI;
	const expectedVersion = nonEmptyString(input.reference?.contract_version);
	const scope = await input.loader.cacheScope();
	input.assertCurrent?.();
	if (!validateResourceUri(resourceUri)) {
		return localSafetyFallback(
			IMPLEMENTATION_CONTRACT_RESOURCE_URI,
			`The delivered implementation-contract pointer was not ${IMPLEMENTATION_CONTRACT_RESOURCE_URI}; the Pi safety fallback is active.`,
		);
	}

	if (expectedVersion) {
		const exact = cachedContract(scope, resourceUri, expectedVersion);
		if (exact) return exact;
	}

	const errors: string[] = [];
	// A document that arrived and failed verification is a different situation from
	// one that never arrived: the first needs a plugin update, the second needs the
	// service back. Saying "unavailable" for both sends whoever reads it looking in
	// the wrong place.
	let served = false;
	try {
		const payload = await input.loader.readResource(resourceUri);
		input.assertCurrent?.();
		served = true;
		const contract = contractFromResourcePayload(payload, resourceUri);
		if (!contract) throw new Error("the served document did not match the contract shape this Pi verifies");
		if (expectedVersion && contract.contractVersion !== expectedVersion) {
			throw new Error(`resource version ${contract.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, contract);
		return acceptedContract(contract, "resource");
	} catch (error) {
		input.assertCurrent?.();
		errors.push(error instanceof Error ? error.message : String(error));
	}

	try {
		const payload = await input.loader.readCompatibilityBundle();
		input.assertCurrent?.();
		served = true;
		const contract = contractFromCompatibilityPayload(payload, resourceUri);
		if (!contract) throw new Error("the compatibility payload did not match the contract shape this Pi verifies");
		if (expectedVersion && contract.contractVersion !== expectedVersion) {
			throw new Error(`compatibility version ${contract.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, contract);
		return acceptedContract(contract, "compatibility");
	} catch (error) {
		input.assertCurrent?.();
		errors.push(error instanceof Error ? error.message : String(error));
	}

	input.assertCurrent?.();
	const retained = expectedVersion
		? cachedContract(scope, resourceUri, expectedVersion)
		: cachedContract(scope, resourceUri);
	if (retained) {
		return {
			...retained,
			warning: [
				`DevSpec contract refresh failed; using the retained ${retained.contractVersion} contract.`,
				retained.warning,
			].filter(Boolean).join(" "),
		};
	}
	return localSafetyFallback(
		resourceUri,
		served
			? `DevSpec served a contract this Pi could not verify (${errors.join("; ") || "unknown error"}); the Pi safety fallback is active. Update the DevSpec Pi plugin — this is a version mismatch, not an outage.`
			: `DevSpec contract unavailable (${errors.join("; ") || "unknown error"}); the Pi safety fallback is active.`,
	);
}

export function createImplementationContractLoader(token: string): ImplementationContractLoader {
	const tokenFingerprint = createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24);
	return {
		cacheScope: async () => `${await resolveEndpoint()}#${tokenFingerprint}`,
		readResource: (uri) => readDevspecResource(token, uri, {
			lane: "work",
			timeoutMs: MODEL_TIMEOUT_MS,
		}),
		readCompatibilityBundle: async () => {
			const raw = await callDevspec(
				token,
				"get_workflow_rules",
				{ include_implementation_contract: true },
				{ lane: "work", timeoutMs: MODEL_TIMEOUT_MS },
			);
			const unwrapped = unwrapMcpResult(raw);
			if (unwrapped.isError) throw new Error(unwrapped.text || "get_workflow_rules failed");
			return unwrapped.details ?? unwrapped.text;
		},
	};
}

export function buildImplementationKickoff(input: {
	actionItemIds: readonly string[];
	context: ImplementationContractContext;
	contractReference?: ImplementationContractReference;
}): ImplementationKickoff {
	const actionItemIds = [...new Set(input.actionItemIds.map((id) => id.trim()).filter(Boolean))];
	if (actionItemIds.length === 0) throw new Error("implementation kickoff requires at least one action item id");
	const suppliedVersion = nonEmptyString(input.contractReference?.contract_version);
	if (
		input.context.source !== "local_safety_fallback" && suppliedVersion &&
		suppliedVersion !== input.context.contractVersion
	) {
		throw new Error("implementation kickoff contract version did not match the loaded canonical contract");
	}
	if (input.contractReference?.resource_uri && input.contractReference.resource_uri !== input.context.resourceUri) {
		throw new Error("implementation kickoff contract resource did not match the loaded canonical contract");
	}
	const reference = {
		// During an outage preserve the immutable server pointer the delivery
		// carried. The local fallback affects guidance, not work authorization.
		contract_version: suppliedVersion ?? input.context.contractVersion,
		resource_uri: input.contractReference?.resource_uri ?? input.context.resourceUri,
	};
	const contractVersion = nonEmptyString(reference.contract_version);
	if (!contractVersion || !validateResourceUri(reference.resource_uri)) {
		throw new Error("implementation kickoff requires a versioned product-contract reference");
	}
	return {
		kind: "devspec.implementation_kickoff",
		schema_version: 1,
		work: {
			action_item_ids: actionItemIds,
		},
		implementation_contract: {
			contract_version: contractVersion,
			resource_uri: reference.resource_uri,
		},
	};
}

export function formatImplementationKickoffHeader(kickoff: ImplementationKickoff): string {
	return `DevSpec work kickoff: ${JSON.stringify(kickoff)}`;
}

export function formatImplementationContext(context: ImplementationContractContext): string {
	const identity = [
		`version=${context.contractVersion}`,
		context.contractHash ? `hash=${context.contractHash}` : null,
		`source=${context.source}`,
	].filter(Boolean).join(" · ");
	return [
		`${context.source === "local_safety_fallback" ? "Local fail-open fallback (the canonical product contract was not loaded; the notice below says why)" : "Product implementation contract"} (${identity})`,
		...(context.warning ? [`Availability notice: ${context.warning}`] : []),
		...(context.workEntryContract ? [
			"Canonical work entry contract (the only action-item/session-plan boundary):",
			JSON.stringify(context.workEntryContract),
		] : []),
		...(context.authorityContract ? formatAuthorityContract(context.authorityContract) : []),
		"Rules:",
		...context.rules.map((rule) => `- [${rule.id}] ${rule.requirement}`),
	].join("\n");
}

/**
 * The authority section as the model reads it: the classes with the outcomes the
 * server actually returns, the rules that qualify those outcomes, and what a queued
 * proposal means. Verbs and role meanings stay in the served document — the model
 * reads the outcome of each call; it never has to predict one.
 *
 * The class table is printed with `ownership_rule` and `unattended_rule` beside it
 * because on its own it is wrong about the two writes an agent makes most (DevSpec
 * item 689d44cb): the table says an `add` commits unattended, while the served
 * unattended rule records `memory.record` and `artifact.create` as proposals and
 * refuses personal-scope writes; and the ownership rule is what makes closing your
 * own item an add and closing a colleague's an overrule. Both are quoted from the
 * served document, never paraphrased — this plugin does not own these sentences.
 */
export function formatAuthorityContract(authority: AuthorityContract): string[] {
	return [
		"Write authority (authority_contract — who may change the project's record is decided per call by the server from the verb, the person's project role and whether the run is unattended; read every write's outcome, never predict it):",
		...authority.classes.map((cls) =>
			`- ${cls.class}: ${cls.meaning} Outcomes — guest ${cls.outcomes.guest}, contributor ${cls.outcomes.contributor}, maintainer ${cls.outcomes.maintainer}, unattended ${cls.outcomes.unattended}.`,
		),
		`- Ownership rule: ${authority.ownership_rule}`,
		`- Unattended rule: ${authority.unattended_rule}`,
		`- Requester rule: ${authority.requester_rule}`,
		`- ${authority.proposal_outcome.token}: ${authority.proposal_outcome.requirement}`,
		`- Contested rulings: ${authority.contested_rule}`,
	];
}

export function resetImplementationContractCache(): void {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	root[CACHE_KEY] = {
		byIdentity: new Map(),
		latestByResource: new Map(),
	};
}
