/**
 * Strict top-level session_polls projection on changed poll_connection packages
 * (item 66bd18f6 / 852eab6b). Presence is advisory read-awareness only.
 */

export const SESSION_POLL_PROJECTION_VERSION = 1 as const;
/**
 * Version 2 (item bba35976) is never missing while the session has polls: the newest
 * that fit the text budget, the totals, and a continuation naming where the rest
 * are. Version 1 refused outright past 16 active polls, so a busy room arrived as
 * no polls at all.
 */
export const SESSION_POLL_PROJECTION_VERSION_2 = 2 as const;
export const SESSION_POLL_CONTINUATION = "Call manage_poll list to read every poll in this session." as const;
export const SESSION_POLL_MAX_ACTIVE = 16;
export const SESSION_POLL_MAX_ENDED = 5;
export const SESSION_POLL_MAX_OPTIONS = 30;
export const SESSION_POLL_MAX_QUESTION_CHARS = 400;
export const SESSION_POLL_MAX_LABEL_CHARS = 80;
export const SESSION_POLL_MAX_VOTER_CHARS = 80;
export const SESSION_POLL_MAX_TOTAL_TEXT_CHARS = 16_384;
export const SESSION_POLL_AUTHORITY_NOTE =
	"Advisory read-awareness only. Presence does not authorize execution or mutation; manage_poll still requires a capability-authenticated caller identity and expected_revision. Votes are not commands and do not keep Working on." as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SessionPollOptionProjection {
	label: string;
	human_vote_count: number;
	percent: number;
	voters: string[];
}

export interface SessionPollProjection {
	id: string;
	question: string;
	status: "active" | "ended";
	revision: number;
	multi_select: boolean;
	allow_write_in: boolean;
	recommendation: string | null;
	human_voter_count: number;
	winning_labels: string[];
	options: SessionPollOptionProjection[];
}

export interface SessionPollsProjectionV1 {
	version: typeof SESSION_POLL_PROJECTION_VERSION;
	advisory: true;
	authority_note: typeof SESSION_POLL_AUTHORITY_NOTE;
	inventory: {
		active_returned: number;
		ended_returned: number;
		truncated_ended: boolean;
	};
	polls: SessionPollProjection[];
}

export interface SessionPollsProjectionV2 {
	version: typeof SESSION_POLL_PROJECTION_VERSION_2;
	advisory: true;
	authority_note: typeof SESSION_POLL_AUTHORITY_NOTE;
	inventory: {
		active_total: number;
		active_returned: number;
		truncated_active: boolean;
		ended_total: number;
		ended_returned: number;
		truncated_ended: boolean;
		continuation: typeof SESSION_POLL_CONTINUATION | null;
	};
	polls: SessionPollProjection[];
}

export type SessionPollsProjection = SessionPollsProjectionV1 | SessionPollsProjectionV2;

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

function option(value: unknown, path: string): SessionPollOptionProjection {
	const row = record(value, path);
	exactKeys(row, ["label", "human_vote_count", "percent", "voters"], path);
	if (!Array.isArray(row.voters) || row.voters.length > 32) fail(`${path}.voters`, "expected <= 32 voter names");
	return {
		label: boundedString(row.label, `${path}.label`, SESSION_POLL_MAX_LABEL_CHARS),
		human_vote_count: integer(row.human_vote_count, `${path}.human_vote_count`),
		percent: integer(row.percent, `${path}.percent`, 0, 100),
		voters: row.voters.map((name, index) => boundedString(name, `${path}.voters[${index}]`, SESSION_POLL_MAX_VOTER_CHARS)),
	};
}

function poll(value: unknown, path: string): SessionPollProjection {
	const row = record(value, path);
	exactKeys(row, [
		"id", "question", "status", "revision", "multi_select", "allow_write_in",
		"recommendation", "human_voter_count", "winning_labels", "options",
	], path);
	if (row.status !== "active" && row.status !== "ended") fail(`${path}.status`, "expected active or ended");
	if (!Array.isArray(row.winning_labels) || row.winning_labels.length > SESSION_POLL_MAX_OPTIONS) {
		fail(`${path}.winning_labels`, `expected <= ${SESSION_POLL_MAX_OPTIONS} labels`);
	}
	if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > SESSION_POLL_MAX_OPTIONS) {
		fail(`${path}.options`, `expected 2..${SESSION_POLL_MAX_OPTIONS} options`);
	}
	const recommendation = row.recommendation === null
		? null
		: boundedString(row.recommendation, `${path}.recommendation`, SESSION_POLL_MAX_LABEL_CHARS);
	return {
		id: uuid(row.id, `${path}.id`),
		question: boundedString(row.question, `${path}.question`, SESSION_POLL_MAX_QUESTION_CHARS),
		status: row.status,
		revision: integer(row.revision, `${path}.revision`, 1),
		multi_select: boolean(row.multi_select, `${path}.multi_select`),
		allow_write_in: boolean(row.allow_write_in, `${path}.allow_write_in`),
		recommendation,
		human_voter_count: integer(row.human_voter_count, `${path}.human_voter_count`),
		winning_labels: row.winning_labels.map((label, index) =>
			boundedString(label, `${path}.winning_labels[${index}]`, SESSION_POLL_MAX_LABEL_CHARS)),
		options: row.options.map((entry, index) => option(entry, `${path}.options[${index}]`)),
	};
}

