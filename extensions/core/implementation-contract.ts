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
}

const CACHE_KEY = Symbol.for("devspec.pi.implementation-contract.v1");

function cache(): ContractCache {
	const root = globalThis as typeof globalThis & { [CACHE_KEY]?: ContractCache };
	if (!root[CACHE_KEY]) {
		root[CACHE_KEY] = { byIdentity: new Map(), latestByResource: new Map() };
	}
	return root[CACHE_KEY];
}

function cacheIdentity(scope: string, resourceUri: string, contractVersion: string): string {
	return `${scope}\u0000${resourceUri}\u0000${contractVersion}`;
}

function latestIdentity(scope: string, resourceUri: string): string {
	return `${scope}\u0000${resourceUri}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRules(value: unknown): ImplementationRule[] | null {
	const section = asRecord(value);
	if (!section || !Array.isArray(section.rules)) return null;
	const rules: ImplementationRule[] = [];
	for (const candidate of section.rules) {
		const row = asRecord(candidate);
		const id = nonEmptyString(row?.id);
		const requirement = nonEmptyString(row?.requirement);
		if (!id || !requirement) return null;
		rules.push({
			id,
			requirement,
			...(nonEmptyString(row?.phase) ? { phase: nonEmptyString(row?.phase) } : {}),
			...(nonEmptyString(row?.enforcement) ? { enforcement: nonEmptyString(row?.enforcement) } : {}),
		});
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

function effectiveFromPayload(
	payload: unknown,
	executionMode: ImplementationExecutionMode,
	resourceUri: string,
): CachedContract | null {
	const parsed = parseJsonText(payload, resourceUri);
	const root = asRecord(parsed);
	if (!root) return null;
	const bundle = asRecord(root.implementation_contract) ?? root;
	const contractVersion = nonEmptyString(bundle.contract_version);
	const contractHash = nonEmptyString(bundle.contract_hash);
	if (!contractVersion) return null;

	const effectiveMode = nonEmptyString(bundle.execution_mode);
	if (effectiveMode && effectiveMode !== executionMode) return null;
	const coreRules = parseRules(bundle.core_implementation_contract);
	const modeRules = parseRules(
		bundle.mode_overlay ??
			(executionMode === "attended" ? bundle.attended_overlay : bundle.unattended_overlay),
	);
	if (!coreRules || !modeRules) return null;
	return {
		executionMode,
		contractVersion,
		...(contractHash ? { contractHash } : {}),
		...(nonEmptyString(bundle.effective_hash) ? { effectiveHash: nonEmptyString(bundle.effective_hash) } : {}),
		resourceUri,
		coreRules,
		modeRules,
	};
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

function storeContract(scope: string, value: CachedContract): void {
	const current = cache();
	current.byIdentity.set(cacheIdentity(scope, value.resourceUri, value.contractVersion), value);
	current.latestByResource.set(latestIdentity(scope, value.resourceUri), value);
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
}): Promise<EffectiveImplementationContext> {
	const expectedUri = IMPLEMENTATION_CONTRACT_RESOURCE_URIS[input.executionMode];
	const resourceUri = input.reference?.resource_uri ?? expectedUri;
	const expectedVersion = nonEmptyString(input.reference?.contract_version);
	const scope = await input.loader.cacheScope();
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
	try {
		const parsed = effectiveFromPayload(
			await input.loader.readResource(resourceUri),
			input.executionMode,
			resourceUri,
		);
		if (!parsed) throw new Error("resource payload was not a valid implementation contract");
		if (expectedVersion && parsed.contractVersion !== expectedVersion) {
			throw new Error(`resource version ${parsed.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, parsed);
		return { ...parsed, source: "resource" };
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	try {
		const parsed = effectiveFromPayload(
			await input.loader.readCompatibilityBundle(),
			input.executionMode,
			resourceUri,
		);
		if (!parsed) throw new Error("compatibility payload was not a valid implementation contract");
		if (expectedVersion && parsed.contractVersion !== expectedVersion) {
			throw new Error(`compatibility version ${parsed.contractVersion} did not match kickoff version ${expectedVersion}`);
		}
		storeContract(scope, parsed);
		return { ...parsed, source: "compatibility" };
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	const retained = cachedContract(scope, resourceUri, expectedVersion);
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
	/** Preserve the authenticated server delivery pointer while a local safety fallback is active. */
	contractReference?: ImplementationContractReference;
}): ImplementationKickoff {
	const actionItemIds = [...new Set(input.actionItemIds.map((id) => id.trim()).filter(Boolean))];
	if (actionItemIds.length === 0) throw new Error("implementation kickoff requires at least one action item id");
	const suppliedVersion = nonEmptyString(input.contractReference?.contract_version);
	if (input.contractReference && !suppliedVersion && input.context.source === "local_safety_fallback") {
		throw new Error("legacy implementation kickoff cannot identify a product contract while the server is unavailable");
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
	root[CACHE_KEY] = { byIdentity: new Map(), latestByResource: new Map() };
}
