/**
 * DevSpec Pi — the reply to a notice delivered into a person's running turn
 * (pure, unit-tested; DevSpec item da5cfae5).
 *
 * A notice run's final message is its reply to the notices that woke it. A
 * notice steered between the steps of a turn that answers someone has no such
 * message: that turn's messages are the answer to the person, and they reach the
 * room mechanically. So what the agent has to say about the notice is handed
 * over through a host tool, as text that never was one of the turn's messages,
 * and Pi posts it as a notice reply naming those notices (the served contract's
 * semantics.notice_reply). DevSpec's own gate then decides what the room shows:
 * a real reply with its follow-up card, a quiet housekeeping entry for a notice
 * already settled, or nothing for one that is for the record.
 *
 * The gate never depends on the agent calling the tool. Whatever was steered in
 * and not answered by the time the run ends is reported through the same path,
 * with a fixed line standing in for the agent's words.
 */
import type { NoticeReplyOutcome } from "./notice-reply.ts";

export const NOTICE_REPLY_TOOL = "reply_to_devspec_notice";

/**
 * Model-facing copy. What the room is shown is the served contract's to say
 * (semantics.notice_audience, semantics.notice_reply): pointed at, never restated.
 */
export const NOTICE_REPLY_TOOL_DESCRIPTION =
	"Hand over what you want your person to hear about the DevSpec notices that were delivered between the steps of this turn. " +
	"Pass message: your own words to them, in plain language. Pi posts it to your room as your reply to those notices, apart from the turn you are answering, " +
	"and DevSpec decides what the room shows (semantics.notice_audience and semantics.notice_reply in devspec://product/remote-ingress-contract). " +
	"This is the only way anything about those notices reaches the room: never write about them in your own messages, which stay the answer to the person you are working for.";

export const NOTICE_REPLY_TOOL_SCHEMA = {
	type: "object",
	properties: {
		message: { type: "string", description: "What you want your person to hear about the notices, in plain words. It is posted as written." },
	},
	required: ["message"],
	additionalProperties: false,
} as const;

/** The host tool joins the active set only while a person's turn holds notices steered into it. */
export function withNoticeReplyToolActive(active: readonly string[], enabled: boolean): string[] {
	const rest = active.filter((name) => name !== NOTICE_REPLY_TOOL);
	return enabled ? [...rest, NOTICE_REPLY_TOOL] : rest;
}

/**
 * What stands in for the agent's words when it handed nothing over. It is shown
 * only where DevSpec's gate finds a notice still needs a person, under the card
 * DevSpec writes for that notice; a settled notice never shows it.
 */
export const UNANSWERED_NOTICE_LINE = "This reached me while I was working on something else, and I have not written anything about it.";

export interface NoticeHandoverResult {
	/** False when the reply did not get through and the agent should know. */
	ok: boolean;
	/** DevSpec has decided about these notices: nothing more is posted for them. */
	done: boolean;
	/** What the agent is told. */
	text: string;
	/** Structured server refusal payload when DevSpec refused with structured details (requirement 4e32d1a5). */
	refusal?: Record<string, unknown>;
}

const SAY_NOTHING_MORE = "Say nothing about these notices in your own messages.";

/** What the agent is told after handing a reply over, by what DevSpec did with it. */
export function noticeHandoverResult(outcome: NoticeReplyOutcome): NoticeHandoverResult {
	switch (outcome.kind) {
		case "posted":
			return { ok: true, done: true, text: `Posted to your room as your reply to the DevSpec notice, apart from the turn you are answering. ${SAY_NOTHING_MORE}` };
		case "settled_housekeeping":
			return { ok: true, done: true, text: `DevSpec posted no message: every notice was already settled with nothing left for a person, and it recorded that quietly in the room. ${SAY_NOTHING_MORE}` };
		case "for_the_record":
			return { ok: true, done: true, text: `DevSpec posted nothing: these notices are for the record. ${SAY_NOTHING_MORE}` };
		case "refused":
			return {
				ok: false,
				done: true,
				text: outcome.refusal
					? `DevSpec did not post the reply (${outcome.reason}). ${outcome.detail} Details: ${JSON.stringify(outcome.refusal)}`
					: `DevSpec did not post the reply (${outcome.reason}). ${outcome.detail}`,
				...(outcome.refusal ? { refusal: outcome.refusal } : {}),
			};
		case "not_attached":
			return { ok: false, done: false, text: "Pi is not attached to a DevSpec room, so the reply was not posted. Tell the person at this terminal." };
		case "connection_changed":
			return { ok: false, done: false, text: "This Pi's DevSpec connection changed, so the reply was not posted." };
		case "no_final_text":
			return { ok: false, done: false, text: "Pass message: what you want your person to hear about the notices." };
		case "unconfirmed":
			return { ok: false, done: false, text: `The reply may not have reached the room (${outcome.detail}). Pi tries once more when this turn ends.` };
	}
}

/** Nothing steered into this turn is waiting for a reply. */
export const NO_NOTICE_WAITING = "No DevSpec notice delivered into this turn is waiting for a reply, so nothing was posted.";

export type NoticeHandover = (message: string) => Promise<{ ok: boolean; text: string; refusal?: Record<string, unknown> }>;

// The tool lives in the tools extension and the turn in the remote one. Pi loads
// each extension file with its own module graph, so the hand-over between them is
// kept on the process global object (decision cfe12ea7).
const STORE_KEY = Symbol.for("devspec.pi.notice-handover.v1");

function store(): { handover: NoticeHandover | null } {
	const root = globalThis as typeof globalThis & { [STORE_KEY]?: { handover: NoticeHandover | null } };
	if (!root[STORE_KEY]) root[STORE_KEY] = { handover: null };
	return root[STORE_KEY];
}

/** The remote extension installs how a handed-over reply is posted; null removes it. */
export function installNoticeHandover(handover: NoticeHandover | null): void {
	store().handover = handover;
}

/** The tool's whole behaviour: hand the words over, and tell the agent what DevSpec did. */
export async function handOverNoticeReply(message: unknown): Promise<{ ok: boolean; text: string; refusal?: Record<string, unknown> }> {
	const words = typeof message === "string" ? message.trim() : "";
	if (!words) return { ok: false, text: "Pass message: what you want your person to hear about the notices." };
	const handover = store().handover;
	if (!handover) return { ok: false, text: NO_NOTICE_WAITING };
	return handover(words);
}
