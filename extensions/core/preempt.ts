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

/**
 * Host silence window for a wedged mid-turn (item 4284a43c / Cursor Colorful
 * Dolphin intent). Independent of the server's working-lease progress marker:
 * this is the local pump deciding to force-recover when a new owner command
 * arrives and the runtime has produced no progress events for this long.
 */
export const TURN_SILENCE_MS = 90_000;

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
 * True when a new owner command must force-recover a silent mid-turn rather
 * than wait forever for cooperative abort/settle (Fierce Octopus 2026-09-22:
 * empty stub, heartbeats alive, later commands never woke).
 *
 * Idle runtimes use the normal immediate path. Active turns with recent
 * progress renew the window. Only silence + a new command force recovery.
 */
export function shouldRecoverHungOwnerTurn(input: {
	hasOwnerCommand: boolean;
	runtimeIdle: boolean;
	lastProgressAtMs: number;
	nowMs?: number;
	windowMs?: number;
}): boolean {
	if (!input.hasOwnerCommand || input.runtimeIdle) return false;
	const now = input.nowMs ?? Date.now();
	const windowMs = input.windowMs ?? TURN_SILENCE_MS;
	return now - input.lastProgressAtMs >= windowMs;
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

/**
 * Stranded-busy recovery (item 3f07f97b). pi_abort() is cooperative: when the
 * aborted run never settles, the settle wait times out while the model is
 * already idle and nothing holds occupancy — yet active.busy stays true, so
 * every later lap defers the same interaction event ("awaiting idle") and the
 * event-only lane starves all command delivery (live wedge 2026-09-18, 73
 * minutes). Clearing is safe exactly when nothing is running: a genuinely
 * settling run keeps either ctx or occupancy busy. Deliberately not gated on
 * background tasks: a stale pending entry must not preserve the wedge, and the
 * applied event starts a run that reasserts busy within one lap.
 */
export function shouldClearStrandedBusyAfterAbort(input: {
	settled: boolean;
	ctxIdle: boolean;
	occupancyBusy: boolean;
	pumpBusy: boolean;
}): boolean {
	return !input.settled && input.ctxIdle && !input.occupancyBusy && input.pumpBusy;
}

/** Tail note so the model judges stop-vs-continue. Not an instruction to invent work. */
export const PREEMPT_TAIL =
	"[This interrupted a running turn. Answer this first. Then continue the prior work if that is appropriate — a short ack is enough to stop; do not throw the previous context away.]";
