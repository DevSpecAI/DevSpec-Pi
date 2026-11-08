/**
 * Whether a run's text reaches the DevSpec room, decided by what woke the run
 * (DevSpec item a868f41f, criterion f9caa4fa). Pure, unit-tested.
 *
 * Pi mirrors model text into the room mechanically, so it can never decide from
 * wording: the end of a run is not reliably its answer. What it does know is what
 * started the run, and DevSpec labels that. The rule the served contract gives
 * every host is at devspec://product/remote-ingress-contract
 * (semantics.notice_audience, check_job.room); this is Pi's mechanical reading:
 *
 * - a person's command or prompt, an automation run, a question answer or any
 *   other wake speaks exactly as before;
 * - a notice batch with at least one notice that needs a person speaks: its final
 *   message is the room reply to those notices;
 * - a batch whose every notice is for the record, and a check job, are quiet:
 *   no speech, no answer, no work trail and no error notice is posted, and the
 *   text stays in Pi's own session. A work trail is no hiding place: the room
 *   draws every finished trail-only row in the conversation ("No response", or
 *   "stopped before finishing" when nothing closes it);
 * - a quiet run speaks after all once one of its writes comes back carrying
 *   DevSpec's tell_person mark (it changed someone else's record): from then on
 *   its messages are delivered like any other run's.
 */
import type { SystemNoticeV1 } from "./remote-payload.ts";

export type RunWake =
	/** A person, an automation run, a question answer, a completion wake: unchanged. */
	| "person"
	/** A notice batch with at least one notice DevSpec labelled needs_person. */
	| "notice_needs_person"
	/** A notice batch whose every notice DevSpec labelled for_the_record. */
	| "notice_for_the_record"
	/** A check job DevSpec sent this agent to rule. */
	| "check_job";

/**
 * Whether one notice needs the person. DevSpec's label decides; a notice this
 * plugin could not read is told to the person, so it needs them too. Nothing but
 * an explicit for_the_record label ever makes a notice quiet.
 */
export function noticeNeedsPerson(notice: SystemNoticeV1): boolean {
	return notice.kind === "unreadable" || notice.audience !== "for_the_record";
}

/** What a delivered notice batch woke: quiet only when every notice is for the record. */
export function noticeBatchWake(notices: readonly SystemNoticeV1[]): RunWake {
	return notices.length > 0 && !notices.some(noticeNeedsPerson) ? "notice_for_the_record" : "notice_needs_person";
}

/** A run that, by what woke it, keeps its text out of the room. */
export function wakeIsQuiet(wake: RunWake): boolean {
	return wake === "notice_for_the_record" || wake === "check_job";
}

/**
 * Whether the run's text is delivered as messages. A quiet run speaks only once
 * DevSpec has marked one of its writes as changing someone else's record.
 */
export function runSpeaks(wake: RunWake, tellPerson: boolean): boolean {
	return !wakeIsQuiet(wake) || tellPerson;
}
