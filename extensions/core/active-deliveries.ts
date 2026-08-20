import type { ImplementationContractContext, ImplementationKickoff } from "./implementation-contract.ts";

/**
 * Which deliveries this Pi process has handed to a turn and not yet seen finish.
 *
 * This was `implementation-mode.ts`, and it installed an execution mode for the
 * duration of a delivery. There is no execution mode (DevSpec item 6d085535):
 * nothing is installed for the duration of a batch and nothing needs clearing when
 * one resolves. What is genuinely worth tracking is narrower and survives the
 * rename — WHICH locally selected items went out with WHICH contract, so the footer
 * can say so and a failed direct send can be rolled back.
 *
 * Plural direct deliveries coexist on purpose, so a lifecycle result only ever
 * touches the delivery holding that item.
 */

export interface ActiveDelivery {
	deliveryKey: string;
	actionItemIds: string[];
	terminalActionItemIds: string[];
	contractVersion: string;
	contractHash?: string;
	recordedAt: number;
	generation: number;
}

export interface DeliveryRecord {
	deliveryKey: string;
	generation: number;
	previous?: ActiveDelivery;
	previousIndex: number;
}

interface MutableDeliveryState {
	deliveries: ActiveDelivery[];
	nextGeneration: number;
}

const DELIVERIES_KEY = Symbol.for("devspec.pi.active-deliveries.v1");

function state(): MutableDeliveryState {
	const root = globalThis as typeof globalThis & { [DELIVERIES_KEY]?: MutableDeliveryState };
	if (!root[DELIVERIES_KEY]) root[DELIVERIES_KEY] = { deliveries: [], nextGeneration: 1 };
	if (!Number.isFinite(root[DELIVERIES_KEY].nextGeneration)) root[DELIVERIES_KEY].nextGeneration = 1;
	return root[DELIVERIES_KEY];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function kickoffKey(kickoff: ImplementationKickoff): string {
	return `items:${[...kickoff.work.action_item_ids].sort().join(",")}`;
}

function copy(active: ActiveDelivery): ActiveDelivery {
	return {
		...active,
		actionItemIds: [...active.actionItemIds],
		terminalActionItemIds: [...active.terminalActionItemIds],
	};
}

/** Record exactly one locally selected delivery; a delivery is not connection identity. */
export function recordActiveDelivery(
	kickoff: ImplementationKickoff,
	context: ImplementationContractContext,
): DeliveryRecord {
	const current = state();
	const deliveryKey = kickoffKey(kickoff);
	const previousIndex = current.deliveries.findIndex((entry) => entry.deliveryKey === deliveryKey);
	const previous = previousIndex >= 0 ? copy(current.deliveries[previousIndex]!) : undefined;
	const generation = current.nextGeneration++;
	const actionItemIds = unique(kickoff.work.action_item_ids);
	const next: ActiveDelivery = {
		deliveryKey,
		actionItemIds,
		terminalActionItemIds: previous?.terminalActionItemIds.filter((id) => actionItemIds.includes(id)) ?? [],
		contractVersion: context.contractVersion,
		...(context.contractHash ? { contractHash: context.contractHash } : {}),
		recordedAt: Date.now(),
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

/** Most recently recorded delivery, retained for footer/debug compatibility. */
export function getLatestActiveDelivery(): ActiveDelivery | null {
	const deliveries = state().deliveries;
	return deliveries.length > 0 ? copy(deliveries[deliveries.length - 1]!) : null;
}

export function listActiveDeliveries(): ActiveDelivery[] {
	return state().deliveries.map(copy);
}

export function clearActiveDelivery(input: { deliveryKey: string }): boolean {
	const current = state();
	if (!input.deliveryKey) return false;
	const before = current.deliveries.length;
	current.deliveries = current.deliveries.filter((entry) => entry.deliveryKey !== input.deliveryKey);
	return current.deliveries.length !== before;
}

export function rollbackActiveDelivery(record: DeliveryRecord): boolean {
	const current = state();
	const activeIndex = current.deliveries.findIndex((entry) =>
		entry.deliveryKey === record.deliveryKey && entry.generation === record.generation
	);
	if (activeIndex < 0) return false;
	current.deliveries.splice(activeIndex, 1);
	if (record.previous) {
		const index = Math.max(0, Math.min(record.previousIndex, current.deliveries.length));
		current.deliveries.splice(index, 0, copy(record.previous));
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

/**
 * Successful native work-tool results drive the matching delivery's cleanup.
 * Plural local selections coexist; no unrelated delivery can be cleared.
 */
export function consumeDeliveryLifecycle(
	name: string,
	args: Record<string, unknown> = {},
	result?: unknown,
): boolean {
	const current = state();
	if (current.deliveries.length === 0) return false;

	if (!["record_implementation", "release_work_item", "fail_work_item"].includes(name)) return false;
	const actionItemId =
		(typeof args.action_item_id === "string" && args.action_item_id ? args.action_item_id : undefined) ??
		itemIdFrom(result);
	if (!actionItemId) return false;
	const delivery = current.deliveries.find((entry) => entry.actionItemIds.includes(actionItemId));
	if (!delivery) return false;
	delivery.terminalActionItemIds = unique([...delivery.terminalActionItemIds, actionItemId]);
	if (delivery.actionItemIds.every((id) => delivery.terminalActionItemIds.includes(id))) {
		return clearActiveDelivery({ deliveryKey: delivery.deliveryKey });
	}
	return false;
}

export function resetActiveDeliveries(): void {
	const current = state();
	current.deliveries = [];
	current.nextGeneration = 1;
}
