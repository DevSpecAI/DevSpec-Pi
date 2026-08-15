/**
 * DevSpec Pi — thin work-assignment delivery (pure, unit-tested).
 *
 * The server dispatch already carries work identity, explicit execution mode,
 * and a contract pointer. Pi loads that contract mechanically and injects the
 * effective rules here. This file does not duplicate the implementation
 * workflow.
 */

import {
	buildImplementationKickoff,
	formatImplementationContext,
	formatImplementationKickoffHeader,
	IMPLEMENTATION_CONTRACT_RESOURCE_URIS,
	type EffectiveImplementationContext,
	type ImplementationContractReference,
	type ImplementationExecutionMode,
	type ImplementationKickoff,
} from "./implementation-contract.ts";
import { DISPATCH_PREFIX } from "./turn-lifecycle.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Best-effort assignment id / item title out of a dispatch payload. */
export function dispatchSummary(dispatch: unknown): { assignmentId?: string; title?: string } {
	const d = asRecord(dispatch);
	if (!d) return {};
	const members = Array.isArray(d.members) ? d.members.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
	const assignmentId = text(d.assignment_id) ?? text(d.id);
	const title =
		text(d.title) ??
		text(asRecord(d.item)?.title) ??
		text(asRecord(d.action_item)?.title) ??
		text(members[0]?.title);
	return {
		...(assignmentId ? { assignmentId } : {}),
		...(title ? { title } : {}),
	};
}

export function isPlaybookDispatch(dispatch: unknown): boolean {
	return asRecord(dispatch)?.kind === "playbook_run";
}

export interface DispatchImplementationDelivery {
	assignmentId: string;
	actionItemIds: string[];
	executionMode: ImplementationExecutionMode;
	reference: ImplementationContractReference;
}

/** Read the standardized kickoff, with one isolated compatibility path for pre-618 rows. */
export function dispatchImplementationDelivery(dispatch: unknown): DispatchImplementationDelivery | null {
	const root = asRecord(dispatch);
	if (!root || isPlaybookDispatch(dispatch)) return null;
	const kickoff = asRecord(root.implementation_kickoff);
	const work = asRecord(kickoff?.work);
	const members = Array.isArray(root.members) ? root.members.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
	const actionItemIds = [...new Set([
		...(Array.isArray(work?.action_item_ids) ? work.action_item_ids : []),
		...members.map((member) => member.action_item_id),
	].map(text).filter((id): id is string => Boolean(id)))];
	const assignmentId = text(work?.assignment_id) ?? text(root.assignment_id) ?? text(root.id);
	if (!assignmentId || actionItemIds.length === 0) return null;
	const explicitMode = text(kickoff?.execution_mode) ?? text(root.execution_mode);
	const executionMode: ImplementationExecutionMode = explicitMode === "unattended" || explicitMode === "attended"
		? explicitMode
		: root.mode === "autopilot" ? "unattended" : "attended";
	const reference = asRecord(kickoff?.implementation_contract);
	return {
		assignmentId,
		actionItemIds,
		executionMode,
		reference: {
			...(text(reference?.contract_version) ? { contract_version: text(reference?.contract_version) } : {}),
			resource_uri: text(reference?.resource_uri) ?? IMPLEMENTATION_CONTRACT_RESOURCE_URIS[executionMode],
		},
	};
}

export function formatDispatchMessage(
	dispatch: unknown,
	codename: string,
	context: EffectiveImplementationContext,
	delivery: DispatchImplementationDelivery,
): string {
	const { title } = dispatchSummary(dispatch);
	const kickoff: ImplementationKickoff = buildImplementationKickoff({
		actionItemIds: delivery.actionItemIds,
		assignmentId: delivery.assignmentId,
		context,
		contractReference: delivery.reference,
	});
	return [
		`${DISPATCH_PREFIX} to ${codename}]`,
		formatImplementationKickoffHeader(kickoff),
		`Assigned work${title ? `: **${title}**` : ""}. Acknowledge assignment ${delivery.assignmentId} before the first claim; resolve that assignment after every member reaches a terminal work state.`,
		"",
		formatImplementationContext(context),
		"",
		"Assignment payload:",
		"```json",
		JSON.stringify(dispatch, null, 2),
		"```",
	].join("\n");
}

/** Existing playbook-run dispatches are not action-item implementation kickoffs. */
export function formatPlaybookDispatchMessage(dispatch: unknown, codename: string): string {
	const root = asRecord(dispatch);
	return [
		`${DISPATCH_PREFIX} to ${codename}]`,
		`You have been dispatched DevSpec playbook run ${text(root?.run_id) ?? text(root?.id) ?? "(unknown)"}.`,
		"Claim it with claim_playbook_run, follow the supplied instruction, then record_playbook_run truthfully.",
		"",
		"Dispatch payload:",
		"```json",
		JSON.stringify(dispatch, null, 2),
		"```",
	].join("\n");
}
