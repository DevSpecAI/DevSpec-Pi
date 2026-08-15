import type {
	EffectiveImplementationContext,
	ImplementationExecutionMode,
	ImplementationKickoff,
} from "./implementation-contract.ts";

export interface ActiveImplementationMode {
	deliveryKey: string;
	executionMode: ImplementationExecutionMode;
	assignmentId?: string;
	actionItemIds: string[];
	terminalActionItemIds: string[];
	contractVersion: string;
	contractHash?: string;
	installedAt: number;
	generation: number;
}

export interface ImplementationModeInstallation {
	deliveryKey: string;
	generation: number;
	previous?: ActiveImplementationMode;
	previousIndex: number;
}

interface MutableModeState {
	deliveries: ActiveImplementationMode[];
	nextGeneration: number;
}

const MODE_KEY = Symbol.for("devspec.pi.implementation-mode.v2");

function state(): MutableModeState {
	const root = globalThis as typeof globalThis & { [MODE_KEY]?: MutableModeState };
	if (!root[MODE_KEY]) root[MODE_KEY] = { deliveries: [], nextGeneration: 1 };
	if (!Number.isFinite(root[MODE_KEY].nextGeneration)) root[MODE_KEY].nextGeneration = 1;
	return root[MODE_KEY];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function kickoffKey(kickoff: ImplementationKickoff): string {
	return kickoff.work.assignment_id
		? `assignment:${kickoff.work.assignment_id}`
		: `attended:${[...kickoff.work.action_item_ids].sort().join(",")}`;
}

function copy(active: ActiveImplementationMode): ActiveImplementationMode {
	return {
		...active,
		actionItemIds: [...active.actionItemIds],
		terminalActionItemIds: [...active.terminalActionItemIds],
	};
}

/** Install mode for exactly one explicit delivery; mode is not connection identity. */
export function installImplementationMode(
	kickoff: ImplementationKickoff,
	context: EffectiveImplementationContext,
): ImplementationModeInstallation {
	const current = state();
	const deliveryKey = kickoffKey(kickoff);
	const previousIndex = current.deliveries.findIndex((entry) => entry.deliveryKey === deliveryKey);
	const previous = previousIndex >= 0 ? copy(current.deliveries[previousIndex]!) : undefined;
	const generation = current.nextGeneration++;
	const actionItemIds = unique(kickoff.work.action_item_ids);
	const next: ActiveImplementationMode = {
		deliveryKey,
		executionMode: kickoff.execution_mode,
		...(kickoff.work.assignment_id ? { assignmentId: kickoff.work.assignment_id } : {}),
		actionItemIds,
		terminalActionItemIds: previous?.terminalActionItemIds.filter((id) => actionItemIds.includes(id)) ?? [],
		contractVersion: context.contractVersion,
		...(context.contractHash ? { contractHash: context.contractHash } : {}),
		installedAt: Date.now(),
		generation,
	};
	current.deliveries = [
		...current.deliveries.filter((entry) => entry.deliveryKey !== deliveryKey),
		next,
	];
	return {
		deliveryKey,
		generation,
		...(previous ? { previous } : {}),
		previousIndex,
	};
}

/** Most recently installed delivery, retained for footer/debug compatibility. */
export function getActiveImplementationMode(): ActiveImplementationMode | null {
	const deliveries = state().deliveries;
	return deliveries.length > 0 ? copy(deliveries[deliveries.length - 1]!) : null;
}

export function listImplementationModes(): ActiveImplementationMode[] {
	return state().deliveries.map(copy);
}

export function clearImplementationMode(input: { assignmentId?: string; deliveryKey?: string }): boolean {
	const current = state();
	const key = input.deliveryKey ?? (input.assignmentId ? `assignment:${input.assignmentId}` : undefined);
	if (!key) return false;
	const before = current.deliveries.length;
	current.deliveries = current.deliveries.filter((entry) => entry.deliveryKey !== key);
	return current.deliveries.length !== before;
}

export function rollbackImplementationMode(installation: ImplementationModeInstallation): boolean {
	const current = state();
	const activeIndex = current.deliveries.findIndex((entry) =>
		entry.deliveryKey === installation.deliveryKey && entry.generation === installation.generation
	);
	if (activeIndex < 0) return false;
	current.deliveries.splice(activeIndex, 1);
	if (installation.previous) {
		const index = Math.max(0, Math.min(installation.previousIndex, current.deliveries.length));
		current.deliveries.splice(index, 0, copy(installation.previous));
	}
	return true;
}

function itemIdFrom(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const root = value as Record<string, unknown>;
	for (const key of ["action_item_id", "id"]) {
		if (typeof root[key] === "string" && root[key]) return root[key] as string;
	}
	for (const key of ["item", "action_item", "details"]) {
		const nested = itemIdFrom(root[key]);
		if (nested) return nested;
	}
	return undefined;
}

function assignmentIdFrom(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const root = value as Record<string, unknown>;
	if (typeof root.assignment_id === "string" && root.assignment_id) return root.assignment_id;
	return assignmentIdFrom(root.details) ?? assignmentIdFrom(root.assignment);
}

/**
 * Successful native work-tool results drive the matching delivery's cleanup.
 * Plural queued assignments coexist; no unrelated delivery can be cleared.
 */
export function consumeImplementationLifecycle(
	name: string,
	args: Record<string, unknown> = {},
	result?: unknown,
): boolean {
	const current = state();
	if (current.deliveries.length === 0) return false;

	if (name === "resolve_assignment") {
		const assignmentId =
			(typeof args.assignment_id === "string" && args.assignment_id ? args.assignment_id : undefined) ??
			assignmentIdFrom(result);
		return assignmentId ? clearImplementationMode({ assignmentId }) : false;
	}

	if (!["record_implementation", "release_work_item", "fail_work_item"].includes(name)) return false;
	const actionItemId =
		(typeof args.action_item_id === "string" && args.action_item_id ? args.action_item_id : undefined) ??
		itemIdFrom(result);
	if (!actionItemId) return false;
	const delivery = current.deliveries.find((entry) => entry.actionItemIds.includes(actionItemId));
	if (!delivery) return false;
	delivery.terminalActionItemIds = unique([...delivery.terminalActionItemIds, actionItemId]);
	if (delivery.actionItemIds.every((id) => delivery.terminalActionItemIds.includes(id))) {
		return clearImplementationMode({ deliveryKey: delivery.deliveryKey });
	}
	return false;
}

export function resetImplementationMode(): void {
	const current = state();
	current.deliveries = [];
	current.nextGeneration = 1;
}