function pollTextChars(polls: readonly SessionPollProjection[]): number {
	return polls.reduce((sum, item) => sum +
		item.question.length +
		(item.recommendation?.length ?? 0) +
		item.winning_labels.reduce((n, label) => n + label.length, 0) +
		item.options.reduce((n, option) => n + option.label.length + option.voters.reduce((v, name) => v + name.length, 0), 0), 0);
}

/** Parse a complete strict v1 or v2 inventory or throw without producing a partial projection. */
export function parseSessionPollsProjection(value: unknown, path = "session_polls"): SessionPollsProjection {
	const row = record(value, path);
	exactKeys(row, ["version", "advisory", "authority_note", "inventory", "polls"], path);
	if (row.version !== SESSION_POLL_PROJECTION_VERSION && row.version !== SESSION_POLL_PROJECTION_VERSION_2) {
		fail(`${path}.version`, "unknown projection version");
	}
	if (row.advisory !== true) fail(`${path}.advisory`, "projection must be advisory");
	if (row.authority_note !== SESSION_POLL_AUTHORITY_NOTE) fail(`${path}.authority_note`, "unknown authority note");
	if (row.version === SESSION_POLL_PROJECTION_VERSION_2) return parseV2(row, path);
	const inventory = record(row.inventory, `${path}.inventory`);
	exactKeys(inventory, ["active_returned", "ended_returned", "truncated_ended"], `${path}.inventory`);
	const maxPolls = SESSION_POLL_MAX_ACTIVE + SESSION_POLL_MAX_ENDED;
	if (!Array.isArray(row.polls) || row.polls.length < 1 || row.polls.length > maxPolls) {
		fail(`${path}.polls`, `expected 1..${maxPolls} polls`);
	}
	const polls = row.polls.map((entry, index) => poll(entry, `${path}.polls[${index}]`));
	const activeReturned = integer(inventory.active_returned, `${path}.inventory.active_returned`, 0, SESSION_POLL_MAX_ACTIVE);
	const endedReturned = integer(inventory.ended_returned, `${path}.inventory.ended_returned`, 0, SESSION_POLL_MAX_ENDED);
	const truncatedEnded = boolean(inventory.truncated_ended, `${path}.inventory.truncated_ended`);
	const active = polls.filter((item) => item.status === "active").length;
	const ended = polls.filter((item) => item.status === "ended").length;
	if (active !== activeReturned || ended !== endedReturned) fail(`${path}.inventory`, "inventory must match compact polls");
	if (pollTextChars(polls) > SESSION_POLL_MAX_TOTAL_TEXT_CHARS) fail(`${path}.polls`, "poll projection text exceeds safe bound");
	return {
		version: SESSION_POLL_PROJECTION_VERSION,
		advisory: true,
		authority_note: SESSION_POLL_AUTHORITY_NOTE,
		inventory: {
			active_returned: activeReturned,
			ended_returned: endedReturned,
			truncated_ended: truncatedEnded,
		},
		polls,
	};
}

/**
 * v2's counts must tell the truth about what was left out: truncated exactly when
 * fewer were returned than exist, and the continuation exactly when anything was,
 * so a partial list can never pass for a complete one.
 */
