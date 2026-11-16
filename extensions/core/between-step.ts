/**
 * DevSpec Pi — between-step delivery (pure, unit-tested).
 *
 * DevSpec item da5cfae5; decisions b8abe2bb (checks and notices on an agent's
 * own work reach it between steps, never mid-step, ruled together in one pause)
 * and 1d5a9c56 (helper agents). It replaces the hold of item d36ac887 (decision
 * ff1bcabe), which kept a busy agent's check jobs and notices until its turn ended.
 *
 * What waits, and how it leaves:
 *
 * - A check job waits in this ledger from the moment the wake channel lists it.
 *   A notice waits in the system-notice store, as before.
 * - Pi idle: everything waiting goes out straight away, as before. Check jobs
 *   start a check-job run (one wake for all of them), notices a notice run.
 * - Pi running a turn: when a step of that turn ends, everything waiting at that
 *   moment is handed to Pi as ONE steer, which Pi shows the agent before its
 *   next step. Pi never interrupts a step to deliver a steer.
 *
 * Exactly once. A batch handed to Pi as a steer is only "in flight": it stays
 * waiting until Pi actually shows it to the agent (the steer's message_start),
 * and only then is it committed. While one steer is in flight no second one is
 * sent, and Pi is not idle, so nothing can leave by the idle path either. If the
 * run ends first (the person stopped it, and Pi dropped its queue), the batch is
 * simply still waiting and goes out idle.
 */
import { randomUUID } from "node:crypto";
import { checkJobAnnouncement } from "./dispatch.ts";
import type { SystemNoticeV1 } from "./remote-payload.ts";
import { formatSystemNoticeMessage } from "./system-notice.ts";
import { BETWEEN_STEP_PREFIX } from "./turn-lifecycle.ts";

export { BETWEEN_STEP_CUSTOM_TYPE, BETWEEN_STEP_PREFIX, isBetweenStepDelivery } from "./turn-lifecycle.ts";

export interface WaitingCheckJob {
	/** The check job's id: its dispatch id on the wake channel. */
	readonly id: string;
	readonly envelope: unknown;
}

/** One steer: every check job and notice that was waiting when the step ended. */
export interface BetweenStepBatch {
	readonly deliveryId: string;
	readonly checkJobs: readonly WaitingCheckJob[];
	readonly noticeIds: readonly string[];
}

/** What a pump holds for its connection. A new bond gets a new ledger. */
export class BetweenStepLedger {
	private readonly waiting = new Map<string, unknown>();
	private steered: BetweenStepBatch | null = null;

	/** A check job the wake channel listed. False when it is already waiting. */
	admitCheckJob(id: string, envelope: unknown): boolean {
		if (!id || this.waiting.has(id)) return false;
		this.waiting.set(id, envelope);
		return true;
	}

	/** DevSpec no longer lists it for this agent: it was ruled or handed on. */
	withdrawCheckJob(id: string): boolean {
		return this.waiting.delete(id);
	}

	/** Every check job not yet shown to the agent, in the order they arrived. */
	waitingCheckJobs(): WaitingCheckJob[] {
		return [...this.waiting].map(([id, envelope]) => ({ id, envelope }));
	}

	hasWaitingCheckJobs(): boolean {
		return this.waiting.size > 0;
	}

	/** A steer is in Pi's queue and the agent has not been shown it yet. */
	get steerInFlight(): boolean {
		return this.steered !== null;
	}

	/**
	 * A step ended: take everything waiting as one steer. Null when nothing waits
	 * or the previous steer has not reached the agent yet (what arrived since
	 * joins the next one). Nothing is committed here.
	 */
	beginSteer(noticeIds: readonly string[], deliveryId: string = randomUUID()): BetweenStepBatch | null {
		if (this.steered || !deliveryId) return null;
		const checkJobs = this.waitingCheckJobs();
		if (checkJobs.length === 0 && noticeIds.length === 0) return null;
		this.steered = { deliveryId, checkJobs, noticeIds: [...noticeIds] };
		return this.steered;
	}

	/** Pi refused the steer: nothing reached it, so nothing is in flight. */
	abandonSteer(deliveryId: string): void {
		if (this.steered?.deliveryId === deliveryId) this.steered = null;
	}

	/**
	 * Pi showed the agent a between-step delivery. The first sight of the steer
	 * in flight commits its check jobs and returns the batch (the caller commits
	 * its notices). Anything else returns null and changes nothing: a repeat, a
	 * steer this ledger gave up on, or another connection's.
	 */
	observe(deliveryId: string): BetweenStepBatch | null {
		const batch = this.steered;
		if (!batch || batch.deliveryId !== deliveryId) return null;
		this.steered = null;
		for (const job of batch.checkJobs) this.waiting.delete(job.id);
		return batch;
	}

