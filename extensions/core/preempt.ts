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

/**
 * After abort(), a bare sendUserMessage throws "Agent is already processing"
 * because abort is cooperative and isStreaming is still true (live miss,
 * Ali 2026-08-13). The extension API is fire-and-forget, so try/catch cannot
 * recover. Preempt MUST send as steer — never a bare send.
 */
export function sendModeFor(mode: OwnerDeliveryMode): OwnerSendMode {
	if (mode === "preempt") return "steer";
	if (mode === "queue") return "followUp";
	return "now";
}
