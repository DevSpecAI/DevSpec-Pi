import { createHash } from "node:crypto";

/**
 * Strict negotiated active-session-plan projection for canonical ingress 1.3.
 *
 * The server owns this schema. Pi validates the complete projection before it
 * can affect tool activation or model context, then serializes it only at the
 * newest delivery tail. Presence is read-awareness, never mutation authority.
 */

export const ACTIVE_PLAN_PROJECTION_VERSION = 1 as const;
export const ACTIVE_PLAN_MAX_PLANS = 64;
export const ACTIVE_PLAN_MAX_STEPS = 64;
export const ACTIVE_PLAN_MAX_TITLE_CHARS = 300;
export const ACTIVE_PLAN_MAX_FAILURE_REASON_CHARS = 4_096;
export const ACTIVE_PLAN_MAX_IDENTITY_CHARS = 300;
export const ACTIVE_PLAN_MAX_TOTAL_TEXT_CHARS = 131_072;
export const ACTIVE_PLAN_AUTHORITY_NOTE =
	"Advisory read-awareness only. Presence does not authorize execution or mutation; manage_plan still requires a capability-authenticated caller identity, explicit plan_id for cross-plan work, and expected_revision." as const;
export const ACTIVE_PLAN_CLEAR_TOMBSTONE = [
	"== ACTIVE SESSION PLANS ==",
	"Authoritative current inventory: none.",
	"Any earlier active-session-plan projection in this conversation is stale. Do not continue, complete, abandon, or adopt a plan from that stale projection.",
].join("\n");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATETIME_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type ActivePlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface ActivePlanAgentIdentity {
	kind: "dev" | "connection";
	connection_id: string | null;
	agent_name: string;
	codename: string | null;
}

export interface ActiveSessionPlanStep {
	id: string;
	position: number;
	title: string;
	status: ActivePlanStepStatus;
	failure_reason?: string;
	retryable?: boolean;
}

export interface ActiveSessionPlan {
	id: string;
	title: string;
	revision: number;
	status: "active";
	created_at: string;
	origin: ActivePlanAgentIdentity;
	steward: ActivePlanAgentIdentity;
	owner: { user_id: string; display_name: string };
	orphaned: boolean;
	progress: { terminal: number; total: number; completed: number; skipped: number };
	steps: ActiveSessionPlanStep[];
}

export interface ActiveSessionPlansProjection {
	version: typeof ACTIVE_PLAN_PROJECTION_VERSION;
	advisory: true;
	authority_note: typeof ACTIVE_PLAN_AUTHORITY_NOTE;
	inventory: { returned: number; total_known: number; truncated: false };
	plans: ActiveSessionPlan[];
}

interface ActivePlanAwarenessStore {
	/** Pi local session id → SHA-256 of the last actually injected active projection. */
	injectedByLocalSession: Map<string, string>;
}

const AWARENESS_STORE_KEY = Symbol.for("devspec.pi.active-plan-awareness.v1");
const MAX_AWARENESS_SESSIONS = 100;

function awarenessStore(): ActivePlanAwarenessStore {
	const root = globalThis as typeof globalThis & { [AWARENESS_STORE_KEY]?: ActivePlanAwarenessStore };
	const current = root[AWARENESS_STORE_KEY];
	if (!current || !(current.injectedByLocalSession instanceof Map)) {
		root[AWARENESS_STORE_KEY] = { injectedByLocalSession: new Map() };
	}
	return root[AWARENESS_STORE_KEY]!;
}

function exactAwarenessKey(value: string): string | null {
	return value && value === value.trim() ? value : null;
}

/** Persist only a digest proving active-plan awareness reached this transcript. */
export function markActivePlanAwareness(localSessionId: string, activeTail: string): string | null {
	const key = exactAwarenessKey(localSessionId);
	if (!key || !activeTail || activeTail === ACTIVE_PLAN_CLEAR_TOMBSTONE) return null;
	const digest = createHash("sha256").update(activeTail, "utf8").digest("hex");
	const store = awarenessStore().injectedByLocalSession;
	store.delete(key);
	store.set(key, digest);
	while (store.size > MAX_AWARENESS_SESSIONS) {
		const oldest = store.keys().next().value;
		if (typeof oldest !== "string") break;
		store.delete(oldest);
	}
	return digest;
}

export function activePlanAwarenessHash(localSessionId: string): string | null {
	const key = exactAwarenessKey(localSessionId);
	return key ? awarenessStore().injectedByLocalSession.get(key) ?? null : null;
}

