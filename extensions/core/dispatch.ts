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

export function assertHydratedAssignmentIdentity(
	requestedAssignmentId: string,
	delivery: DispatchImplementationDelivery,
): void {
	if (delivery.assignmentId !== requestedAssignmentId) {
		throw new Error(
			`assignment hydration returned ${delivery.assignmentId} while ${requestedAssignmentId} was requested`,
		);
	}
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function strictIds(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} requires at least one action-item id`);
	const ids = value.map((candidate) => text(candidate));
	if (ids.some((id) => !id)) throw new Error(`${label} contains an invalid action-item id`);
	const unique = [...new Set(ids as string[])];
	if (unique.length !== ids.length) throw new Error(`${label} contains duplicate action-item ids`);
	return unique;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id) => right.includes(id));
}

function memberActionItemIds(root: Record<string, unknown>): string[] | null {
	if (!hasOwn(root, "members")) return null;
	if (!Array.isArray(root.members)) throw new Error("assignment members must be an array");
	return strictIds(root.members.map((candidate) => asRecord(candidate)?.action_item_id), "assignment members");
}

/** Read the canonical kickoff strictly, with one isolated compatibility path for pre-618 rows. */
export function dispatchImplementationDelivery(dispatch: unknown): DispatchImplementationDelivery | null {
	const root = asRecord(dispatch);
	if (!root || isPlaybookDispatch(dispatch)) return null;
	const members = memberActionItemIds(root);

	if (hasOwn(root, "implementation_kickoff")) {
		const kickoff = asRecord(root.implementation_kickoff);
		if (!kickoff) throw new Error("canonical implementation kickoff must be an object");
		if (kickoff.kind !== "devspec.implementation_kickoff") {
			throw new Error("canonical implementation kickoff kind was invalid");
		}
		if (kickoff.schema_version !== 1) throw new Error("canonical implementation kickoff schema version was invalid");
		const work = asRecord(kickoff.work);
		if (!work) throw new Error("canonical implementation kickoff work identity was invalid");
		const actionItemIds = strictIds(work.action_item_ids, "canonical implementation kickoff");
		if (members && !sameIdSet(actionItemIds, members)) {
			throw new Error("canonical implementation kickoff contradicted assignment members");
		}

		const assignmentId = text(work.assignment_id);
		if (!assignmentId) throw new Error("canonical implementation kickoff requires an assignment id");
		const surroundingIds = [text(root.assignment_id), text(root.id)].filter((id): id is string => Boolean(id));
		if (surroundingIds.some((id) => id !== assignmentId)) {
			throw new Error("canonical implementation kickoff contradicted assignment identity");
		}

		const executionMode = text(kickoff.execution_mode);
		if (executionMode !== "attended" && executionMode !== "unattended") {
			throw new Error("canonical implementation kickoff execution mode was invalid");
		}
		if (hasOwn(root, "execution_mode") && root.execution_mode !== executionMode) {
			throw new Error("canonical implementation kickoff contradicted assignment execution mode");
		}
		const reference = asRecord(kickoff.implementation_contract);
		const contractVersion = text(reference?.contract_version);
		const resourceUri = text(reference?.resource_uri);
		if (!reference || !contractVersion) throw new Error("canonical implementation kickoff contract version was invalid");
		if (resourceUri !== IMPLEMENTATION_CONTRACT_RESOURCE_URIS[executionMode]) {
			throw new Error("canonical implementation kickoff contract resource did not match execution mode");
		}
		return {
			assignmentId,
			actionItemIds,
			executionMode,
			reference: { contract_version: contractVersion, resource_uri: resourceUri },
		};
	}

	// Pre-618 compatibility: synthesize only when there is genuinely no canonical kickoff.
	const assignmentId = text(root.assignment_id) ?? text(root.id);
	if (!assignmentId || !members || members.length === 0) return null;
	const explicitMode = text(root.execution_mode);
	if (hasOwn(root, "execution_mode") && explicitMode !== "attended" && explicitMode !== "unattended") {
		throw new Error("legacy assignment execution mode was invalid");
	}
	const executionMode: ImplementationExecutionMode = explicitMode === "unattended" || explicitMode === "attended"
		? explicitMode
		: root.mode === "autopilot" ? "unattended" : "attended";
	return {
		assignmentId,
		actionItemIds: members,
		executionMode,
		reference: { resource_uri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS[executionMode] },
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
