/**
 * DevSpec Pi — mechanical turn lifecycle (pure, unit-tested).
 *
 * Decides what the extension posts to DevSpec when an agent RUN settles
 * (item cc9e8c43, owner direction 2026-08-12):
 *
 * - There is exactly ONE writer, and it is mechanical. The model never posts
 *   conversational content: it thinks, tool-calls, and ends its run with a
 *   final terminal message; the extension delivers that message as the
 *   session answer with complete_turn:true. No complete_turn discipline, no
 *   tool-post precedence, no suppression state — the dual-writer failure
 *   class (857d984c, three patches, still leaking) is deleted, not fixed.
 * - This state is RUN-scoped: pi fires turn_start once per LLM round
 *   ("repeats while LLM calls tools"), so the tracker is created on
 *   agent_start / first turn_start and lives until agent_settled — never
 *   reset per round. Per-round state was the double-bubble root cause:
 *   suppression marks landed on a tracker the next round threw away.
 * - …and SEGMENT-delimited (item b1fb756a + f0df6c3e): a user message injected
 *   mid-run is a delivery boundary, AND so is a complete text-only assistant
 *   close (stopReason=stop, no toolCall blocks). That close is a finished
 *   answer bubble — not Working, not trail narration. Later thinking/tools
 *   in the same run open a fresh Working trail. The run is the execution
 *   unit; the segment is the delivery unit.
 * - Runs started by a LOCAL prompt (typed in the terminal while attached)
 *   also mirror the prompt as turn_kind:'local_prompt' before the answer, so
 *   the DevSpec transcript is two-sided.
 * - Nothing posts when unattached (sessionless) or when there is no answer
 *   text (e.g. a run that was pure tool calls with no closing message).
 */

export type UserKind = "remote" | "dispatch" | "local";

export const REMOTE_PREFIX = "[DevSpec remote — message from";
export const DISPATCH_PREFIX = "[DevSpec remote — work dispatch";

export class TurnTracker {
	userKind: UserKind | null = null;
	userText = "";
	lastAssistantText = "";
	/** True when the last assistant close was a finished text-only answer. */
	lastCloseWasAnswer = false;

	userMessage(text: string): void {
		this.userText = text;
		if (text.startsWith(REMOTE_PREFIX)) this.userKind = "remote";
		else if (text.startsWith(DISPATCH_PREFIX)) this.userKind = "dispatch";
		else this.userKind = "local";
	}

	assistantFinal(text: string, closedAnswer = false): void {
		// Zero-width/format characters are not text: a "​" final is not an
		// answer and must never produce a bubble (857d984c, instance 4).
		const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
		if (cleaned) this.lastAssistantText = cleaned;
		// Only a real stored close can be an answer; empty/zw text never is.
		this.lastCloseWasAnswer = Boolean(cleaned) && closedAnswer;
	}
}

export type SettlePlan =
	| { kind: "none" }
	| { kind: "final"; message: string }
	| { kind: "local_mirror"; prompt: string; answer: string };

/**
 * Whether a user message arriving mid-run forces a delivery boundary
 * (item b1fb756a). Only a segment that has PRODUCED an answer text has
 * something to close — an injection before the first assistant text simply
 * joins the current segment.
 */
export function isDeliveryBoundary(tracker: TurnTracker): boolean {
	return tracker.lastAssistantText !== "";
}

/** Next assistant round after a text-only close — the ack is its own bubble. */
export function isClosedAnswerBoundary(tracker: TurnTracker): boolean {
	return tracker.lastCloseWasAnswer && tracker.lastAssistantText !== "";
}

const CLOSED_ANSWER_STOPS = new Set(["stop"]);
const OPEN_ROUND_STOPS = new Set(["toolUse", "aborted", "error", "length", "pending"]);

/**
 * A text-only assistant close is a finished answer (item f0df6c3e).
 * Tool-loop rounds (toolCall blocks or stopReason=toolUse) stay in the trail.
 * Missing stopReason with no tool calls still counts as closed — some providers
 * omit it; the content shape is the authority.
 */
export function isClosedAnswer(input: {
	text: string;
	hasToolCalls: boolean;
	stopReason?: string | null;
}): boolean {
	const cleaned = input.text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
	if (!cleaned) return false;
	if (input.hasToolCalls) return false;
	const reason = input.stopReason ?? "stop";
	if (OPEN_ROUND_STOPS.has(reason)) return false;
	return CLOSED_ANSWER_STOPS.has(reason) || input.stopReason == null;
}

export function planSettle(tracker: TurnTracker, attached: boolean): SettlePlan {
	if (!attached) return { kind: "none" };
	if (!tracker.lastAssistantText) return { kind: "none" };
	if (tracker.userKind === "local") {
		return { kind: "local_mirror", prompt: tracker.userText, answer: tracker.lastAssistantText };
	}
	// remote/dispatch runs (and unknowns with an answer): post the final.
	return { kind: "final", message: tracker.lastAssistantText };
}