/** Clear only after the authoritative no-plan tombstone was actually injected. */
export function clearActivePlanAwareness(localSessionId: string): boolean {
	const key = exactAwarenessKey(localSessionId);
	return key ? awarenessStore().injectedByLocalSession.delete(key) : false;
}

export function resetActivePlanAwarenessForTests(): void {
	awarenessStore().injectedByLocalSession.clear();
}

type Row = Record<string, unknown>;

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function record(value: unknown, path: string): Row {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
	return value as Row;
}

function exactKeys(value: Row, keys: readonly string[], path: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail(path, `expected exactly ${expected.join(", ")}`);
	}
}

function boundedString(value: unknown, path: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		fail(path, `expected non-empty string <= ${max} characters`);
	}
	return value;
}

function uuid(value: unknown, path: string): string {
	const parsed = boundedString(value, path, 64);
	if (!UUID_RE.test(parsed)) fail(path, "expected UUID");
	return parsed;
}

function datetime(value: unknown, path: string): string {
	const parsed = boundedString(value, path, 64);
	if (!DATETIME_WITH_OFFSET_RE.test(parsed) || Number.isNaN(Date.parse(parsed))) fail(path, "expected offset datetime");
	return parsed;
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		fail(path, `expected integer ${minimum}..${maximum}`);
	}
	return value;
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") fail(path, "expected boolean");
	return value;
}

function identity(value: unknown, path: string): ActivePlanAgentIdentity {
	const row = record(value, path);
	exactKeys(row, ["kind", "connection_id", "agent_name", "codename"], path);
	if (row.kind !== "dev" && row.kind !== "connection") fail(`${path}.kind`, "expected dev | connection");
	const connectionId = row.connection_id === null ? null : uuid(row.connection_id, `${path}.connection_id`);
	if ((row.kind === "dev") !== (connectionId === null)) fail(`${path}.connection_id`, "identity kind contradicts connection id");
	return {
		kind: row.kind,
		connection_id: connectionId,
		agent_name: boundedString(row.agent_name, `${path}.agent_name`, ACTIVE_PLAN_MAX_IDENTITY_CHARS),
		codename: row.codename === null ? null : boundedString(row.codename, `${path}.codename`, ACTIVE_PLAN_MAX_IDENTITY_CHARS),
	};
}

function step(value: unknown, path: string): ActiveSessionPlanStep {
	const row = record(value, path);
	const status = row.status;
	if (!["pending", "in_progress", "completed", "failed", "skipped"].includes(String(status))) {
		fail(`${path}.status`, "unknown step status");
	}
	const failed = status === "failed";
	exactKeys(
		row,
		failed
			? row.failure_reason === undefined
				? ["id", "position", "title", "status", "retryable"]
				: ["id", "position", "title", "status", "failure_reason", "retryable"]
			: ["id", "position", "title", "status"],
		path,
	);
	return {
		id: uuid(row.id, `${path}.id`),
		position: integer(row.position, `${path}.position`, Number.MIN_SAFE_INTEGER),
		title: boundedString(row.title, `${path}.title`, ACTIVE_PLAN_MAX_TITLE_CHARS),
		status: status as ActivePlanStepStatus,
		...(failed ? {
			...(row.failure_reason === undefined ? {} : {
				failure_reason: boundedString(row.failure_reason, `${path}.failure_reason`, ACTIVE_PLAN_MAX_FAILURE_REASON_CHARS),
			}),
			retryable: boolean(row.retryable, `${path}.retryable`),
		} : {}),
	};
}

