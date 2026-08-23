/**
 * Process-local observations used for status and one advisory provenance nudge.
 *
 * This is deliberately not authority. A server-confirmed claim is useful
 * coordination context, but no filesystem, shell, commit, push, or completion
 * path asks this store for permission. globalThis joins Pi's separate jiti
 * module graphs without persisting state across processes.
 */

export interface ObservedClaim {
	sessionId: string;
	actionItemId: string;
	projectId?: string;
	observedAt: number;
}

interface WorkStateStore {
	claims: Map<string, ObservedClaim>;
	nudgedProjects: Set<string>;
}

const WORK_STATE_KEY = Symbol.for("devspec.pi.work-state.v1");
const FULL_ACTION_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_WORK_VERBS = new Set(["record_implementation", "release_work_item", "fail_work_item"]);
const MAX_OBSERVED_CLAIMS = 100;

function store(): WorkStateStore {
	const root = globalThis as typeof globalThis & { [WORK_STATE_KEY]?: WorkStateStore };
	const current = root[WORK_STATE_KEY];
	if (!current || !(current.claims instanceof Map) || !(current.nudgedProjects instanceof Set)) {
		root[WORK_STATE_KEY] = { claims: new Map(), nudgedProjects: new Set() };
	}
	return root[WORK_STATE_KEY]!;
}

function exactNonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value === value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function resultDetails(value: unknown): Record<string, unknown> | null {
	const root = record(value);
	if (!root) return null;
	return record(root.details) ?? root;
}

function responseProjectId(details: Record<string, unknown>): string | undefined {
	const direct = exactNonEmpty(details.project_id);
	if (direct) return direct;
	const actionItem = record(details.action_item);
	const item = record(details.item);
	return exactNonEmpty(actionItem?.project_id) ??
		exactNonEmpty(item?.project_id) ??
		exactNonEmpty(record(item?.action_item)?.project_id);
}

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

function claimKey(sessionId: string, actionItemId: string): string {
	return `${sessionId}\0${actionItemId}`;
}

export function listObservedClaims(sessionId?: string): ObservedClaim[] {
	return [...store().claims.values()]
		.filter((claim) => !sessionId || claim.sessionId === sessionId)
		.map((claim) => ({ ...claim }));
}

export function hasObservedClaim(sessionId: string, projectId?: string): boolean {
	return listObservedClaims(sessionId).some((claim) => !projectId || claim.projectId === projectId);
}

/**
 * Consume only structured successful DevSpec results. The boolean means a claim
 * was newly observed and is used for footer display; it grants no permission.
 */
export function observeSuccessfulWorkResult(
	name: string,
	args: Record<string, unknown>,
	result: unknown,
	sessionId: string,
	projectId?: string,
): boolean {
	const exactSessionId = exactNonEmpty(sessionId);
	const details = resultDetails(result);
	if (!exactSessionId || !details) return false;
	const actionItemId = matchingResponseItemId(args, details);
	if (!actionItemId) return false;
	const resolvedProjectId = exactNonEmpty(projectId) ?? responseProjectId(details);

	if (name === "claim_work_item") {
		if (details.claim_success !== true || hasNegativeMarker(details)) return false;
		const current = store();
		current.claims.set(claimKey(exactSessionId, actionItemId), {
			sessionId: exactSessionId,
			actionItemId,
			...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
			observedAt: Date.now(),
		});
		while (current.claims.size > MAX_OBSERVED_CLAIMS) {
			const oldest = current.claims.keys().next().value;
			if (typeof oldest !== "string") break;
			current.claims.delete(oldest);
		}
		return true;
	}

	if (!TERMINAL_WORK_VERBS.has(name) || !terminalSucceeded(name, details)) return false;
	store().claims.delete(claimKey(exactSessionId, actionItemId));
	return false;
}

/** Returns true exactly once per Pi session and explicit project association. */
export function markProjectNudged(sessionId: string, projectId: string): boolean {
	const exactSessionId = exactNonEmpty(sessionId);
	const exactProjectId = exactNonEmpty(projectId);
	if (!exactSessionId || !exactProjectId) return false;
	const key = `${exactSessionId}\0${exactProjectId}`;
	const current = store();
	if (current.nudgedProjects.has(key)) return false;
	// Session ids are unique and /reload stays in the same process. Retaining the
	// spent key is what makes "at most one" absolute for that session/project.
	current.nudgedProjects.add(key);
	return true;
}

export function unmarkProjectNudged(sessionId: string, projectId: string): void {
	const exactSessionId = exactNonEmpty(sessionId);
	const exactProjectId = exactNonEmpty(projectId);
	if (!exactSessionId || !exactProjectId) return;
	store().nudgedProjects.delete(`${exactSessionId}\0${exactProjectId}`);
}

export function resetWorkStateForTests(): void {
	const current = store();
	current.claims.clear();
	current.nudgedProjects.clear();
}
