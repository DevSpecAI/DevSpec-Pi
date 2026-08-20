/**
 * DevSpec Pi — owner-scoped playbook-run envelopes (pure, unit-tested).
 *
 * `poll_connection.dispatches[]` and `get_connection_dispatch` are transport
 * names retained by the server API. Their only executable payload in Pi is a
 * typed playbook run. Action-item work is selected and reserved locally; it
 * never enters this path.
 */

import { PLAYBOOK_RUN_PREFIX } from "./turn-lifecycle.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Only this typed envelope may enter the remote playbook queue. */
export function isPlaybookRunEnvelope(value: unknown): boolean {
	return asRecord(value)?.kind === "playbook_run";
}

/** Exact server-owned retry identity for a typed playbook run. */
export function playbookRunId(value: unknown): string | undefined {
	if (!isPlaybookRunEnvelope(value)) return undefined;
	const root = asRecord(value);
	return text(root?.run_id) ?? text(root?.id);
}

export function formatPlaybookRunMessage(value: unknown, codename: string): string {
	const runId = playbookRunId(value);
	if (!runId) throw new Error("playbook run envelope requires a run id");
	return [
		`${PLAYBOOK_RUN_PREFIX} to ${codename}]`,
		`DevSpec playbook run ${runId} is ready.`,
		"Claim it with claim_playbook_run, follow the supplied instruction, then record_playbook_run truthfully.",
		"",
		"Playbook run envelope:",
		"```json",
		JSON.stringify(value, null, 2),
		"```",
	].join("\n");
}