function plan(value: unknown, path: string): ActiveSessionPlan {
	const row = record(value, path);
	exactKeys(row, ["id", "title", "revision", "status", "created_at", "origin", "steward", "owner", "orphaned", "progress", "steps"], path);
	if (row.status !== "active") fail(`${path}.status`, "expected active");
	const owner = record(row.owner, `${path}.owner`);
	exactKeys(owner, ["user_id", "display_name"], `${path}.owner`);
	const progress = record(row.progress, `${path}.progress`);
	exactKeys(progress, ["terminal", "total", "completed", "skipped"], `${path}.progress`);
	if (!Array.isArray(row.steps) || row.steps.length > ACTIVE_PLAN_MAX_STEPS) fail(`${path}.steps`, `expected at most ${ACTIVE_PLAN_MAX_STEPS} steps`);
	const steps = row.steps.map((value, index) => step(value, `${path}.steps[${index}]`));
	const parsedProgress = {
		terminal: integer(progress.terminal, `${path}.progress.terminal`),
		total: integer(progress.total, `${path}.progress.total`),
		completed: integer(progress.completed, `${path}.progress.completed`),
		skipped: integer(progress.skipped, `${path}.progress.skipped`),
	};
	const completed = steps.filter((item) => item.status === "completed").length;
	const skipped = steps.filter((item) => item.status === "skipped").length;
	if (parsedProgress.total !== steps.length || parsedProgress.completed !== completed ||
		parsedProgress.skipped !== skipped || parsedProgress.terminal !== completed + skipped) {
		fail(`${path}.progress`, "progress does not match canonical steps");
	}
	return {
		id: uuid(row.id, `${path}.id`),
		title: boundedString(row.title, `${path}.title`, ACTIVE_PLAN_MAX_TITLE_CHARS),
		revision: integer(row.revision, `${path}.revision`, 1),
		status: "active",
		created_at: datetime(row.created_at, `${path}.created_at`),
		origin: identity(row.origin, `${path}.origin`),
		steward: identity(row.steward, `${path}.steward`),
		owner: {
			user_id: uuid(owner.user_id, `${path}.owner.user_id`),
			display_name: boundedString(owner.display_name, `${path}.owner.display_name`, ACTIVE_PLAN_MAX_IDENTITY_CHARS),
		},
		orphaned: boolean(row.orphaned, `${path}.orphaned`),
		progress: parsedProgress,
		steps,
	};
}

/** Parse the complete strict v1 inventory or throw without producing a partial projection. */
export function parseActiveSessionPlansProjection(value: unknown, path = "ingress.active_session_plans"): ActiveSessionPlansProjection {
	const row = record(value, path);
	exactKeys(row, ["version", "advisory", "authority_note", "inventory", "plans"], path);
	if (row.version !== ACTIVE_PLAN_PROJECTION_VERSION) fail(`${path}.version`, "unknown projection version");
	if (row.advisory !== true) fail(`${path}.advisory`, "projection must be advisory");
	if (row.authority_note !== ACTIVE_PLAN_AUTHORITY_NOTE) fail(`${path}.authority_note`, "unknown authority note");
	const inventory = record(row.inventory, `${path}.inventory`);
	exactKeys(inventory, ["returned", "total_known", "truncated"], `${path}.inventory`);
	if (inventory.truncated !== false) fail(`${path}.inventory.truncated`, "complete projection cannot be truncated");
	if (!Array.isArray(row.plans) || row.plans.length < 1 || row.plans.length > ACTIVE_PLAN_MAX_PLANS) {
		fail(`${path}.plans`, `expected 1..${ACTIVE_PLAN_MAX_PLANS} plans`);
	}
	const plans = row.plans.map((value, index) => plan(value, `${path}.plans[${index}]`));
	const returned = integer(inventory.returned, `${path}.inventory.returned`, 1, ACTIVE_PLAN_MAX_PLANS);
	const totalKnown = integer(inventory.total_known, `${path}.inventory.total_known`, 1, ACTIVE_PLAN_MAX_PLANS);
	if (returned !== plans.length || totalKnown !== plans.length) fail(`${path}.inventory`, "inventory metadata must describe the complete plans array");
	const totalTextChars = plans.reduce((total, item) => total + item.title.length +
		item.origin.agent_name.length + (item.origin.codename?.length ?? 0) +
		item.steward.agent_name.length + (item.steward.codename?.length ?? 0) +
		item.owner.display_name.length + item.steps.reduce((sum, entry) => sum + entry.title.length + (entry.failure_reason?.length ?? 0), 0), 0);
	if (totalTextChars > ACTIVE_PLAN_MAX_TOTAL_TEXT_CHARS) fail(`${path}.plans`, "active plan projection text exceeds safe bound");
	return {
		version: ACTIVE_PLAN_PROJECTION_VERSION,
		advisory: true,
		authority_note: ACTIVE_PLAN_AUTHORITY_NOTE,
		inventory: { returned, total_known: totalKnown, truncated: false },
		plans,
	};
}

const STEP_MARK: Record<ActivePlanStepStatus, string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
	failed: "[!]",
	skipped: "[-]",
};

function agentLabel(value: ActivePlanAgentIdentity): string {
	return value.kind === "dev"
		? "Dev"
		: `${value.agent_name}${value.codename ? ` · ${value.codename}` : ""} (${value.connection_id})`;
}

