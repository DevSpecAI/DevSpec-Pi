/**
 * DevSpec Pi — owner-scoped automation-run envelopes (pure, unit-tested).
 *
 * `poll_connection.dispatches[]` and `get_connection_dispatch` are transport
 * names retained by the server API. Their only executable payload in Pi is a
 * typed automation run. Action-item work is selected and reserved locally; it
 * never enters this path.
 */

import { AUTOMATION_RUN_PREFIX } from "./turn-lifecycle.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Only this typed envelope may enter the remote automation queue. */
export function isAutomationRunEnvelope(value: unknown): boolean {
	return asRecord(value)?.kind === "automation_run";
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
	return [
		`${AUTOMATION_RUN_PREFIX} to ${codename}]`,
		`DevSpec automation run ${runId} is ready.`,
		"Claim it with claim_automation_run, follow the supplied instruction, then record_automation_run truthfully.",
		"",
		"Automation run envelope:",
		"```json",
		JSON.stringify(value, null, 2),
		"```",
	].join("\n");
}
