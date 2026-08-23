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
 *   Mid-run wait-narration (“I'll wait… Independent work is done.”) is
 *   process, not an answer (item 15d7aa56 / brief 7e99501c): it stays on
 *   the trail and never splits a bubble. A text-only close after bg_run
 *   in the same segment is the same class (item 6ea9aa47): Grok's curly
 *   I’ll must fold to ASCII, and agent_settled must PAUSE the owner
 *   tracker so the [bg completed] wake continues the turn instead of
 *   opening a silent harness run.
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

export type UserKind = "remote" | "playbook" | "local" | "harness";

export const REMOTE_PREFIX = "[DevSpec remote — message from";
export const PLAYBOOK_RUN_PREFIX = "[DevSpec remote — playbook run";
const CONTEXT_TEXT_PREFIXES = [
	"### DevSpec memory — auto-recall",
	"[DevSpec remote — bond context",
	"[DevSpec remote — room orientation",
];
const SUBAGENT_NOTIFICATION_PREFIX = /^(?:Background task (?:completed|failed|paused|stopped)|Detached foreground task (?:completed|failed|paused|stopped)): \*\*[^\n]+\*\*(?: \([^\n]*\))?\n\n/;
const ASYNC_SUBAGENT_NOTIFICATION_PREFIX = /^Background task (?:completed|failed|paused|stopped): \*\*[^\n]+\*\*(?: \([^\n]*\))?\n\n/;
const GROUPED_SUBAGENT_NOTIFICATION_PREFIX = /^Background tasks completed \(\d+\):[^\n]*\n\n1\. /;

/**
 * Leftover / injected origin (items 56b9a3b4, 4f801a67, 71dc7d84).
 * Explicit DevSpec conversation envelopes win. Every other Pi customType is
 * extension-authored, never proof that the local human typed the content.
 * Text checks are compatibility backstops for hosts that drop customType.
 * A typed `/bg-update` is NOT harness — slash commands stay first-class local.
 */
export function isSubagentAsyncNotification(text: string, _customType?: string | null): boolean {
	const trimmed = text.trim();
	return ASYNC_SUBAGENT_NOTIFICATION_PREFIX.test(trimmed)
		|| GROUPED_SUBAGENT_NOTIFICATION_PREFIX.test(trimmed);
}

export function isHarnessOrigin(text: string, customType?: string | null): boolean {
	if (text.startsWith(REMOTE_PREFIX) || text.startsWith(PLAYBOOK_RUN_PREFIX)) return false;
	if (typeof customType === "string" && customType.trim()) return true;
	const t = text.trim();
	if (!t) return false;
	if (CONTEXT_TEXT_PREFIXES.some((prefix) => t.startsWith(prefix))) return true;
	if (t.includes("<background-task-notification")) return true;
	if (SUBAGENT_NOTIFICATION_PREFIX.test(t)) return true;
	if (GROUPED_SUBAGENT_NOTIFICATION_PREFIX.test(t)) return true;
	// CONTROL reload queues this command; it is not a typed local prompt.
	if (t === "/devspec.reload") return true;
	return /^\[bg (completed|failed|killed)\]/m.test(t);
}

export function classifyUserKind(text: string, customType?: string | null): UserKind {
	if (text.startsWith(REMOTE_PREFIX)) return "remote";
	if (text.startsWith(PLAYBOOK_RUN_PREFIX)) return "playbook";
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
	/**
	 * A genuine new conversational command arrived while older background work
	 * remains pending. Its first substantive speech outranks the generic
	 * "text-only while bg pending = process" rule and closes as an intermediate
	 * answer; the continuation segment keeps the task ownership.
	 */
	firstAnswerOverridesBackground = false;
	/** Captured segment may post before its pending tasks continue elsewhere. */
	answerClosesBeforeBackgroundContinuation = false;
	/** Owner-started automatic-wake tasks that have not reached terminal state. */
	private pendingBackgroundTaskIds = new Set<string>();
	/** Compatibility/readability projection used by lifecycle predicates. */
	get awaitingBackground(): boolean {
		return this.pendingBackgroundTaskIds.size > 0;
	}
	/** True when the last assistant close was wait/bg_run process, not an answer. */
	lastCloseWasProcess = false;

	userMessage(text: string, origin?: { customType?: string | null; backgroundTaskId?: string | null }): void {
		const kind = classifyUserKind(text, origin?.customType);
		const replacesConversationalCommand =
			kind !== "harness" && this.userKind !== null && this.userKind !== "harness";
		const interruptsPendingBackground = this.awaitingBackground && replacesConversationalCommand;
		// A leftover wake may replay the last typed prompt as a user message.
		// Once this segment is harness, stay harness — do not remirror that prompt.
		if (this.userKind === "harness" && kind !== "remote" && kind !== "playbook") {
			this.awaitingFirstAnswer = false;
			this.shouldMirrorPrompt = false;
			return;
		}
		// Mid-turn context/harness (auto-recall, leftover receipts) must not
		// steal an already-started remote/local/playbook turn (item 60cf5f00).
		if (kind === "harness" && this.userKind && this.userKind !== "harness") {
			// A terminal notification resolves only the task it names. This is
			// deliberately idempotent because before_agent_start + message_start
			// may observe the same custom message. One sibling completion must
			// never consume every pending task (item 15cb0983).
			if (origin?.backgroundTaskId) this.resolveBackgroundTask(origin.backgroundTaskId);
			return;
		}
		this.userText = text;
		this.awaitingFirstAnswer = true;
		this.userKind = kind;
		this.shouldMirrorPrompt = kind === "local";
		this.firstAnswerOverridesBackground = interruptsPendingBackground;
		this.answerClosesBeforeBackgroundContinuation = false;
	}

	/** Copy the user kind onto a continuation segment without re-arming first-answer or remirroring. */
	carryUser(text: string, from?: TurnTracker): void {
		this.userText = text;
		this.awaitingFirstAnswer = false;
		this.userKind = classifyUserKind(text);
		this.shouldMirrorPrompt = false;
		this.firstAnswerOverridesBackground = false;
		this.answerClosesBeforeBackgroundContinuation = false;
		if (from) {
			this.pendingBackgroundTaskIds = new Set(from.pendingBackgroundTaskIds);
			this.lastCloseWasProcess = from.lastCloseWasProcess;
		}
	}

	/**
	 * A terminal wake may arrive while authoritative background status is
	 * temporarily unavailable. Let the next substantive recap cross an
	 * incomplete delivery boundary without pretending the background is done.
	 */
	allowNextAnswerBeforeBackgroundContinuation(): void {
		if (!this.awaitingBackground) return;
		this.awaitingFirstAnswer = true;
		this.firstAnswerOverridesBackground = true;
	}

	/** A successful automatic-wake task started in this owner turn. */
	noteBackgroundTask(taskId: string): void {
		const id = taskId.trim();
		if (id) this.pendingBackgroundTaskIds.add(id);
	}

	/** Resolve one matching terminal notification; unknown/duplicate ids are no-ops. */
	resolveBackgroundTask(taskId: string): boolean {
		const id = taskId.trim();
		return id ? this.pendingBackgroundTaskIds.delete(id) : false;
	}

	pendingBackgroundTasks(): string[] {
		return [...this.pendingBackgroundTaskIds];
	}

	assistantFinal(text: string, closedAnswer = false): void {
		// Zero-width/format characters are not text: a "​" final is not an
		// answer and must never produce a bubble (857d984c, instance 4).
		const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
		if (!cleaned) {
			return;
		}
		const firstAnswerToBackgroundInterrupt =
			this.awaitingFirstAnswer
			&& this.firstAnswerOverridesBackground
			&& !isWaitNarration(cleaned);
		const process = isProcessClose({
			text: cleaned,
			// Background ownership belongs to the continuation. It must not erase
			// the first substantive answer to the newer human command.
			awaitingBackground: this.awaitingBackground && !firstAnswerToBackgroundInterrupt,
		});
		// Wait / bg_run process is trail, not the room answer (15d7aa56 / 6ea9aa47).
		if (!process) {
			this.lastAssistantText = cleaned;
			this.awaitingFirstAnswer = false;
			this.firstAnswerOverridesBackground = false;
			this.answerClosesBeforeBackgroundContinuation = firstAnswerToBackgroundInterrupt;
		}
		// Only a real stored close can be an answer; wait/bg never is.
		this.lastCloseWasAnswer = closedAnswer && !process;
		this.lastCloseWasProcess = process;
	}
}

export type SettlePlan =
	| { kind: "none" }
	| { kind: "final"; message: string }
	| { kind: "local_mirror"; prompt: string; answer: string };

/**
 * Extract a successful provider launch that will both notify and wake Pi.
 * The background-task providers share details.task; failed launches or
 * notification-only tasks must not park an owner turn forever.
 */
const AUTOMATIC_BACKGROUND_LAUNCH_TOOLS = new Set([
	"bg_run",
	"bg_run_pi_attested",
	"bg_delegate",
	"fusion_reason",
	"fusion_investigate",
	"fusion_research",
	"fusion_validate",
]);

export function automaticBackgroundTaskId(
	toolName: string,
	result: unknown,
	isError = false,
): string | null {
	// Inspection tools such as bg_logs return the original task receipt too.
	// Receipt shape alone is therefore not proof of launch (item 15cb0983).
	if (!AUTOMATIC_BACKGROUND_LAUNCH_TOOLS.has(toolName)) return null;
	if (isError || !result || typeof result !== "object") return null;
	const outer = result as { details?: unknown; task?: unknown };
	const details = outer.details && typeof outer.details === "object"
		? outer.details as { task?: unknown }
		: outer;
	const task = details.task;
	if (!task || typeof task !== "object") return null;
	const receipt = task as {
		id?: unknown;
		notifyOnCompletion?: unknown;
		triggerOnCompletion?: unknown;
	};
	if (receipt.notifyOnCompletion !== true || receipt.triggerOnCompletion !== true) return null;
	return typeof receipt.id === "string" && receipt.id.trim() ? receipt.id.trim() : null;
}

/** Terminal task id from Pi's custom notification envelope/details. */
export function backgroundTaskNotificationId(text: string, details?: unknown): string | null {
	let structuredId: string | null = null;
	let structuredStatus: string | null = null;
	if (details && typeof details === "object") {
		const record = details as {
			id?: unknown;
			taskId?: unknown;
			status?: unknown;
			task?: { id?: unknown; status?: unknown };
		};
		for (const value of [record.id, record.taskId, record.task?.id]) {
			if (typeof value === "string" && value.trim()) {
				structuredId = value.trim();
				break;
			}
		}
		const status = record.status ?? record.task?.status;
		if (typeof status === "string") structuredStatus = status.trim().toLowerCase();
	}
	const xmlId = text.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/i)?.[1]?.trim() ?? null;
	const xmlStatus = text.match(/<status>\s*([^<]+?)\s*<\/status>/i)?.[1]?.trim().toLowerCase() ?? null;
	const status = structuredStatus || xmlStatus;
	if (!status || !["completed", "failed", "killed"].includes(status)) return null;
	return structuredId || xmlId;
}

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
	if (!cleaned || isWaitNarration(cleaned)) return false;
	// A newer genuine user command can interrupt a parked background segment.
	// Its first substantive speech must land immediately even if text-only;
	// pending tasks continue behind a complete_turn=false boundary.
	if (tracker.firstAnswerOverridesBackground) return true;
	if (isProcessClose({ text: cleaned, awaitingBackground: tracker.awaitingBackground })) {
		return false;
	}
	// Same-message tools: this line is the answer; later tools get a new trail.
	// Text-only first closes wait for the next assistant round (or settle),
	// so a normal one-shot still posts once with complete_turn=true.
	return input.hasToolCalls;
}

