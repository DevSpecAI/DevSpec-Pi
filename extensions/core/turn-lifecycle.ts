/** Turn/activity bookkeeping. Assistant speech admission is structural only;
 * source capture and delivery live in assistant-speech.ts and the controller. */

import { hasAssistantSpeech } from "./assistant-speech.ts";
import { INTERACTION_EVENT_CUSTOM_TYPE } from "./interaction-events.ts";

export type UserKind = "remote" | "automation" | "interaction" | "local" | "harness";

export const REMOTE_PREFIX = "[DevSpec remote — message from";
export const AUTOMATION_RUN_PREFIX = "[DevSpec remote — automation run";
export const INTERACTION_CONTINUATION_PREFIX = "[DevSpec directed-question workflow continuation]";
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
	if (text.startsWith(REMOTE_PREFIX) || text.startsWith(AUTOMATION_RUN_PREFIX) ||
		text.startsWith(INTERACTION_CONTINUATION_PREFIX) || customType === INTERACTION_EVENT_CUSTOM_TYPE) return false;
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
	if (text.startsWith(AUTOMATION_RUN_PREFIX)) return "automation";
	if (text.startsWith(INTERACTION_CONTINUATION_PREFIX) || customType === INTERACTION_EVENT_CUSTOM_TYPE) return "interaction";
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
	/** Historical harness trail eligibility. Never gates actual assistant speech. */
	harnessSpeechAllowed = false;
	/**
	 * Owner-started automatic-wake tasks that have not reached terminal state.
	 * Never gates speech or settles (759f2818). The WIRING passes one shared
	 * connection-scoped set into every segment's tracker (TurnTracker ctor):
	 * presence (Working) follows outstanding background work across settles
	 * and completion wakes (owner direction 2026-09-17 PM — bubbles stay
	 * decoupled, but "bg 2 running" means still working). Standalone trackers
	 * (tests) get an independent set.
	 */
	private pendingBackgroundTaskIds: Set<string>;

	constructor(sharedPendingBackgroundTaskIds?: Set<string>) {
		this.pendingBackgroundTaskIds = sharedPendingBackgroundTaskIds ?? new Set();
	}
	/** Compatibility/readability projection used by lifecycle predicates. */
	get awaitingBackground(): boolean {
		return this.pendingBackgroundTaskIds.size > 0;
	}
	/** True when the last assistant close was wait/receipt process, not an answer. */
	lastCloseWasProcess = false;

	userMessage(text: string, origin?: { customType?: string | null; backgroundTaskId?: string | null }): void {
		const kind = classifyUserKind(text, origin?.customType);
		// A leftover wake may replay the last typed prompt as a user message.
		// Once this segment is harness, stay harness — do not remirror that prompt.
		if (this.userKind === "harness" && kind !== "remote" && kind !== "automation") {
			// A second completion arriving ON a harness wake segment must still
			// resolve its task — the early return leaked B2's id live on
			// 2026-09-17 (session ea7704f4), parking Working at a stuck timer long
			// after every task had finished (759f2818).
			if (origin?.backgroundTaskId) this.resolveBackgroundTask(origin.backgroundTaskId);
			this.awaitingFirstAnswer = false;
			this.shouldMirrorPrompt = false;
			return;
		}
		// Mid-turn context/harness (auto-recall, leftover receipts) must not
		// steal an already-started remote/local/automation turn (item 60cf5f00).
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
		if (kind === "harness") {
			this.harnessSpeechAllowed = isBackgroundCompletionOrigin(text, origin?.customType);
			// A fresh completion-wake segment resolves its task too — with the
			// connection-scoped shared set this is what releases Working when the
			// last task completes (the old parked-tracker model resolved on the
			// surviving owner tracker; there is no surviving tracker any more).
			if (origin?.backgroundTaskId) this.resolveBackgroundTask(origin.backgroundTaskId);
		}
	}

	/** Copy the user kind onto a continuation segment without re-arming first-answer or remirroring. */
	carryUser(text: string, from?: TurnTracker): void {
		this.userText = text;
		this.awaitingFirstAnswer = false;
		this.userKind = classifyUserKind(text);
		this.shouldMirrorPrompt = false;
		if (from) {
			// Merge, never replace: the wiring hands every segment the SAME
			// connection-scoped set, so a resolve on any segment is visible to
			// all (15cb0983's copy-not-alias is superseded by sharing).
			if (this.pendingBackgroundTaskIds !== from.pendingBackgroundTaskIds) {
				for (const id of from.pendingBackgroundTasks()) this.pendingBackgroundTaskIds.add(id);
			}
			this.lastCloseWasProcess = from.lastCloseWasProcess;
			this.harnessSpeechAllowed = from.harnessSpeechAllowed;
		}
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

	/** Retain raw finalized assistant text. "process" remains in the legacy debug
	 * type only; wording and input provenance no longer suppress actual speech. */
	assistantFinal(text: string, closedAnswer = false): "empty" | "process" | "stored" {
		if (!hasAssistantSpeech(text)) return "empty";
		this.lastAssistantText = text;
		this.awaitingFirstAnswer = false;
		this.lastCloseWasAnswer = closedAnswer;
		this.lastCloseWasProcess = false;
		return "stored";
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

/**
 * Terminally-finished background task ids from background-management tool
 * results (item f453c61f).
 *
 * Completion custom-messages are the primary resolution path, but a task
 * killed from outside (bg_kill) never produces one — and a kill result only
 * lands here, in tool_execution_end. Without this the id leaks and every
 * later settle posts complete_turn:false forever (live 2026-09-20: 5h stuck
 * Working on a killed dev server). bg_status results reconcile the same way
 * for tasks that died without any notice at all.
 *
 * Resolve ONLY on explicit terminal states. Failed-tool results, running or
 * unknown states, malformed shapes and missing lists resolve nothing: a
 * wrong resolve shows Idle while work runs, which is worse than the leak.
 * Ids absent from the pending set are naturally no-ops at resolve time, so
 * a status listing that spans sessions cannot disturb this turn's bookkeeping.
 */
const TERMINAL_BG_TASK_STATUSES = new Set(["completed", "failed", "killed"]);

function terminalTaskId(task: unknown): string | null {
	if (!task || typeof task !== "object") return null;
	const receipt = task as { id?: unknown; status?: unknown };
	if (typeof receipt.id !== "string" || !receipt.id.trim()) return null;
	if (typeof receipt.status !== "string") return null;
	if (!TERMINAL_BG_TASK_STATUSES.has(receipt.status.trim().toLowerCase())) return null;
	return receipt.id.trim();
}

export function terminalBackgroundTaskIds(
	toolName: string,
	result: unknown,
	isError = false,
): string[] {
	if (isError || !result || typeof result !== "object") return [];
	const outer = result as { details?: unknown; task?: unknown; tasks?: unknown };
	if (toolName === "bg_kill") {
		const details = outer.details && typeof outer.details === "object"
			? (outer.details as { task?: unknown })
			: outer;
		const id = terminalTaskId(details.task);
		return id ? [id] : [];
	}
	if (toolName === "bg_status") {
		const details = outer.details && typeof outer.details === "object"
			? (outer.details as { tasks?: unknown })
			: outer;
		const tasks = (details as { tasks?: unknown }).tasks;
		if (!Array.isArray(tasks)) return [];
		const ids: string[] = [];
		for (const task of tasks) {
			const id = terminalTaskId(task);
			if (id) ids.push(id);
		}
		return ids;
	}
	return [];
}

/**
 * Working-lease progress evidence (item 0b8035ac; server migration 952).
 *
 * The server renews a working attempt's lease on a keepalive only while the
 * caller's progress marker keeps CHANGING; a marker frozen past the staleness
 * bound is declined ('stale') and the attempt expires on its lease. This is
 * what stops a wedged tracker (pendingBg stuck at 1, session ea7704f4,
 * 2026-09-20) from holding Working for hours: the wedge froze every event
 * stream, so a counter fed BY those streams provably stops too.
 *
 * One process-global monotonic counter, bumped by the extension's event
 * handlers (turns, messages, tool executions, updates). Opaque and cheap —
 * the server compares for change, never meaning. Monotonicity within the
 * process is all the server needs; a restart re-seeds from zero and the first
 * beat reads as progress (the marker differs from whatever the attempt held).
 */
let progressEventCounter = 0;

/** Record one unit of observed work. Called from the extension's event handlers. */
export function noteProgressEvent(): void {
	progressEventCounter += 1;
}

/** The current opaque marker value to ride the next keepalive/heartbeat. */
export function currentProgressMarker(): string {
	return String(progressEventCounter);
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

/** Legacy split predicate; the source-aware controller never splits execution
 * for speech. Kept for compatibility with bookkeeping callers/tests. */
export function shouldSplitSpeech(
	tracker: TurnTracker,
	input: { text: string; hasToolCalls: boolean },
): boolean {
	return input.hasToolCalls && hasAssistantSpeech(input.text);
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
 * Trail process, not a spoken answer: wait-narration only. Since 2026-09-17
 * (759f2818) this is purely textual — the old "text-only close while a bg_run
 * is pending = process" blanket rule (6ea9aa47) is deleted: it could not tell
 * "typecheck still running" from a 2.6k final report, and swallowed the
 * latter whole. Wait-class shapes are all covered by isWaitNarration.
 */
export function isProcessClose(input: { text: string }): boolean {
	const cleaned = cleanedProcessText(input.text);
	if (!cleaned) return false;
	return isWaitNarration(cleaned);
}

/**
 * Pure background-task receipt acknowledgements on a harness wake —
 * "expected teardown", "completion receipt … no action needed". These are
 * the harness mumbling to itself, not room content (56b9a3b4 / 15d7aa56).
 * Length-capped so substantive wake news (a failed gate, a verified deploy)
 * always posts; the 2026-09-17 incident was caused by the reverse bias.
 */
export function isReceiptAcknowledgement(text: string): boolean {
	const cleaned = cleanedProcessText(text);
	if (!cleaned || cleaned.length > 500) return false;
	return /(?:expected teardown|receipt|no action (?:needed|required)|no further action|nothing (?:further|outstanding|left)|already (?:consumed|acted on|passed|accounted)|minimal acknowledg)/i.test(cleaned);
}

/**
 * Whether a harness-origin wake was a background task completion — the only
 * harness wake whose substantive speech may reach the room. Context
 * injections (auto-recall, attach context, orientation) and other leftovers
 * stay silent.
 */
export function isBackgroundCompletionOrigin(text: string, customType?: string | null): boolean {
	if (customType === "background-task-notification" || customType === "subagent-notify") return true;
	const t = text.trim();
	if (!t) return false;
	if (t.includes("<background-task-notification")) return true;
	if (/^\[bg (?:completed|failed|killed)\]/m.test(t)) return true;
	if (SUBAGENT_NOTIFICATION_PREFIX.test(t)) return true;
	if (GROUPED_SUBAGENT_NOTIFICATION_PREFIX.test(t)) return true;
	return false;
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
}): boolean {
	const cleaned = input.text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
	if (!cleaned) return false;
	if (isProcessClose({ text: cleaned })) {
		return false;
	}
	if (input.hasToolCalls) return false;
	const reason = input.stopReason ?? "stop";
	if (OPEN_ROUND_STOPS.has(reason)) return false;
	return CLOSED_ANSWER_STOPS.has(reason) || input.stopReason == null;
}

export function planSettle(tracker: TurnTracker, attached: boolean): SettlePlan {
	if (!attached) return { kind: "none" };
	// Legacy planner only. Source-aware controller speech bypasses settlement;
	// this helper cannot grant source authority or decide execution completion.
	if (!tracker.lastAssistantText) return { kind: "none" };
	if (tracker.userKind === "local" && tracker.shouldMirrorPrompt) {
		return { kind: "local_mirror", prompt: tracker.userText, answer: tracker.lastAssistantText };
	}
	// Remote/automation, local continuations, and unknowns with an answer: post the final.
	return { kind: "final", message: tracker.lastAssistantText };
}
