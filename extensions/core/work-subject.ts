/**
 * Mechanically reported agent work subject & last-resort staleness bound
 * (decision 6459a009, DevSpec item 5f082b61 / 2145bd84).
 *
 * Pure, unit-tested. Every wire shape matches DevSpecV2's strict
 * `parseWorkSubjectArg` validator:
 *   - `{ kind: "server_notice", id: "<uuid>" }`
 *   - `{ kind: "system_notice", id: "<uuid>" }`
 *   - `{ kind: "check_job", id: "<uuid>" }`
 *   - `{ kind: "automation_run", id: "<uuid>" }`
 *   - `{ kind: "command", id: "<uuid>" }`
 *   - `{ kind: "terminal" }` (no `id` field)
 */

/**
 * Last-resort staleness bound (hours) for an unchanged host progress marker
 * (decision 6459a009). Pi imposes no 60-minute cutoff on long-running turns;
 * 24 hours is the server's absolute last resort against permanently wedged hosts.
 */
export const ACTIVITY_PROGRESS_STALENESS_HOURS = 24 as const;
export const ACTIVITY_PROGRESS_STALENESS_MS = ACTIVITY_PROGRESS_STALENESS_HOURS * 60 * 60 * 1000;

/**
 * Shared pump-lane HTTP request timeout for mechanical working-state lifecycle
 * calls (`report_pickup`, `report_keepalive`, `report_complete`) (decision
 * 91d7b47c / requirement 3c5147a7, item 2145bd84).
 * Logical justification: 10 seconds tolerates brief network jitter on lifecycle
 * state updates while staying well inside the poll interval and hook timeout budgets.
 */
export const TURN_LIFECYCLE_REQUEST_TIMEOUT_MS = 10_000 as const;

export const WORK_SUBJECT_KINDS = [
	"server_notice",
	"system_notice",
	"check_job",
	"automation_run",
	"command",
	"terminal",
] as const;

export type WorkSubjectKind = (typeof WORK_SUBJECT_KINDS)[number];
export type IdentifiedWorkSubjectKind = Exclude<WorkSubjectKind, "terminal">;

export type WorkSubject =
	| { kind: "server_notice"; id: string }
	| { kind: "system_notice"; id: string }
	| { kind: "check_job"; id: string }
	| { kind: "automation_run"; id: string }
	| { kind: "command"; id: string }
	| { kind: "terminal" };

