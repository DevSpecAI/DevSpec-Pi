/**
 * DevSpec Pi — wake-channel envelopes (pure, unit-tested).
 *
 * `poll_connection.dispatches[]` and `get_connection_dispatch` are transport
 * names retained by the server API. Each item is exactly one of two typed
 * envelopes: an automation run, or (once Pi negotiates CHECK_JOB_VERSION) a
 * check job, which asks this agent to rule a check DevSpec ran on a change
 * (DevSpec item 55d71b0c, decision c7cf2398). Anything else is inert. Task
 * work is selected and reserved locally; it never enters this path.
 */

import { AUTOMATION_RUN_PREFIX, CHECK_JOB_PREFIX } from "./turn-lifecycle.ts";

/**
 * The check-job wake-channel version Pi sends on every poll and the stream
 * (served contract: check_job.negotiation). Version 2 (DevSpec item 1d89fe56)
 * drops high_risk from the envelope and adds three record types. Pi negotiates 2
 * only: the server then sends version-2 envelopes and nothing else.
 */
export const CHECK_JOB_VERSION = 2;

const WAKE_KEYS = [
	"id",
	"kind",
	"run_id",
	"automation_id",
	"automation_name",
	"trigger_kind",
	"owner",
	"permission",
	"queued_at",
	"delivery_connection_id",
	"requester",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isOwner(value: unknown): value is { user_id: string; display_name: string } {
	const owner = asRecord(value);
	return Boolean(
		owner &&
		Object.keys(owner).length === 2 &&
		text(owner.user_id) &&
		text(owner.display_name),
	);
}

/** Only this typed envelope may enter the remote automation queue. */
export function isAutomationRunEnvelope(value: unknown): boolean {
	const root = asRecord(value);
	if (!root) return false;
	if (Object.keys(root).length !== WAKE_KEYS.length || WAKE_KEYS.some((key) => !Object.hasOwn(root, key))) {
		return false;
	}
	const pressed = root.trigger_kind === "pressed";
	const requesterOk = pressed
		? Boolean(asRecord(root.requester) && text(asRecord(root.requester)?.user_id))
		: root.requester === null;
	return root.kind === "automation_run" &&
		Boolean(text(root.id)) &&
		root.run_id === root.id &&
		Boolean(text(root.automation_id)) &&
		Boolean(text(root.automation_name)) &&
		(root.trigger_kind === "scheduled" || root.trigger_kind === "event" || root.trigger_kind === "pressed") &&
		isOwner(root.owner) &&
		(root.permission === "look_only" || root.permission === "can_commit" || root.permission === "can_push") &&
		Boolean(text(root.queued_at)) &&
		Boolean(text(root.delivery_connection_id)) &&
		requesterOk;
}

/**
 * The exact keys of a version-2 check job envelope: inbox metadata only, never
 * record text (served contract: check_job.envelope).
 */
const CHECK_JOB_WAKE_KEYS = [
	"id",
	"kind",
	"check_job_id",
	"check_kind",
	"record",
	"entries",
	"yours",
	"offered_at",
	"delivery_connection_id",
] as const;
const CHECK_KINDS = new Set(["conflict", "conflict_decisions", "duplicate", "staleness"]);
/** What a check job may name (served contract: check_job.records). */
const CHECK_RECORD_TYPES = new Set(["task", "memory", "artifact", "proposal", "discussion_point", "goal", "backlog_scan"]);
/** The record types version 2 added: each is only ever an out-of-date check. */
const STALENESS_ONLY_RECORD_TYPES = new Set(["discussion_point", "goal", "backlog_scan"]);

function exactKeys(root: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(root).length === keys.length && keys.every((key) => Object.hasOwn(root, key));
}

function count(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A check job: exactly its wake keys, `kind` check_job and `id` equal to `check_job_id`. */
export function isCheckJobEnvelope(value: unknown): boolean {
	const root = asRecord(value);
	if (!root || !exactKeys(root, CHECK_JOB_WAKE_KEYS)) return false;
	const record = asRecord(root.record);
	return root.kind === "check_job" &&
		Boolean(text(root.id)) &&
		root.check_job_id === root.id &&
		typeof root.check_kind === "string" && CHECK_KINDS.has(root.check_kind) &&
		Boolean(record && exactKeys(record, ["type", "id", "title"]) &&
			typeof record.type === "string" && CHECK_RECORD_TYPES.has(record.type) &&
			(!STALENESS_ONLY_RECORD_TYPES.has(record.type) || root.check_kind === "staleness") &&
			text(record.id) && typeof record.title === "string") &&
		count(root.entries) &&
		typeof root.yours === "boolean" &&
		Boolean(text(root.offered_at)) &&
		Boolean(text(root.delivery_connection_id));
}

/** One wake-channel item Pi accepts: an automation run (unchanged) or a check job. */
export function isDispatchEnvelope(value: unknown): boolean {
	return isAutomationRunEnvelope(value) || isCheckJobEnvelope(value);
}

/** Exact server-owned retry identity for a typed automation run. */
export function automationRunId(value: unknown): string | undefined {
	if (!isAutomationRunEnvelope(value)) return undefined;
	const root = asRecord(value);
	return text(root?.run_id) ?? text(root?.id);
}

/** Exact server-owned identity (dedupe and retry key) of either envelope; undefined for anything else. */
export function dispatchId(value: unknown): string | undefined {
	if (isCheckJobEnvelope(value)) return text(asRecord(value)?.id);
	return automationRunId(value);
}

/**
 * What a check job is about, in the wake line. A task, memory, document or
 * proposal is named by its title. The three version-2 records are always
 * out-of-date checks and say what they are: a settled discussion point, a Goal,
 * or the manual whole-backlog scan.
 */
export function describeCheckJob(value: unknown): string {
	if (!isCheckJobEnvelope(value)) throw new Error("check job envelope required");
	const record = asRecord(asRecord(value)?.record) ?? {};
	const title = text(record.title);
	const named = (what: string) => title ? `${what} “${title}”` : `${what} ${String(record.id)}`;
	switch (record.type) {
		case "discussion_point":
			return `An out-of-date check is waiting on ${named("the settled discussion point")}`;
		case "goal":
			return `An out-of-date check is waiting on ${named("the Goal")}`;
		case "backlog_scan":
			return title ? `The whole-backlog out-of-date scan “${title}” is waiting` : "The whole-backlog out-of-date scan is waiting";
		default:
			return `A check is waiting on ${title ?? `${String(record.type)} ${String(record.id)}`}`;
	}
}

/**
 * The wake for one check job: the contract's one line, then the envelope so the
 * agent has the job's id. How to rule it is in the bonded instructions; this
 * never words what the agent tells its person.
 */
export function formatCheckJobMessage(value: unknown, codename: string): string {
	if (!isCheckJobEnvelope(value)) throw new Error("check job envelope required");
	return [
		`${CHECK_JOB_PREFIX} to ${codename}]`,
		`${describeCheckJob(value)}: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.`,
		"",
		"Check job envelope:",
		"```json",
		JSON.stringify(value, null, 2),
		"```",
	].join("\n");
}

export function formatAutomationRunMessage(value: unknown, codename: string): string {
	const runId = automationRunId(value);
	if (!runId) throw new Error("automation run envelope requires a run id");
	const root = asRecord(value) ?? {};
	const name = text(root.automation_name) ?? "automation";
	const ownerName = isOwner(root.owner) ? root.owner.display_name : "the owner";
	const started =
		root.trigger_kind === "pressed"
			? "Someone pressed Run."
			: root.trigger_kind === "scheduled"
				? "This run started on a schedule."
				: "This run started because of an event.";
	const permission =
		root.permission === "can_push"
			? "You MAY edit, commit and push."
			: root.permission === "can_commit"
				? "You MAY edit and commit locally, but MUST NOT push."
				: "This automation is LOOK ONLY — investigate and report; do not edit, commit or push.";
	return [
		`${AUTOMATION_RUN_PREFIX} to ${codename}]`,
		`DevSpec automation run ${runId} (${name}) is ready.`,
		started,
		`Owner: ${ownerName}`,
		`Permission: ${permission}`,
		"Claim it with claim_automation_run to receive the instruction, then record_automation_run truthfully.",
		"",
		"Automation run envelope:",
		"```json",
		JSON.stringify(value, null, 2),
		"```",
	].join("\n");
}