const CLOSED_ANSWER_STOPS = new Set(["stop"]);
const OPEN_ROUND_STOPS = new Set(["toolUse", "aborted", "error", "length", "pending"]);

/** Grok (and others) emit curly I’ll; the wait regex is ASCII. */
export function foldApostrophes(text: string): string {
	return text.replace(/[\u2018\u2019\u02BC\u2032]/g, "'");
}

function cleanedProcessText(text: string): string {
	return foldApostrophes(text.replace(/[\u200B-\u200D\uFEFF]/g, "")).trim();
}

/**
 * Mid-run process close while a background task is in flight (item 15d7aa56).
 * The model is told to acknowledge and end the turn rather than poll; that
 * sentence is trail, not a spoken answer. Matches the now-line contract
 * (brief 7e99501c / decision af24bdb5): the room is things said, not work.
 */
export function isWaitNarration(text: string): boolean {
	const cleaned = cleanedProcessText(text);
	if (!cleaned || cleaned.length > 500) return false;
	if (/\bindependent work is done\b/i.test(cleaned)) return true;
	// Owner-directed waits are real answers ("I'll wait for your go-ahead").
	if (/\?/.test(cleaned)) return false;
	const waitingOnWork =
		/\bI(?:'ll| will) wait (?:for|until)\b/i.test(cleaned) &&
		/\b(test|tests|typecheck|suite|task|results?|notification|build|lint|ci)\b/i.test(cleaned);
	if (waitingOnWork) return true;
	// "Typecheck is still running. I'll push after." — process even without "wait".
	const runningWork = /\b(typecheck|lint|test|tests|suite|build|ci)\b/i.test(cleaned) &&
		/\b(still running|is running)\b/i.test(cleaned);
	if (runningWork) return true;
	// A person's name in a work-status sentence does not turn process narration
	// into an answer ("CI is still running, Ali"). Non-work waits addressed to
	// the owner remain conversational.
	if (/\b(you|your|Ali)\b/i.test(cleaned)) return false;
	return false;
}

/**
 * Trail process, not a spoken answer: wait-narration, or a text-only close
 * while this segment still has an unresolved bg_run (item 6ea9aa47).
 */
export function isProcessClose(input: {
	text: string;
	awaitingBackground?: boolean;
	hasToolCalls?: boolean;
}): boolean {
	const cleaned = cleanedProcessText(input.text);
	if (!cleaned) return false;
	if (isWaitNarration(cleaned)) return true;
	if (input.hasToolCalls) return false;
	return Boolean(input.awaitingBackground);
}

/**
 * agent_settled after a wait/bg_run close must keep the owner tracker so the
 * next [bg completed] wake continues the turn (item 6ea9aa47).
 */
export function shouldPauseSettle(tracker: TurnTracker): boolean {
	if (!tracker.userKind || tracker.userKind === "harness") return false;
	// A delivery-boundary segment may speak now while its copied continuation
	// retains the pending task ids. Do not let the old segment's background set
	// suppress the answer it was created to deliver.
	if (tracker.lastCloseWasAnswer && tracker.answerClosesBeforeBackgroundContinuation) {
		return false;
	}
	return tracker.lastCloseWasProcess || tracker.awaitingBackground;
}

/**
 * A text-only assistant close is a finished answer (item f0df6c3e).
 * Tool-loop rounds (toolCall blocks or stopReason=toolUse) stay in the trail.
 * Missing stopReason with no tool calls still counts as closed — some providers
 * omit it; the content shape is the authority.
 * Wait-narration / unresolved bg_run closes are the exception (15d7aa56 /
 * 6ea9aa47): process, not a closed answer.
 */
export function isClosedAnswer(input: {
	text: string;
	hasToolCalls: boolean;
	stopReason?: string | null;
	awaitingBackground?: boolean;
}): boolean {
	const cleaned = input.text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
	if (!cleaned) return false;
	if (isProcessClose({
		text: cleaned,
		awaitingBackground: input.awaitingBackground,
		hasToolCalls: input.hasToolCalls,
	})) {
		return false;
	}
	if (input.hasToolCalls) return false;
	const reason = input.stopReason ?? "stop";
	if (OPEN_ROUND_STOPS.has(reason)) return false;
	return CLOSED_ANSWER_STOPS.has(reason) || input.stopReason == null;
}

export function planSettle(tracker: TurnTracker, attached: boolean): SettlePlan {
	if (!attached) return { kind: "none" };
	// Harness leftovers may wake the model; they are not room content.
	if (tracker.userKind === "harness") return { kind: "none" };
	if (shouldPauseSettle(tracker)) return { kind: "none" };
	if (!tracker.lastAssistantText) return { kind: "none" };
	if (tracker.userKind === "local" && tracker.shouldMirrorPrompt) {
		return { kind: "local_mirror", prompt: tracker.userText, answer: tracker.lastAssistantText };
	}
	// Remote/playbook, local continuations, and unknowns with an answer: post the final.
	return { kind: "final", message: tracker.lastAssistantText };
}
