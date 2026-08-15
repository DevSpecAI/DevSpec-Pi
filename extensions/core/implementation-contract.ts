import { createHash } from "node:crypto";
import { resolveEndpoint } from "./auth-store.ts";
import { callDevspec, MODEL_TIMEOUT_MS, readDevspecResource } from "./client.ts";
import { unwrapMcpResult } from "./result.ts";

export type ImplementationExecutionMode = "attended" | "unattended";

export const IMPLEMENTATION_CONTRACT_RESOURCE_URIS = {
	attended: "devspec://product/implementation-contract/attended",
	unattended: "devspec://product/implementation-contract/unattended",
} as const satisfies Record<ImplementationExecutionMode, string>;

export interface ImplementationContractReference {
	contract_version?: string;
	resource_uri: string;
}

export interface ImplementationKickoff {
	kind: "devspec.implementation_kickoff";
	schema_version: 1;
	work: {
		action_item_ids: string[];
		assignment_id?: string;
	};
	execution_mode: ImplementationExecutionMode;
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

export interface EffectiveImplementationContext {
	executionMode: ImplementationExecutionMode;
	contractVersion: string;
	contractHash?: string;
	effectiveHash?: string;
	resourceUri: string;
	source: "resource" | "compatibility" | "cache" | "local_safety_fallback";
	coreRules: ImplementationRule[];
	modeRules: ImplementationRule[];
	warning?: string;
}

export interface ImplementationContractLoader {
	/** Stable, non-secret authority identity (endpoint + token fingerprint). */
	cacheScope(): Promise<string>;
	readResource(uri: string): Promise<unknown>;
	readCompatibilityBundle(): Promise<unknown>;
}

interface CachedContract extends Omit<EffectiveImplementationContext, "source" | "warning"> {}

interface ContractCache {
	byIdentity: Map<string, CachedContract>;
	latestByResource: Map<string, CachedContract>;
	/** Parent bundle hashes validated from the full compatibility contract. */
	verifiedBundleHashes: Map<string, string>;
}

// v2 invalidates contracts cached by the former permissive parser across Pi /reload.
const CACHE_KEY = Symbol.for("devspec.pi.implementation-contract.v2");

function cache(): ContractCache {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	const current = root[CACHE_KEY];
	if (
		!current || !(current.byIdentity instanceof Map) ||
		!(current.latestByResource instanceof Map) || !(current.verifiedBundleHashes instanceof Map)
	) {
		root[CACHE_KEY] = {
			byIdentity: new Map(),
			latestByResource: new Map(),
			verifiedBundleHashes: new Map(),
		};
	}
	return root[CACHE_KEY]!;
}

function cacheIdentity(scope: string, resourceUri: string, contractVersion: string): string {
	return `${scope}\u0000${resourceUri}\u0000${contractVersion}`;
}

function latestIdentity(scope: string, resourceUri: string): string {
	return `${scope}\u0000${resourceUri}`;
}

function bundleIdentity(scope: string, contractVersion: string): string {
	return `${scope}\u0000${contractVersion}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const CONTRACT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RULE_PHASES = new Set([
	"discovery", "claim", "implementation", "verification", "delivery", "completion", "failure", "governance",
]);
const RULE_ENFORCEMENTS = new Set(["server", "host", "agent", "human"]);
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
		const id = nonEmptyString(row.id);
		const phase = nonEmptyString(row.phase);
		const requirement = nonEmptyString(row.requirement);
		const enforcement = nonEmptyString(row.enforcement);
		if (
			!id || !phase || !RULE_PHASES.has(phase) || !requirement ||
			!enforcement || !RULE_ENFORCEMENTS.has(enforcement)
		) return null;
		rules.push({ id, phase, requirement, enforcement });
	}
	return rules.length > 0 ? rules : null;
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

function parseEffectiveContract(
	root: Record<string, unknown>,
	executionMode: ImplementationExecutionMode,
	resourceUri: string,
): CachedContract | null {
	if (
		!hasExactKeys(root, [
			"kind", "schema_version", "contract_version", "contract_hash", "effective_hash",
			"execution_mode", "source", "instruction_boundary", "core_implementation_contract", "mode_overlay",
		]) ||
		root.kind !== "devspec.product.effective_implementation_contract" ||
		root.schema_version !== 1 ||
		root.execution_mode !== executionMode ||
		!exactMetadata(root.source, PRODUCT_SOURCE) ||
		!exactMetadata(root.instruction_boundary, INSTRUCTION_BOUNDARY)
	) return null;
	const contractVersion = nonEmptyString(root.contract_version);
	const contractHash = nonEmptyString(root.contract_hash);
	const effectiveHash = nonEmptyString(root.effective_hash);
	const coreRules = parseRules(root.core_implementation_contract);
	const modeRules = parseRules(root.mode_overlay);
	if (
		!contractVersion || !contractHash || !CONTRACT_HASH_PATTERN.test(contractHash) ||
		!effectiveHash || !CONTRACT_HASH_PATTERN.test(effectiveHash) || !coreRules || !modeRules
	) return null;
	// Match DevSpecV2 exactly: effective_hash covers the effective payload fields
	// and deliberately excludes both hash fields; contract_hash identifies the
	// parent full bundle and is only recomputable from a compatibility bundle.
	const effectiveHashInput = {
		kind: root.kind,
		schema_version: root.schema_version,
		contract_version: contractVersion,
		execution_mode: executionMode,
		source: PRODUCT_SOURCE,
		instruction_boundary: INSTRUCTION_BOUNDARY,
		core_implementation_contract: { rules: coreRules },
		mode_overlay: { rules: modeRules },
	};
	if (hashContractValue(effectiveHashInput) !== effectiveHash) return null;
	return {
		executionMode,
		contractVersion,
		contractHash,
		effectiveHash,
		resourceUri,
		coreRules,
		modeRules,
	};
}

function parseContractBundle(
	root: Record<string, unknown>,
	executionMode: ImplementationExecutionMode,
	resourceUri: string,
): CachedContract | null {
	if (
		!hasExactKeys(root, [
			"kind", "schema_version", "contract_version", "contract_hash", "source", "instruction_boundary",
			"core_implementation_contract", "attended_overlay", "unattended_overlay",
		]) ||
		root.kind !== "devspec.product.implementation_contract" ||
		root.schema_version !== 1 ||
		!exactMetadata(root.source, PRODUCT_SOURCE) ||
		!exactMetadata(root.instruction_boundary, INSTRUCTION_BOUNDARY)
	) return null;
	const contractVersion = nonEmptyString(root.contract_version);
	const contractHash = nonEmptyString(root.contract_hash);
	const coreRules = parseRules(root.core_implementation_contract);
	const attendedRules = parseRules(root.attended_overlay);
	const unattendedRules = parseRules(root.unattended_overlay);
	if (
		!contractVersion || !contractHash || !CONTRACT_HASH_PATTERN.test(contractHash) ||
		!coreRules || !attendedRules || !unattendedRules
	) return null;
	const contractHashInput = {
		kind: root.kind,
		schema_version: root.schema_version,
		contract_version: contractVersion,
		source: PRODUCT_SOURCE,
		instruction_boundary: INSTRUCTION_BOUNDARY,
		core_implementation_contract: { rules: coreRules },
		attended_overlay: { rules: attendedRules },
		unattended_overlay: { rules: unattendedRules },
	};
	if (hashContractValue(contractHashInput) !== contractHash) return null;
	const modeRules = executionMode === "attended" ? attendedRules : unattendedRules;
	const effectiveHash = hashContractValue({
		kind: "devspec.product.effective_implementation_contract",
		schema_version: 1,
		contract_version: contractVersion,
		execution_mode: executionMode,
		source: PRODUCT_SOURCE,
		instruction_boundary: INSTRUCTION_BOUNDARY,
		core_implementation_contract: { rules: coreRules },
		mode_overlay: { rules: modeRules },
	});
	return {
		executionMode,
		contractVersion,
		contractHash,
		effectiveHash,
		resourceUri,
		coreRules,
		modeRules,
	};
}

function effectiveFromResourcePayload(
	payload: unknown,
	executionMode: ImplementationExecutionMode,
	resourceUri: string,
): CachedContract | null {
	const root = asRecord(parseJsonText(payload, resourceUri));
	return root ? parseEffectiveContract(root, executionMode, resourceUri) : null;
}

function effectiveFromCompatibilityPayload(
	payload: unknown,
	executionMode: ImplementationExecutionMode,
	resourceUri: string,
): CachedContract | null {
	const root = asRecord(payload);
	if (!root) return null;
	const bundle = asRecord(root.implementation_contract) ?? root;
	return parseContractBundle(bundle, executionMode, resourceUri);
}

function localSafetyFallback(
	executionMode: ImplementationExecutionMode,
	resourceUri: string,
	warning: string,
): EffectiveImplementationContext {
	const modeRules: ImplementationRule[] = executionMode === "attended"
		? [{
			id: "pi-fallback.attended-explicit-item",
			phase: "completion",
			requirement: "Work only the explicitly selected item; do not drain a staged queue implicitly.",
			enforcement: "host",
		}]
		: [
			{
				id: "pi-fallback.unattended-no-human-assumption",
				phase: "implementation",
				requirement: "Do not assume a human is present and do not invent authority or intent.",
				enforcement: "agent",
			},
			{
				id: "pi-fallback.unattended-truthful-handoff",
				phase: "failure",
				requirement: "On failure, use fail_work_item or release_work_item truthfully; never leave failed work implementing.",
				enforcement: "agent",
			},
		];
	return {
		executionMode,
		contractVersion: "pi-local-safety-v1",
		resourceUri,
		source: "local_safety_fallback",
		warning,
		coreRules: [
			{
				id: "pi-fallback.claim-before-edit",
				phase: "claim",
				requirement: "Do not edit until claim_work_item succeeds. If DevSpec is unavailable, stop and retry rather than bypassing the claim.",
				enforcement: "host",
			},
			{
				id: "pi-fallback.never-force-claim-guards",
				phase: "claim",
				requirement: "Never force past another claimant, assignee guard, unresolved dependency, or semantic conflict without explicit authority.",
				enforcement: "server",
			},
			{
				id: "pi-fallback.stop-at-implemented",
				phase: "completion",
				requirement: "Record implementation after pushing and stop at implemented; never mark the item done.",
				enforcement: "server",
			},
		],
		modeRules,
	};
}

function validateResourceUri(mode: ImplementationExecutionMode, uri: string): boolean {
	return uri === IMPLEMENTATION_CONTRACT_RESOURCE_URIS[mode];
}

function storeContract(scope: string, value: CachedContract, parentHashVerified = false): void {
	const current = cache();
	current.byIdentity.set(cacheIdentity(scope, value.resourceUri, value.contractVersion), value);
	current.latestByResource.set(latestIdentity(scope, value.resourceUri), value);
	if (parentHashVerified && value.contractHash) {
		current.verifiedBundleHashes.set(bundleIdentity(scope, value.contractVersion), value.contractHash);
	}
}

function verifiedBundleHash(scope: string, contractVersion: string): string | undefined {
	return cache().verifiedBundleHashes.get(bundleIdentity(scope, contractVersion));
}

function cachedContract(
	scope: string,
	resourceUri: string,
	expectedVersion?: string,
): EffectiveImplementationContext | null {
	const current = cache();
	const value = expectedVersion
		? current.byIdentity.get(cacheIdentity(scope, resourceUri, expectedVersion))
		: current.latestByResource.get(latestIdentity(scope, resourceUri));
	return value ? { ...value, source: "cache" } : null;
}

/**
 * Load the product contract at work entry. A versioned dispatch can use an
 * exact immutable cache entry; local attended selection refreshes first and
 * uses the latest cached contract only when the server is temporarily down.
 */
export async function loadImplementationContext(input: {
	executionMode: ImplementationExecutionMode;
	reference?: ImplementationContractReference;
	loader: ImplementationContractLoader;
	/** Pump/bond authority checkpoint for each asynchronous preparation stage. */
	assertCurrent?: () => void;
}): Promise<EffectiveImplementationContext> {
	const expectedUri = IMPLEMENTATION_CONTRACT_RESOURCE_URIS[input.executionMode];
	const resourceUri = input.reference?.resource_uri ?? expectedUri;
	const expectedVersion = nonEmptyString(input.reference?.contract_version);
	const scope = await input.loader.cacheScope();
	input.assertCurrent?.();
	if (!validateResourceUri(input.executionMode, resourceUri)) {
		return localSafetyFallback(
			input.executionMode,
			expectedUri,
			"The delivered implementation-contract pointer did not match its execution mode; the Pi safety fallback is active.",
		);
	}

	if (expectedVersion) {
		const exact = cachedContract(scope, resourceUri, expectedVersion);
		if (exact) return exact;
	}

	const errors: string[] = [];
	let resourceContract: CachedContract | null = null;
	let compatibilityContract: CachedContract | null = null;
	let compatibilityRead = false;
	try {
		const payload = await input.loader.readResource(resourceUri);
		input.assertCurrent?.();
		resourceContract = effectiveFromResourcePayload(payload, input.executionMode, resourceUri);
		if (!resourceContract) throw new Error("resource payload was not a valid implementation contract");
		if (expectedVersion && resourceContract.contractVersion !== expectedVersion) {
			throw new Error(`resource version ${resourceContract.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
	} catch (error) {
		resourceContract = null;
		input.assertCurrent?.();
		errors.push(error instanceof Error ? error.message : String(error));
	}

	if (resourceContract) {
		const trustedParentHash = verifiedBundleHash(scope, resourceContract.contractVersion);
		if (trustedParentHash === resourceContract.contractHash) {
			storeContract(scope, resourceContract);
			return { ...resourceContract, source: "resource" };
		}
		if (trustedParentHash) {
			errors.push("resource contract_hash did not match the retained validated parent bundle");
			resourceContract = null;
		} else {
			// effective_hash authenticates the exact mode projection, but DevSpecV2
			// deliberately excludes the parent contract_hash from that hash input.
			// Validate the parent hash once per authority/version from the full bundle.
			try {
				const payload = await input.loader.readCompatibilityBundle();
				compatibilityRead = true;
				input.assertCurrent?.();
				compatibilityContract = effectiveFromCompatibilityPayload(payload, input.executionMode, resourceUri);
				if (!compatibilityContract) throw new Error("compatibility payload was not a valid implementation contract");
				if (expectedVersion && compatibilityContract.contractVersion !== expectedVersion) {
					throw new Error(`compatibility version ${compatibilityContract.contractVersion} did not match kickoff version ${expectedVersion}`);
				}
				if (
					compatibilityContract.contractHash === resourceContract.contractHash &&
					compatibilityContract.effectiveHash === resourceContract.effectiveHash
				) {
					storeContract(scope, resourceContract, true);
					return { ...resourceContract, source: "resource" };
				}
				errors.push("resource contract identity did not match the validated compatibility bundle");
				resourceContract = null;
			} catch (error) {
				compatibilityContract = null;
				input.assertCurrent?.();
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	}

	if (!compatibilityContract) {
		try {
			const payload = compatibilityRead ? null : await input.loader.readCompatibilityBundle();
			compatibilityRead = true;
			input.assertCurrent?.();
			compatibilityContract = payload === null
				? null
				: effectiveFromCompatibilityPayload(payload, input.executionMode, resourceUri);
			if (!compatibilityContract) throw new Error("compatibility payload was not a valid implementation contract");
			if (expectedVersion && compatibilityContract.contractVersion !== expectedVersion) {
				throw new Error(`compatibility version ${compatibilityContract.contractVersion} did not match kickoff version ${expectedVersion}`);
			}
		} catch (error) {
			compatibilityContract = null;
			input.assertCurrent?.();
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (compatibilityContract) {
		storeContract(scope, compatibilityContract, true);
		return { ...compatibilityContract, source: "compatibility" };
	}

	input.assertCurrent?.();
	// A versioned delivery authorizes only its exact immutable cache entry.
	// Local attended selection may retain the latest canonical contract because
	// a present user explicitly chose the work. Unversioned unattended delivery
	// has no authority to guess which cached version the assignment intended.
	const retained = expectedVersion
		? cachedContract(scope, resourceUri, expectedVersion)
		: input.executionMode === "attended"
			? cachedContract(scope, resourceUri)
			: null;
	if (retained) {
		return {
			...retained,
			warning: `DevSpec contract refresh failed; using the retained ${retained.contractVersion} contract.`,
		};
	}
	return localSafetyFallback(
		input.executionMode,
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
	assignmentId?: string;
	context: EffectiveImplementationContext;
	contractReference?: ImplementationContractReference;
}): ImplementationKickoff {
	const actionItemIds = [...new Set(input.actionItemIds.map((id) => id.trim()).filter(Boolean))];
	if (actionItemIds.length === 0) throw new Error("implementation kickoff requires at least one action item id");
	if (input.context.source === "local_safety_fallback") {
		throw new Error("canonical implementation contract unavailable; work was not started and remains retryable");
	}
	const suppliedVersion = nonEmptyString(input.contractReference?.contract_version);
	if (suppliedVersion && suppliedVersion !== input.context.contractVersion) {
		throw new Error("implementation kickoff contract version did not match the loaded canonical contract");
	}
	if (input.contractReference?.resource_uri && input.contractReference.resource_uri !== input.context.resourceUri) {
		throw new Error("implementation kickoff contract resource did not match the loaded canonical contract");
	}
	const reference = {
		contract_version: suppliedVersion ?? input.context.contractVersion,
		resource_uri: input.contractReference?.resource_uri ?? input.context.resourceUri,
	};
	const contractVersion = nonEmptyString(reference.contract_version);
	if (!contractVersion || !validateResourceUri(input.context.executionMode, reference.resource_uri)) {
		throw new Error("implementation kickoff requires a mode-matched, versioned product-contract reference");
	}
	return {
		kind: "devspec.implementation_kickoff",
		schema_version: 1,
		work: {
			action_item_ids: actionItemIds,
			...(input.assignmentId?.trim() ? { assignment_id: input.assignmentId.trim() } : {}),
		},
		execution_mode: input.context.executionMode,
		implementation_contract: {
			contract_version: contractVersion,
			resource_uri: reference.resource_uri,
		},
	};
}

export function formatImplementationKickoffHeader(kickoff: ImplementationKickoff): string {
	return `DevSpec work kickoff: ${JSON.stringify(kickoff)}`;
}

export function formatImplementationContext(context: EffectiveImplementationContext): string {
	const identity = [
		`version=${context.contractVersion}`,
		context.contractHash ? `hash=${context.contractHash}` : null,
		context.effectiveHash ? `effective=${context.effectiveHash}` : null,
		`mode=${context.executionMode}`,
		`source=${context.source}`,
	].filter(Boolean).join(" · ");
	return [
		`${context.source === "local_safety_fallback" ? "Local safety fallback (the referenced product contract was unavailable)" : "Product implementation contract"} (${identity})`,
		...(context.warning ? [`Safety notice: ${context.warning}`] : []),
		"Core rules:",
		...context.coreRules.map((rule) => `- [${rule.id}] ${rule.requirement}`),
		`${context.executionMode === "attended" ? "Attended" : "Unattended"} overlay:`,
		...context.modeRules.map((rule) => `- [${rule.id}] ${rule.requirement}`),
	].join("\n");
}

export function resetImplementationContractCache(): void {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	root[CACHE_KEY] = {
		byIdentity: new Map(),
		latestByResource: new Map(),
		verifiedBundleHashes: new Map(),
	};
}