	/**
	 * The run is over. A steer the agent was never shown is no longer in flight;
	 * its check jobs and notices were never committed, so they are still waiting.
	 */
	runEnded(): BetweenStepBatch | null {
		const batch = this.steered;
		this.steered = null;
		return batch;
	}

	/** Check jobs handed to an idle Pi as the message that starts its run. */
	commitCheckJobs(ids: readonly string[]): void {
		for (const id of ids) this.waiting.delete(id);
	}
}

/** What rides the steer itself, so its delivery can be told from its arrival. */
export interface BetweenStepDetails {
	delivery_id: string;
	check_job_ids: string[];
	/** The notices, as the notice message carries them: a notice run reads them for its reply. */
	notices: SystemNoticeV1[];
	roomAttached: boolean;
}

/** The delivery id on a between-step message, or null when it carries none. */
export function betweenStepDeliveryId(details: unknown): string | null {
	const id = details !== null && typeof details === "object" && !Array.isArray(details)
		? (details as { delivery_id?: unknown }).delivery_id
		: undefined;
	return typeof id === "string" && id.trim() ? id : null;
}

/**
 * The one message a between-step delivery is. Fixed harness copy: it frames what
 * arrived as nobody's request, lists every waiting check job, then every waiting
 * notice in the notice message's own words. Whether the room hears about any of
 * it is the served contract's (check_job.room, semantics.notice_audience),
 * pointed at and never restated.
 *
 * `inRunningTurn`: the turn answers someone, so it keeps its own voice. A notice
 * run or a check-job run answers nobody, and its final message is still the
 * reply to the notices it was given, exactly as for a notice run.
 */
export function formatBetweenStepMessage(input: {
	codename: string;
	checkJobs: readonly unknown[];
	notices: readonly SystemNoticeV1[];
	roomAttached: boolean;
	inRunningTurn: boolean;
	helpers?: string | null;
}): string {
	if (input.checkJobs.length === 0 && input.notices.length === 0) throw new Error("a between-step delivery carries at least one check job or notice");
	const lines = [
		`${BETWEEN_STEP_PREFIX} — to ${input.codename}]`,
		"DevSpec delivered this between two steps of the turn you are running. Nobody asked for it and it is no part of what you were asked to do: deal with all of it now, in this one pause, then carry on exactly where you left off.",
	];
	if (input.checkJobs.length > 0) {
		const announcement = checkJobAnnouncement(input.checkJobs, { helpers: input.helpers });
		lines.push(
			"",
			...announcement.lines,
			"Write nothing in your messages about taking or ruling a check (the served contract's check_job.room).",
			"",
			...announcement.envelopes,
		);
	}
	if (input.notices.length > 0) {
		lines.push("", formatSystemNoticeMessage(input.notices, { roomAttached: input.roomAttached, inRunningTurn: input.inRunningTurn }));
	}
	return lines.join("\n");
}

export type IdleCheckJobOutcome =
	/** One wake carrying every waiting check job was handed to Pi. */
	| "sent"
	/** Nothing is waiting any more. */
	| "nothing"
	/** Pi is not idle: the running turn's next step boundary, or its end, takes them. */
	| "busy"
	/** This pump no longer holds the connection. */
	| "stale";

/**
 * Deliver every waiting check job to an idle Pi in one wake. Each job that has
 * waited is first rechecked with DevSpec (item e6985316): one that was ruled or
 * handed on meanwhile is dropped without waking anyone. Pi is checked again
 * after that answer, because a run may have started while DevSpec was asked.
 */
export async function deliverIdleCheckJobs(deps: {
	ledger: BetweenStepLedger;
	/** Pi is idle right now and nothing is about to start a run. */
	ready: () => boolean;
	/** This pump still holds the connection. */
	current: () => boolean;
	/** Whether DevSpec still lists the job for this agent. Must fail open. */
	stillPending: (id: string) => Promise<boolean>;
	/** Hand the wake to Pi. Throws when Pi refuses it; the jobs then stay waiting. */
	send: (jobs: readonly WaitingCheckJob[]) => void;
}): Promise<IdleCheckJobOutcome> {
	if (!deps.current()) return "stale";
	if (!deps.ready() || deps.ledger.steerInFlight) return "busy";
	const asked = deps.ledger.waitingCheckJobs();
	if (asked.length === 0) return "nothing";
	const pending = await Promise.all(asked.map((job) => deps.stillPending(job.id)));
	if (!deps.current()) return "stale";
	asked.forEach((job, index) => { if (!pending[index]) deps.ledger.withdrawCheckJob(job.id); });
	if (!deps.ready() || deps.ledger.steerInFlight) return "busy";
	// A job that arrived while DevSpec answered was listed a moment ago: it goes too.
	const jobs = deps.ledger.waitingCheckJobs();
	if (jobs.length === 0) return "nothing";
	deps.send(jobs);
	deps.ledger.commitCheckJobs(jobs.map((job) => job.id));
	return "sent";
}
