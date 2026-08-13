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
 *   mid-run is a delivery boundary. The FIRST user-facing assistant text after
 *   that user message is the finished answer for the thinking so far — even
 *   when the same assistant message also has toolCall blocks (round 2: the
 *   "Ali, I'll check…" line that lived in Show work). Later tools/thinking
 *   open a fresh Working trail. A later text-only close is another boundary.
 *   The run is the execution unit; the segment is the delivery unit.
 * - Runs started by a LOCAL prompt (typed in the terminal while attached)
 *   also mirror the prompt as turn_kind:'local_prompt' before the answer, so
 *   the DevSpec transcript is two-sided. Mirror once per typed prompt —
 *   continuation segments (carryUser) post only the answer (item 56b9a3b4).
 * - HARNESS leftovers (Pi <background-task-notification> / [bg completed])
 *   and DevSpec display:false context injections (auto-recall, attach
 *   block, room orientation) may wake the model but are not conversation:
 *   no remirror, no answer bubble. Typed slash commands stay local — we
 *   classify by origin, not by a leading `/`.
 * - Nothing posts when unattached (sessionless) or when there is no answer
 *   text (e.g. a run that was pure tool calls with no closing message).
 */

export type UserKind = "remote" | "dispatch" | "local" | "harness";

export const REMOTE_PREFIX = "[DevSpec remote — message from";
export const DISPATCH_PREFIX = "[DevSpec remote — work dispatch";
export const HARNESS_BG_CUSTOM_TYPE = "background-task-notification";
export const CONTEXT_CUSTOM_TYPES = new Set([
	"devspec-proactive",
	"devspec-attach-context",
	"devspec-room-orientation",
]);
const CONTEXT_TEXT_PREFIXES = [
	"### DevSpec memory — auto-recall",
	"[DevSpec remote — bond context",
	"[DevSpec remote — room orientation",
];

/**
 * Leftover / injected origin (items 56b9a3b4, 4f801a67). Prefer Pi's
 * customType, then known injected text, then leftover bg receipts.
 * A typed `/bg-update` is NOT harness — slash commands stay first-class local.
 */
export function isHarnessOrigin(text: string, customType?: string | null): boolean {
	if (customType === HARNESS_BG_CUSTOM_TYPE) return true;
	if (customType && CONTEXT_CUSTOM_TYPES.has(customType)) return true;
	const t = text.trim();
	if (!t) return false;
	if (CONTEXT_TEXT_PREFIXES.some((prefix) => t.startsWith(prefix))) return true;
	if (t.includes("<background-task-notification")) return true;
	return /^\[bg (completed|failed|killed)\]/m.test(t);
}

export function classifyUserKind(text: string, customType?: string | null): UserKind {
	if (text.startsWith(REMOTE_PREFIX)) return "remote";
	if (text.startsWith(DISPATCH_PREFIX)) return "dispatch";
	if (isHarnessOrigin(text, customType)) return "harness";
	return "local";
}

export class TurnTracker {
	userKind: UserKind | null = null;
	userText = "";
	lastAssistantText = "";
	/** True when the last assistant close was a finished text-only answer. */
	lastCloseWasAnswer = false;
	/** True until this segment posts its first user-facing answer. */
	awaitingFirstAnswer = false;
	/** True only for a freshly typed local prompt — never after carryUser. */
	shouldMirrorPrompt = false;

	userMessage(text: string, origin?: { customType?: string | null }): void {
		const kind = classifyUserKind(text, origin?.customType);
		// A leftover wake may replay the last typed prompt as a user message.
		// Once this segment is harness, stay harness — do not remirror that prompt.
		if (this.userKind === "harness" && kind !== "remote" && kind !== "dispatch") {
			this.awaitingFirstAnswer = false;
			this.shouldMirrorPrompt = false;
			return;
		}
		this.userText = text;
		this.awaitingFirstAnswer = true;
		this.userKind = kind;
		this.shouldMirrorPrompt = kind === "local";
	}

	/** Copy the user kind onto a continuation segment without re-arming first-answer or remirroring. */
	carryUser(text: string): void {
		this.userText = text;
		this.awaitingFirstAnswer = false;
		this.userKind = classifyUserKind(text);
		this.shouldMirrorPrompt = false;
	}

	assistantFinal(text: string, closedAnswer = false): void {
		// Zero-width/format characters are not text: a "​" final is not an
		// answer and must never produce a bubble (857d984c, instance 4).
		const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
		if (cleaned) {
			this.lastAssistantText = cleaned;
			this.awaitingFirstAnswer = false;
		}
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

/**
 * First user-facing text after a user message, when that same assistant
 * message also starts tools (item f0df6c3e round 2). That line is the
 * finished answer for the thinking so far — even though hasToolCalls would
 * make isClosedAnswer false. Later tool events belong on a new trail.
 */
export function shouldSplitFirstAnswer(
	tracker: TurnTracker,
	input: { text: string; hasToolCalls: boolean },
): boolean {
	if (!tracker.awaitingFirstAnswer) return false;
	const cleaned = input.text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
	if (!cleaned) return false;
	// Same-message tools: this line is the answer; later tools get a new trail.
	// Text-only first closes wait for the next assistant round (or settle),
	// so a normal one-shot still posts once with complete_turn=true.
	return input.hasToolCalls;
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
	// Harness leftovers may wake the model; they are not room content.
	if (tracker.userKind === "harness") return { kind: "none" };
	if (!tracker.lastAssistantText) return { kind: "none" };
	if (tracker.userKind === "local" && tracker.shouldMirrorPrompt) {
		return { kind: "local_mirror", prompt: tracker.userText, answer: tracker.lastAssistantText };
	}
	// remote/dispatch, local continuations, and unknowns with an answer: post the final.
	return { kind: "final", message: tracker.lastAssistantText };
}
