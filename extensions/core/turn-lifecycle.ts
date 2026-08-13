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
 * - …and SEGMENT-delimited (item b1fb756a): a user message injected mid-run
 *   (owner followUp, terminal typing, a queued notification) is a delivery
 *   boundary. The text accumulated so far is the answer to the PREVIOUS
 *   message — it closes as its own bubble, and the new message starts a
 *   fresh segment. The run is the execution unit; the segment is the
 *   delivery unit.
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

	userMessage(text: string): void {
		this.userText = text;
		if (text.startsWith(REMOTE_PREFIX)) this.userKind = "remote";
		else if (text.startsWith(DISPATCH_PREFIX)) this.userKind = "dispatch";
		else this.userKind = "local";
	}

	assistantFinal(text: string): void {
		// Zero-width/format characters are not text: a "​" final is not an
		// answer and must never produce a bubble (857d984c, instance 4).
		const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
		if (cleaned) this.lastAssistantText = cleaned;
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

export function planSettle(tracker: TurnTracker, attached: boolean): SettlePlan {
	if (!attached) return { kind: "none" };
	if (!tracker.lastAssistantText) return { kind: "none" };
	if (tracker.userKind === "local") {
		return { kind: "local_mirror", prompt: tracker.userText, answer: tracker.lastAssistantText };
	}
	// remote/dispatch runs (and unknowns with an answer): post the final.
	return { kind: "final", message: tracker.lastAssistantText };
}