export type NonCommandWorkSubject = Exclude<WorkSubject, { kind: "command" }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Validate and normalize a UUID for identified work subjects; null if invalid. */
export function validWorkSubjectUuid(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function isNonCommandWorkSubject(
	subject: WorkSubject | null | undefined,
): subject is NonCommandWorkSubject {
	return subject != null && subject.kind !== "command";
}

/**
 * Non-chat wake subjects (`server_notice`, `system_notice`, `check_job`,
 * `automation_run`) stream live `phase: "trail"` diagnostics onto their
 * source-less working attempt without naming a command turn or opening a chat bubble.
 */
export function isNonChatWorkSubject(subject: WorkSubject | null | undefined): boolean {
	if (!subject) return false;
	return subject.kind === "server_notice"
		|| subject.kind === "system_notice"
		|| subject.kind === "check_job"
		|| subject.kind === "automation_run";
}

export function workSubjectEquals(
	a: WorkSubject | null | undefined,
	b: WorkSubject | null | undefined,
): boolean {
	if (a == null && b == null) return true;
	if (a == null || b == null || a.kind !== b.kind) return false;
	if (a.kind === "terminal" && b.kind === "terminal") return true;
	return "id" in a && "id" in b && a.id === b.id;
}

export function terminalWorkSubject(): { kind: "terminal" } {
	return { kind: "terminal" };
}

export function workSubjectForCommand(commandMessageId: unknown): { kind: "command"; id: string } | null {
	const id = validWorkSubjectUuid(commandMessageId);
	return id ? { kind: "command", id } : null;
}

/**
 * Derive the mechanical work subject for a notice batch: prefer `server_notice`
 * when a batch mixes kinds, else the first notice with a valid UUID `notice_id`.
 */
export function workSubjectForNotices(
	notices: readonly unknown[],
): { kind: "server_notice" | "system_notice"; id: string } | null {
	let fallback: { kind: "system_notice"; id: string } | null = null;
	for (const raw of notices) {
		const notice = asRecord(raw);
		if (!notice) continue;
		const id = validWorkSubjectUuid(notice.notice_id);
		if (!id) continue;
		if (notice.kind === "server_notice") return { kind: "server_notice", id };
		if (!fallback) fallback = { kind: "system_notice", id };
	}
	return fallback;
}

/** Derive the mechanical work subject for one or more delivered check jobs. */
export function workSubjectForCheckJobs(jobs: readonly unknown[]): { kind: "check_job"; id: string } | null {
	for (const raw of jobs) {
		if (typeof raw === "string") {
			const id = validWorkSubjectUuid(raw);
			if (id) return { kind: "check_job", id };
			continue;
		}
		const entry = asRecord(raw);
		if (!entry) continue;
		const envelope = asRecord(entry.envelope);
		const id = validWorkSubjectUuid(envelope?.check_job_id ?? envelope?.id ?? entry.check_job_id ?? entry.id);
		if (id) return { kind: "check_job", id };
	}
	return null;
}

/** Derive the mechanical work subject for a delivered automation run. */
export function workSubjectForAutomationRun(value: unknown): { kind: "automation_run"; id: string } | null {
	if (typeof value === "string") {
		const id = validWorkSubjectUuid(value);
		return id ? { kind: "automation_run", id } : null;
	}
	const entry = asRecord(value);
	const id = validWorkSubjectUuid(entry?.run_id ?? entry?.id);
	return id ? { kind: "automation_run", id } : null;
}

/**
 * Fallback mechanical extraction from Pi's own formatted check-job or automation
 * wake message when no out-of-band queue entry was matched.
 */
export function workSubjectFromWakeText(
	kind: "check_job" | "automation",
	text: string,
): { kind: "check_job" | "automation_run"; id: string } | null {
	const key = kind === "check_job" ? "check_job_id" : "run_id";
	const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
	const id = validWorkSubjectUuid(match?.[1]);
	if (!id) return null;
	return kind === "check_job" ? { kind: "check_job", id } : { kind: "automation_run", id };
}

/**
 * Wire payload fragment for `heartbeat_connection` (status: "live") and `poll_connection`.
 * - While busy: include `work_subject` when known; omit if unknown.
 * - While idle: include `work_subject: null` once to clear a previously active subject;
 *   omit when already cleared / unchanged.
 */
export function workSubjectWireField(
	busy: boolean,
	subject: WorkSubject | null | undefined,
	needsClear: boolean,
): { work_subject?: WorkSubject | null } {
	if (busy) return subject ? { work_subject: subject } : {};
	return needsClear ? { work_subject: null } : {};
}

/**
 * Out-of-band FIFO map pairing formatted non-command wake messages (`check_job`,
 * `automation_run`) with their exact mechanical `WorkSubject` between `pi_send`
 * and `message_start`, mirroring `CommandTurnBindings`.
 */
export class PendingWorkSubjects {
	private pending: Array<{ message: string; subject: WorkSubject }> = [];

	remember(message: string, subject: WorkSubject | null): void {
		if (!subject) return;
		this.pending.push({ message, subject });
	}

	peek(message: string): WorkSubject | undefined {
		return this.pending.find((entry) => entry.message === message)?.subject;
	}

	take(message: string): WorkSubject | undefined {
		const index = this.pending.findIndex((entry) => entry.message === message);
		if (index === -1) return undefined;
		const [entry] = this.pending.splice(index, 1);
		return entry?.subject;
	}

	forget(message: string, subject: WorkSubject | null): void {
		if (!subject) return;
		const index = this.pending.findIndex((entry) =>
			entry.message === message && workSubjectEquals(entry.subject, subject));
		if (index !== -1) this.pending.splice(index, 1);
	}

	clear(): void {
		this.pending = [];
	}
}
