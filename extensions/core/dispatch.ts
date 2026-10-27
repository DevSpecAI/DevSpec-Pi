/**
 * DevSpec Pi — owner-scoped automation-run envelopes (pure, unit-tested).
 *
 * `poll_connection.dispatches[]` and `get_connection_dispatch` are transport
 * names retained by the server API. Their only executable payload in Pi is a
 * typed automation run. Task work is selected and reserved locally; it
 * never enters this path.
 */

import { AUTOMATION_RUN_PREFIX } from "./turn-lifecycle.ts";

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

/** Exact server-owned retry identity for a typed automation run. */
export function automationRunId(value: unknown): string | undefined {
	if (!isAutomationRunEnvelope(value)) return undefined;
	const root = asRecord(value);
	return text(root?.run_id) ?? text(root?.id);
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
