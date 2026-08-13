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
