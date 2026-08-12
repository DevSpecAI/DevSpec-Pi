/**
 * DevSpec Pi — mechanical turn lifecycle (pure, unit-tested).
 *
 * Decides what the extension posts to DevSpec when a turn settles. The rules
 * (VISION.md, slice 2 — Pi-specific refinement of the delivery contract):
 *
 * - The model may post its own answer via the post_session_message tool; a
 *   successful tool post this turn takes precedence (never dual writers).
 *   Two signals say so: the tool_execution_end event (tracker.toolPosted)
 *   AND the backstop mark the tool itself leaves on success
 *   (completeTurnPostedSince — item 857d984c: the event signal alone leaked
 *   three times in one evening, so the source of truth now also speaks).
 * - Otherwise the extension posts the final assistant message mechanically
 *   with complete_turn:true — the UI shows the agent's real answer and never
 *   hangs on a forgotten tool call.
 * - Turns started by a LOCAL prompt (typed in the terminal while attached)
 *   also mirror the prompt as turn_kind:'local_prompt' before the answer, so
 *   the DevSpec transcript is two-sided.
 * - Nothing posts when unattached (sessionless) or when there is no answer
 *   text (e.g. a turn that was pure tool calls with no closing message).
 */

export type UserKind = "remote" | "dispatch" | "local";

export const REMOTE_PREFIX = "[DevSpec remote — message from";
export const DISPATCH_PREFIX = "[DevSpec remote — work dispatch";

export class TurnTracker {
	userKind: UserKind | null = null;
	userText = "";
	toolPosted = false;
	lastAssistantText = "";

	userMessage(text: string): void {
		this.userText = text;
		if (text.startsWith(REMOTE_PREFIX)) this.userKind = "remote";
		else if (text.startsWith(DISPATCH_PREFIX)) this.userKind = "dispatch";
		else this.userKind = "local";
	}

	toolEnd(toolName: string, isError: boolean): void {
		if (toolName === "post_session_message" && !isError) this.toolPosted = true;
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

export function planSettle(tracker: TurnTracker, attached: boolean, postedThisTurn = false): SettlePlan {
	if (!attached) return { kind: "none" };
	if (tracker.toolPosted || postedThisTurn) return { kind: "none" };
	if (!tracker.lastAssistantText) return { kind: "none" };
	if (tracker.userKind === "local") {
		return { kind: "local_mirror", prompt: tracker.userText, answer: tracker.lastAssistantText };
	}
	// remote/dispatch turns (and unknowns with an answer): post the final.
	return { kind: "final", message: tracker.lastAssistantText };
}
