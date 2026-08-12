/**
 * DevSpec Pi — dispatch (work assignment) formatting (pure, unit-tested).
 *
 * A poll_connection `dispatches[]` entry is a live work assignment. The
 * extension injects it as a user message so the agent runs the assignment
 * protocol with the native tools: get_assignment → acknowledge_assignment →
 * claim members → work → record_implementation → resolve_assignment.
 */

import { DISPATCH_PREFIX } from "./turn-lifecycle.ts";

/** Best-effort assignment id / item title out of a dispatch payload. */
export function dispatchSummary(dispatch: unknown): { assignmentId?: string; title?: string } {
	const d = dispatch as Record<string, unknown> | null;
	if (!d) return {};
	const assignmentId =
		(typeof d.assignment_id === "string" && d.assignment_id) ||
		(typeof d.id === "string" && d.id) ||
		undefined;
	const title =
		(typeof d.title === "string" && d.title) ||
		(typeof (d.item as Record<string, unknown> | undefined)?.title === "string"
			? ((d.item as Record<string, unknown>).title as string)
			: undefined) ||
		(typeof (d.action_item as Record<string, unknown> | undefined)?.title === "string"
			? ((d.action_item as Record<string, unknown>).title as string)
			: undefined) ||
		undefined;
	return { assignmentId, title };
}

export function formatDispatchMessage(dispatch: unknown, codename: string): string {
	const { assignmentId, title } = dispatchSummary(dispatch);
	const payloadJson = JSON.stringify(dispatch, null, 2);
	return [
		`${DISPATCH_PREFIX} to ${codename}]`,
		`You have been dispatched DevSpec work${title ? `: **${title}**` : ""}.`,
		"",
		"Run the assignment protocol with the native tools:",
		`1. get_assignment${assignmentId ? ` (assignment_id: "${assignmentId}")` : ""} — read the batch and its members.`,
		"2. acknowledge_assignment once, before claiming anything.",
		"3. Claim each member with claim_work_item, implement it, tag commits [devspec:<id>], record_implementation when pushed. Use report_progress for long-running items.",
		"4. resolve_assignment when the batch is done (outcome completed, or released to hand it back).",
		"",
		"Dispatch payload:",
		"```json",
		payloadJson,
		"```",
	].join("\n");
}
