/**
 * Process-local proof that one Pi session observed a successful server claim in
 * one canonical repository. The globalThis store joins separate jiti graphs but
 * is never reconstructed from prompts, deliveries, footer state, or transcript.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface ClaimAuthorityScope {
	sessionId: string;
	repoRoot: string;
}

export interface ClaimAuthority extends ClaimAuthorityScope {
	actionItemId: string;
	observedAt: number;
}

interface ClaimAuthorityStore {
	claims: Map<string, ClaimAuthority>;
}

const CLAIM_AUTHORITY_KEY = Symbol.for("devspec.pi.claim-authority.v2");
const FULL_ACTION_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_WORK_VERBS = new Set([
	"record_implementation",
	"release_work_item",
	"fail_work_item",
]);

function store(): ClaimAuthorityStore {
	const root = globalThis as typeof globalThis & { [CLAIM_AUTHORITY_KEY]?: ClaimAuthorityStore };
	const current = root[CLAIM_AUTHORITY_KEY];
	if (!current || !(current.claims instanceof Map)) root[CLAIM_AUTHORITY_KEY] = { claims: new Map() };
	return root[CLAIM_AUTHORITY_KEY]!;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function exactNonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value === value.trim() ? value : undefined;
}

/** Resolve the repository identity without invoking a shell, then canonicalize symlinks. */
export function canonicalRepoRoot(cwd: string): string | null {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		return root ? realpathSync(root) : null;
	} catch {
		return null;
	}
}

export function claimAuthorityScope(sessionId: string, cwd: string): ClaimAuthorityScope | null {
	const exactSessionId = exactNonEmpty(sessionId);
	const repoRoot = canonicalRepoRoot(cwd);
	return exactSessionId && repoRoot ? { sessionId: exactSessionId, repoRoot } : null;
}

function authorityKey(scope: ClaimAuthorityScope, actionItemId: string): string {
	return `${scope.sessionId}\0${scope.repoRoot}\0${actionItemId}`;
}

function sameScope(left: ClaimAuthorityScope, right: ClaimAuthorityScope): boolean {
	return left.sessionId === right.sessionId && left.repoRoot === right.repoRoot;
}

function resultDetails(value: unknown): Record<string, unknown> | null {
	const root = record(value);
	if (!root) return null;
	return record(root.details) ?? root;
}

/** The full response identity; request arguments are never used as a fallback. */
function responseActionItemId(details: Record<string, unknown>): string | undefined {
	const direct = exactNonEmpty(details.action_item_id) ?? exactNonEmpty(details.id);
	if (direct) return direct;
	const actionItem = record(details.action_item);
	const item = record(details.item);
	return exactNonEmpty(actionItem?.id) ??
		exactNonEmpty(item?.id) ??
		exactNonEmpty(record(item?.action_item)?.id);
}

function matchingResponseItemId(args: Record<string, unknown>, details: Record<string, unknown>): string | undefined {
	const requested = exactNonEmpty(args.action_item_id);
	const confirmed = responseActionItemId(details);
	return requested && FULL_ACTION_ITEM_ID.test(requested) && confirmed === requested ? confirmed : undefined;
}

function hasNegativeMarker(details: Record<string, unknown>): boolean {
	return details.error != null || details.isError === true || details.ok === false ||
		details.success === false || details.claimed === false || details.blocked === true ||
		details.is_blocked === true;
}

function terminalSucceeded(name: string, details: Record<string, unknown>): boolean {
	if (hasNegativeMarker(details)) return false;
	if (name === "record_implementation") {
		return details.implementation_recorded === true || details.lifecycle === "implemented";
	}
	if (name === "release_work_item") {
		return details.success === true && (
			exactNonEmpty(details.released_at) !== undefined || typeof details.was_claimed === "boolean"
		);
	}
	if (name === "fail_work_item") {
		return details.failed === true || details.agent_activity === "failed";
	}
	return false;
}

/** Snapshot only; callers cannot mutate the authority store. */
export function listClaimAuthorities(scope?: ClaimAuthorityScope): ClaimAuthority[] {
	return [...store().claims.values()]
		.filter((claim) => !scope || sameScope(claim, scope))
		.map((claim) => ({ ...claim }));
}

export function hasClaimAuthority(scope: ClaimAuthorityScope, actionItemId?: string): boolean {
	if (actionItemId) return store().claims.has(authorityKey(scope, actionItemId));
	return listClaimAuthorities(scope).length > 0;
}

/**
 * Called only after the native DevSpec wrapper establishes MCP-level success.
 * Arming is stricter: the structured body must affirm claim_success and return
 * the exact full item id that was requested.
 */
export function observeSuccessfulWorkResult(
	name: string,
	args: Record<string, unknown>,
	result: unknown,
	scope: ClaimAuthorityScope,
): boolean {
	const details = resultDetails(result);
	if (!details) return false;
	const actionItemId = matchingResponseItemId(args, details);
	if (!actionItemId) return false;

	if (name === "claim_work_item") {
		if (details.claim_success !== true || hasNegativeMarker(details)) return false;
		store().claims.set(authorityKey(scope, actionItemId), {
			actionItemId,
			repoRoot: scope.repoRoot,
			sessionId: scope.sessionId,
			observedAt: Date.now(),
		});
		return true;
	}

	if (!TERMINAL_WORK_VERBS.has(name) || !terminalSucceeded(name, details)) return false;
	return store().claims.delete(authorityKey(scope, actionItemId));
}

/** Session lifecycle cleanup revokes only this session+repository runtime. */
export function clearClaimAuthorities(scope: ClaimAuthorityScope): number {
	let cleared = 0;
	for (const [key, claim] of store().claims) {
		if (!sameScope(claim, scope)) continue;
		store().claims.delete(key);
		cleared++;
	}
	return cleared;
}

/** Test-only whole-process reset; production lifecycle uses the scoped clear above. */
export function resetClaimAuthoritiesForTests(): void {
	store().claims.clear();
}
