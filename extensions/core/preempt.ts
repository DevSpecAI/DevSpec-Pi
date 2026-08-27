/**
 * Owner-instruction preemption policy (item f5bbc8f8).
 *
 * Arrival of an owner command mid-turn is a LIFECYCLE event, not content
 * authorship: abort the running turn (pause, never undo), then deliver the
 * owner message. Ambient/room noise never reaches this function — the pump
 * only calls it for ownerCommands.
 *
 * Pure so the three modes are unit-testable without a live pi session.
 */

export type OwnerDeliveryMode = "immediate" | "queue" | "preempt";

/** How sendUserMessage must be called for that mode. */
export type OwnerSendMode = "now" | "steer" | "followUp";

export function decideOwnerDelivery(input: {
	idle: boolean;
	preemptEnabled: boolean;
	hasOwnerCommand: boolean;
}): OwnerDeliveryMode {
	if (!input.hasOwnerCommand) return "immediate";
	if (input.idle) return "immediate";
	if (input.preemptEnabled) return "preempt";
	return "queue";
}

/** How a directed-question answer should meet a running Pi turn (item 4221d08e). */
export type InteractionDeliveryMode = "apply" | "preempt" | "defer";

export function decideInteractionDelivery(input: {
	idle: boolean;
	preemptEnabled: boolean;
	hasEvent: boolean;
}): InteractionDeliveryMode {
	if (!input.hasEvent) return "defer";
	if (input.idle) return "apply";
	if (input.preemptEnabled) return "preempt";
	return "defer";
}

/**
 * After abort(), isStreaming stays true until the aborted run settles
 * (cooperative AbortSignal). A bare send during that window throws
 * "already processing" (live miss 1). Steering into the SAME run then
 * produces a terminal answer that agent_settled never posts — settle
 * nulls turn state first (live miss 2, Ali 2026-08-13: interrupt worked,
 * reply stayed in the terminal).
 *
 * Wait for idle, then send as a fresh turn (`now`). If the wait times
 * out, fall back to steer so the message is not dropped.
 */
export function sendModeFor(mode: OwnerDeliveryMode, settled = false): OwnerSendMode {
	if (mode === "preempt") return settled ? "now" : "steer";
	if (mode === "queue") return "followUp";
	return "now";
}

export async function waitUntil(
	check: () => boolean,
	opts: {
		timeoutMs: number;
		intervalMs: number;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<boolean> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const deadline = now() + opts.timeoutMs;
	while (!check()) {
		if (now() >= deadline) return false;
		await sleep(opts.intervalMs);
	}
	return true;
}

/** Tail note so the model judges stop-vs-continue. Not an instruction to invent work. */
export const PREEMPT_TAIL =
	"[This interrupted a running turn. Answer this first. Then continue the prior work if that is appropriate — a short ack is enough to stop; do not throw the previous context away.]";
