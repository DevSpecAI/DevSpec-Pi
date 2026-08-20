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

export interface WorkEntryContract {
	schema_version: 1;
	mutation_boundary: string;
	explicit_request_authority: string;
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

export interface ImplementationContractContext {
	contractVersion: string;
	contractHash?: string;
	resourceUri: string;
	source: "resource" | "compatibility" | "cache" | "local_safety_fallback";
	rules: ImplementationRule[];
	workEntryContract?: WorkEntryContract;
	commitProvenanceContract?: CommitProvenanceContract;
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

// v6 is the clean v4 provenance-contract cutover; v2/v3 cache entries are invalid.
const CACHE_KEY = Symbol.for("devspec.pi.implementation-contract.v6");

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
	if (!section || !hasExactKeys(section, [
		"schema_version", "mutation_boundary", "explicit_request_authority", "ordered_decisions",
	]) || section.schema_version !== 1 || !Array.isArray(section.ordered_decisions)) return null;
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
	return {
		schema_version: 1,
		mutation_boundary: mutationBoundary,
		explicit_request_authority: explicitRequestAuthority,
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
 */
function parseContractBundle(root: Record<string, unknown>, resourceUri: string): CachedContract | null {
	const contractVersion = exactContractString(root.contract_version);
	if (!contractVersion || !CONTRACT_VERSION_PATTERN.test(contractVersion)) return null;
	const expectedKeys = [
		"kind", "schema_version", "contract_version", "contract_hash", "source", "instruction_boundary",
		"core_implementation_contract", "work_entry_contract", "commit_provenance_contract",
	];
	if (
		!hasExactKeys(root, expectedKeys) ||
		root.kind !== "devspec.product.implementation_contract" ||
		root.schema_version !== 1 ||
		!exactMetadata(root.source, PRODUCT_SOURCE) ||
		!exactMetadata(root.instruction_boundary, INSTRUCTION_BOUNDARY)
	) return null;
	const contractHash = exactContractString(root.contract_hash);
	const rules = parseRules(root.core_implementation_contract);
	const workEntryContract = parseWorkEntryContract(root.work_entry_contract);
	const commitProvenanceContract = parseCommitProvenanceContract(root.commit_provenance_contract);
	if (
		!contractHash || !CONTRACT_HASH_PATTERN.test(contractHash) || !rules ||
		!workEntryContract || !commitProvenanceContract
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

function cachedContract(
	scope: string,
	resourceUri: string,
	expectedVersion?: string,
): ImplementationContractContext | null {
	const current = cache();
	const value = expectedVersion
		? current.byIdentity.get(cacheIdentity(scope, resourceUri, expectedVersion))
		: current.latestByResource.get(latestIdentity(scope, resourceUri));
	return value ? { ...value, source: "cache" } : null;
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
	try {
		const payload = await input.loader.readResource(resourceUri);
		input.assertCurrent?.();
		const contract = contractFromResourcePayload(payload, resourceUri);
		if (!contract) throw new Error("resource payload was not a valid implementation contract");
		if (expectedVersion && contract.contractVersion !== expectedVersion) {
			throw new Error(`resource version ${contract.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, contract);
		return { ...contract, source: "resource" };
	} catch (error) {
		input.assertCurrent?.();
		errors.push(error instanceof Error ? error.message : String(error));
	}

	try {
		const payload = await input.loader.readCompatibilityBundle();
		input.assertCurrent?.();
		const contract = contractFromCompatibilityPayload(payload, resourceUri);
		if (!contract) throw new Error("compatibility payload was not a valid implementation contract");
		if (expectedVersion && contract.contractVersion !== expectedVersion) {
			throw new Error(`compatibility version ${contract.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, contract);
		return { ...contract, source: "compatibility" };
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
			warning: `DevSpec contract refresh failed; using the retained ${retained.contractVersion} contract.`,
		};
	}
	return localSafetyFallback(
		resourceUri,
		`DevSpec contract unavailable (${errors.join("; ") || "unknown error"}); the Pi safety fallback is active.`,
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
		`${context.source === "local_safety_fallback" ? "Local fail-open fallback (the referenced product contract was unavailable)" : "Product implementation contract"} (${identity})`,
		...(context.warning ? [`Availability notice: ${context.warning}`] : []),
		"Rules:",
		...context.rules.map((rule) => `- [${rule.id}] ${rule.requirement}`),
	].join("\n");
}

export function resetImplementationContractCache(): void {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	root[CACHE_KEY] = {
		byIdentity: new Map(),
		latestByResource: new Map(),
	};
}