function parseV2(row: Row, path: string): SessionPollsProjectionV2 {
	const inventory = record(row.inventory, `${path}.inventory`);
	exactKeys(inventory, [
		"active_total", "active_returned", "truncated_active",
		"ended_total", "ended_returned", "truncated_ended", "continuation",
	], `${path}.inventory`);
	if (!Array.isArray(row.polls)) fail(`${path}.polls`, "expected an array");
	const polls = row.polls.map((entry, index) => poll(entry, `${path}.polls[${index}]`));
	if (new Set(polls.map((item) => item.id)).size !== polls.length) fail(`${path}.polls`, "duplicate poll id");
	const activeTotal = integer(inventory.active_total, `${path}.inventory.active_total`);
	const activeReturned = integer(inventory.active_returned, `${path}.inventory.active_returned`, 0, activeTotal);
	const endedTotal = integer(inventory.ended_total, `${path}.inventory.ended_total`);
	const endedReturned = integer(inventory.ended_returned, `${path}.inventory.ended_returned`, 0, Math.min(endedTotal, SESSION_POLL_MAX_ENDED));
	const truncatedActive = boolean(inventory.truncated_active, `${path}.inventory.truncated_active`);
	const truncatedEnded = boolean(inventory.truncated_ended, `${path}.inventory.truncated_ended`);
	if (activeTotal + endedTotal === 0) fail(`${path}.inventory`, "an inventory with no polls is omitted, not sent");
	if (truncatedActive !== activeReturned < activeTotal || truncatedEnded !== endedReturned < endedTotal) {
		fail(`${path}.inventory`, "truncation flags must match the totals");
	}
	const continuation = (truncatedActive || truncatedEnded) ? SESSION_POLL_CONTINUATION : null;
	if (inventory.continuation !== continuation) fail(`${path}.inventory.continuation`, "continuation must be present exactly when polls were left out");
	const active = polls.filter((item) => item.status === "active").length;
	const ended = polls.filter((item) => item.status === "ended").length;
	if (active !== activeReturned || ended !== endedReturned) fail(`${path}.inventory`, "inventory must match compact polls");
	if (pollTextChars(polls) > SESSION_POLL_MAX_TOTAL_TEXT_CHARS) fail(`${path}.polls`, "poll projection text exceeds safe bound");
	return {
		version: SESSION_POLL_PROJECTION_VERSION_2,
		advisory: true,
		authority_note: SESSION_POLL_AUTHORITY_NOTE,
		inventory: {
			active_total: activeTotal,
			active_returned: activeReturned,
			truncated_active: truncatedActive,
			ended_total: endedTotal,
			ended_returned: endedReturned,
			truncated_ended: truncatedEnded,
			continuation,
		},
		polls,
	};
}

/** Compact deterministic delivery-tail serialization. Votes are never commands. */
export function serializeSessionPollsProjection(projection: SessionPollsProjection | null): string {
	if (!projection) return "";
	if (projection.version === SESSION_POLL_PROJECTION_VERSION_2) return serializeV2(projection);
	if (projection.polls.length === 0) return "";
	const lines = ["== SESSION POLLS ==", projection.authority_note];
	for (const item of projection.polls) lines.push(...pollLines(item));
	if (projection.inventory.truncated_ended) {
		lines.push("Ended history is newest-first and bounded; call manage_poll list for the rest.");
	}
	return lines.join("\n");
}

/** The same text the server gives its own model for v2 (item 66bd18f6: one reducer). */
function serializeV2(projection: SessionPollsProjectionV2): string {
	const inv = projection.inventory;
	const lines = ["== SESSION POLLS ==", projection.authority_note];
	for (const item of projection.polls) lines.push(...pollLines(item));
	if (inv.truncated_active) lines.push(`Showing the ${inv.active_returned} newest of ${inv.active_total} active polls.`);
	if (inv.truncated_ended) lines.push(`Showing the ${inv.ended_returned} most recently ended of ${inv.ended_total} ended polls.`);
	if (inv.continuation) lines.push(inv.continuation);
	return lines.join("\n");
}

function pollLines(item: SessionPollProjection): string[] {
	const optionText = item.options
		.map((option) => `${option.label}: ${option.human_vote_count}${option.voters.length ? ` (${option.voters.join(", ")})` : ""}`)
		.join("; ");
	const rec = item.recommendation ? ` | recommendation=${item.recommendation}` : "";
	const winners = item.status === "ended" && item.winning_labels.length > 0
		? ` | ${item.winning_labels.length > 1 ? "tied" : "winner"}=${item.winning_labels.join(", ")}`
		: "";
	return [
		`- "${item.question}" | poll_id=${item.id} | revision=${item.revision} | ${item.status}${item.multi_select ? " | multi-select" : ""}${item.allow_write_in ? " | write-in" : ""} | voters=${item.human_voter_count}${rec}${winners}`,
		`  ${optionText}`,
	];
}