/** Compact deterministic delivery-tail serialization. Other agents' plans remain read-only. */
export function serializeActiveSessionPlansProjection(
	projection: ActiveSessionPlansProjection | null,
	connectionId: string,
): string {
	if (!projection) return "";
	const lines = ["== ACTIVE SESSION PLANS ==", projection.authority_note];
	for (const [index, item] of projection.plans.entries()) {
		const own = item.steward.connection_id === connectionId;
		lines.push(
			"",
			`${index + 1}. ${own ? "[OWN] " : "[ROOM · READ-ONLY] "}\"${item.title}\" | plan_id=${item.id} | revision=${item.revision} | active | steward=${agentLabel(item.steward)} | origin=${agentLabel(item.origin)} | owner=${item.owner.display_name} (${item.owner.user_id}) | orphaned=${item.orphaned} | progress=${item.progress.terminal}/${item.progress.total}`,
		);
		for (const entry of item.steps) {
			lines.push(`   ${STEP_MARK[entry.status]} ${entry.position}. ${entry.title} | step_id=${entry.id} | status=${entry.status}${entry.status === "failed" ? ` | retryable=${entry.retryable} | failure=${JSON.stringify(entry.failure_reason)}` : ""}`);
		}
		if (!own) continue;
		const allTerminal = item.progress.total > 0 && item.progress.terminal === item.progress.total;
		const inProgress = item.steps.find((entry) => entry.status === "in_progress");
		lines.push(
			`   Own-plan guidance: first decide whether to complete, continue, hand off for adoption where supported, or abandon this plan; never silently drop, restart, or infer mutation authority from this projection. Every manage_plan mutation must use plan_id=${item.id} and expected_revision=${item.revision}.`,
			allTerminal
				? "   All steps are terminal: complete only if the outcome was achieved; otherwise abandon with a specific reason."
				: inProgress
					? `   To continue, resume the in_progress step step_id=${inProgress.id} before starting any pending step. If the user pivoted, abandon with a specific reason; if unsure, ask before another tool action.`
					: "   To continue, start the next pending step before acting. If the user pivoted, abandon with a specific reason; if another supported connection should continue, leave the plan for explicit adoption; if unsure, ask before another tool action.",
		);
		const failed = item.steps.filter((entry) => entry.status === "failed");
		if (failed.some((entry) => entry.retryable)) lines.push("   Failed-step guidance: a retryable failed step may be restarted once; if it fails again, stop and ask rather than looping.");
		if (failed.some((entry) => !entry.retryable)) lines.push("   Failed-step guidance: do not retry a non-retryable failed step; explain it and ask whether to skip, amend, or abandon.");
	}
	return lines.join("\n");
}

/**
 * Calculate the one-shot tail for an authoritative inventory transition.
 * Never-had-plan → none stays silent; active → none emits one clearing tombstone.
 */
export function activePlanTransitionTail(previousCurrentTail: string, nextCurrentTail: string): string {
	if (previousCurrentTail === nextCurrentTail) return "";
	if (previousCurrentTail && !nextCurrentTail) return ACTIVE_PLAN_CLEAR_TOMBSTONE;
	return nextCurrentTail;
}

/**
 * Authoritative transition across pump replacement/reload/rebond. A fresh pump
 * has no plan content, so only the global injected hash can prove that a no-plan
 * tombstone is needed. The hash is not cleared until delivery.
 */
export function authoritativeActivePlanTransitionTail(
	localSessionId: string,
	previousCurrentTail: string,
	nextCurrentTail: string,
): string {
	const localTransition = activePlanTransitionTail(previousCurrentTail, nextCurrentTail);
	if (localTransition) return localTransition;
	return !nextCurrentTail && activePlanAwarenessHash(localSessionId)
		? ACTIVE_PLAN_CLEAR_TOMBSTONE
		: "";
}

/** A canonical queued turn uses the newest state; a local turn consumes pending change only. */
export function activePlanTailForDelivery(
	hasCanonicalOwnerTurn: boolean,
	currentTail: string,
	pendingTail: string,
): string {
	return hasCanonicalOwnerTurn ? currentTail || pendingTail : pendingTail;
}

/** Append only at the current delivery tail; never splice stable/history bytes. */
export function appendActivePlanTail(prefix: string, tail: string): string {
	if (!tail) return prefix;
	return prefix ? `${prefix}\n\n${tail}` : tail;
}
