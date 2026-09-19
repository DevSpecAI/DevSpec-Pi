/**
 * DevSpec Pi — remote control (Phase 4, slice 1).
 *
 *   /devspec.remote [--session <id>]   bond this pi session as DevSpec capacity
 *   /devspec.remote stop               end the bond (sticky 'local_stop')
 *
 * Design (VISION.md):
 * - Bond key = the pi session id (conversation id — never cwd/shell).
 * - ONE negotiated poll_connection long-poll carries heartbeat and canonical
 *   ingress; commands arrive as REAL user messages (sendUserMessage).
 * - Runtime ingress semantics are served at
 *   devspec://product/remote-ingress-contract rather than duplicated here.
 * - Egress is runtime-mechanical (item cc9e8c43): the extension delivers
 *   assistant text as session answers. A text-only close is a finished
 *   bubble with complete_turn:false (work may continue); settle / a new
 *   user message posts complete_turn:true. The model never posts
 *   conversational content — ONE writer, no suppression, no dual writers.
 * - The pump asserts busy from pi's own turn events and reports
 *   listener_armed from the live loop — never from leftover state.
 * - Headless: works in -p/rpc/json; notifications degrade to no-ops.
 */

import { AssistantSpeechSource, AssistantSpeechQueue, assistantSpeechWithinBudget } from "./core/assistant-speech.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { debugRemote as debug } from "./core/debug.ts";
import { DeliveryQueue, StaleDeliveryError, nextDeliveryRetryDelayMs, type DeliveryLease } from "./core/delivery-queue.ts";
import { revalidateAutomationRunRetry } from "./core/automation-run-retry.ts";
import {
	callDevspec,
	DevspecAuthError,
	isPermanentServerEnd,
	MODEL_TIMEOUT_MS,
	DevspecToolError,
	shouldEndBondOnPollFailure,
} from "./core/client.ts";
import { connectionCapabilityFromResult, getBond, setBond, type BondState } from "./core/bond-state.ts";
import {
	capturePumpAuthority,
	isPumpAuthorityCurrent,
	planRecoveredConnectionScope,
} from "./core/bond-recovery.ts";
import {
	formatCanonicalDeliveryContext,
	formatInboundBundleMessage,
	parsePollPayload,
	type IngressAdvisoryContext,
	type OwnerCommand,
	type OwnerCommandBundle,
	type RemoteConnectionIdentity,
} from "./core/remote-payload.ts";
import { CommandTurnBindings, type CanonicalQueueItem } from "./core/command-turn.ts";
import { compactWithContext, executeControlCommand, parseControlCommand, reloadWithContext, runReloadLap } from "./core/control.ts";
import { safeHasUI, withLiveUi } from "./core/ctx-guard.ts";
import { commandReloadContext, rememberExtensionRunner } from "./core/command-runner.ts";
import { collectModelCatalog, type ModelCatalogSnapshot } from "./core/model-catalog.ts";
import {
	AttachmentDeliveryLease,
	cleanupMaterialisedAttachments,
	createAttachmentHydrationBudget,
	formatAttachmentNotes,
	materialiseAttachments,
	requireMaterialisedAttachments,
	sanitizeAttachmentFailureReason,
	type AttachmentHydrationBudget,
	type MaterialisedAttachment,
} from "./core/attachments.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { bondedRemoteAction, namedSessionFromRemoteArg } from "./core/remote-session-arg.ts";
import { shapeTranscript } from "./core/attach-context.ts";
import { parsePostSessionReceipt, TrailDeliveryState } from "./core/post-session-receipt.ts";
import { extractAssistantParts, extractText, FINAL_TRAIL_CHARS, TrailBuilder } from "./core/trail.ts";
import { SubagentFleetClient, type SubagentFleetSnapshot } from "./core/subagent-fleet.ts";
import { buildAgentStatsReport, refreshAgentStatsReport, TelemetryCollector, type AgentStatsReport, type MessageUsage } from "./core/telemetry.ts";
import { takeContextBudgetReport } from "./core/context-budget.ts";
import { automaticBackgroundTaskId, backgroundTaskNotificationId, planSettle, isDeliveryBoundary, isClosedAnswer, isClosedAnswerBoundary, shouldSplitSpeech, isHarnessOrigin, isSubagentAsyncNotification, TurnTracker } from "./core/turn-lifecycle.ts";
import {
	formatAutomationRunMessage,
	isAutomationRunEnvelope,
	automationRunId,
} from "./core/dispatch.ts";
import {
	firstTextPreview,
	isRealSessionTitle,
	noteVerbEnd,
	noteAutomation,
	noteVerbStart,
	paintStatus,
	previewFromText,
	resetStatus,
	setSessionPreview,
	syncBondIntoStatus,
} from "./core/status-line.ts";
import {
	DirectedQuestionReceiptBatch,
	TrailPostFence,
	isPotentialDirectedQuestionCreate,
	isReceiptOwningDirectedQuestionCreate,
} from "./core/question-receipt-lifecycle.ts";
import {
	BusyWakeLatch,
	openPushChannel,
	nextPushReconnectDelayMs,
	PushChannelGenerationFence,
	RuntimeOccupancyFence,
	WakeGenerationGate,
	type RuntimeOccupancyRevision,
} from "./core/push-channel.ts";
import {
	ACTIVE_PLAN_CLEAR_TOMBSTONE,
	activePlanTailForDelivery,
	authoritativeActivePlanTransitionTail,
	appendActivePlanTail,
	clearActivePlanAwareness,
	markActivePlanAwareness,
	serializeActiveSessionPlansProjection,
} from "./core/active-session-plans.ts";
import {
	serializeSessionPollsProjection,
} from "./core/session-polls.ts";
import {
	serializeStillToDiscussProjection,
} from "./core/still-to-discuss.ts";
import {
	withDirectedQuestionToolActive,
	withPlanToolActive,
	withPollToolActive,
} from "./core/model-surface.ts";
import {
	INTERACTION_EVENT_CUSTOM_TYPE,
	QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE,
	QUESTION_DISMISSAL_EVENT_KIND,
	interactionEventCustomType,
	interactionEventAck,
	interactionEventAckArgs,
	interactionContinuationStartArgs,
	INTERACTION_EVENT_JOURNAL_TYPE,
	InteractionEventDeliveryController,
	InteractionEventJournal,
	exactInteractionContinuationArgs,
	exactInteractionAuthorityMatches,
	interactionContinuationStartAction,
	interactionEventJournalEntry,
	interactionEventMatchesWorkflow,
	parseInteractionContinuationStartResult,
	parseDirectedQuestionEventPollPayload,
	persistedActiveBranchEntries,
	type ExactInteractionContinuationIdentity,
	type InteractionEventApplicationDetails,
	type InteractionEventDeliveryAuthority,
	type InteractionEventDeliveryPort,
	type InteractionEventMessageEndLike,
	type DirectedQuestionEventV1,
	type SessionEntryLike,
} from "./core/interaction-events.ts";
import { resolveEndpoint, resolveToken } from "./core/auth-store.ts";
import { loadSettings, saveSettings } from "./core/settings.ts";
import { decideInteractionDelivery, decideOwnerDelivery, shouldClearStrandedBusyAfterAbort, waitUntil } from "./core/preempt.ts";
import {
	SeenOwnerCommands,
	sendModeAtSendTime,
} from "./core/owner-inject.ts";
import {
	SYSTEM_NOTICE_CUSTOM_TYPE,
	acceptSystemNotices,
	bindSystemNoticeState,
	commitSystemNoticeDelivery,
	formatSystemNoticeMessage,
	hasSystemNoticeBatchCapacity,
	queuedSystemNotices,
	revokeSystemNoticeState,
	remoteRunActivityPolicy,
	shouldDeliverSystemNotices,
	transitionToRealUserActivity,
} from "./core/system-notice.ts";

const AGENT_NAME = "Pi";
/** Aggregate current-session ownership; child identities remain inside pi-subagents. */
const SUBAGENT_FLEET_TASK_ID = "pi-subagents:active-fleet";
const POLL_WAIT_MS = 25_000;
/** Hold + margin; must stay under the MCP client default timeout. */
const POLL_TIMEOUT_MS = 45_000;
/**
 * Push-mode safety cadence: the longest the pump goes without a presence
 * stamp while SSE is up (item 7b649070).
 *
 * Four clocks, four values — never merged because all are durations:
 * presence cadence here (45s), display freshness server-side (90s
 * REMOTE_AGENT_LIVE_MS), working-attempt lease (server-owned), and the
 * irreversible-end cutoff (10min REMOTE_AGENT_END_CUTOFF_MS, sweep only).
 *
 * 45s is half the 90s display window, so a live agent survives one fully
 * missed safety lap plus poll latency and still stamps before the chip can
 * call it offline. The previous 75s left 15s of nominal headroom — less than
 * one slow auth round trip — which is why healthy idle Pi agents flickered.
 * Load: 1.33 req/min/agent against the 60/min token bucket (a 12-agent room
 * ≈ 16/min), each lap one poll = one presence write. The numerical match
 * with POLL_TIMEOUT_MS is coincidence, not a relationship — do not merge
 * them. Transport mode (SSE vs held-poll fallback) is orthogonal to busy vs
 * idle: Pi can use SSE while busy, and wakes shorten observed gaps in both.
 */
export const PUSH_SAFETY_MS = 45_000;
const ERROR_BACKOFF_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 10;

interface PendingInteractionStartRetry {
	event: DirectedQuestionEventV1;
	generation: number;
	localSessionId: string;
	attempts: number;
	nextAt: number;
}

interface PendingInteractionReleaseRetry {
	run: ExactInteractionRun;
	attempts: number;
	nextAt: number;
}

interface PumpState {
	/** Monotonic authority generation; async work may commit only while this pump remains current. */
	generation: number;
	bond: BondState;
	cursor?: string;
	dispatchCursor?: string;
	/** Independent v1 notice point; advances only after validated host acceptance. */
	systemNoticeCursor?: string;
	/** Frozen exact addressee for this registered pump generation. */
	connectionIdentity: RemoteConnectionIdentity;
	/** globalThis notice state key: Pi session + connection + pump generation. */
	systemNoticeKey: string;
	busy: boolean;
	stop: boolean;
	/** Shutdown blocks intake but still permits exact terminal fallback posts. */
	closing?: boolean;
	errors: number;
	/**
	 * False until the first package has been processed. The cold-start poll
	 * has no cursor, so the server answers with the catch-up WINDOW — which
	 * includes already-answered commands. Re-delivering those re-runs old
	 * work (observed live: a replied-to UI message re-injected on rebond).
	 * The first *catch-up* package is ORIENTATION: adopt its cursors and
	 * remember PRE-ATTACH command ids so answered history is not replayed.
	 * Commands created at/after this bond attached are live and must still
	 * be delivered (item 09d4993e). An empty wake (no cursor) is not a
	 * completed sync — the next cursor-less poll is still catch-up
	 * (live miss: Ali 2026-08-13, answered 11:46 message replayed after rebond).
	 */
	synced: boolean;
	seenOwnerCommands: SeenOwnerCommands;
	/** Latest bounded advisory-only ingress, carried to the next exact command. */
	advisoryCarry: IngressAdvisoryContext[];
	// Push channel state (SSE wake mode; falls back to held long-poll).
	pushAbort?: AbortController;
	pushClosed?: boolean;
	pushEnded?: string | null;
	/** Consecutive short-lived-stream drops — drives reconnect backoff. */
	pushAttempts: number;
	pushOpenedAt?: number;
	pushReconnectTimer?: ReturnType<typeof setTimeout>;
	/** Negotiation carried by the currently open one-and-only SSE stream. */
	pushInteractionAware?: boolean;
	/** Fences close callbacks and reconnect timers from every replaced stream. */
	pushGenerationFence: PushChannelGenerationFence;
	/** True model occupancy includes activity-neutral system-notice runs. */
	runtimeOccupancy: RuntimeOccupancyFence;
	/** A wake consumed while occupied must be replayed once Pi reaches true idle. */
	idleBoundaryWake: BusyWakeLatch;
	/** Stable Pi conversation identity captured when this pump generation bonded. */
	localSessionId: string;
	pendingInteractionStarts: Map<string, PendingInteractionStartRetry>;
	pendingInteractionReleases: Map<string, PendingInteractionReleaseRetry>;
	interactionRetryTimer?: ReturnType<typeof setTimeout>;
	wakeGate: WakeGenerationGate;
	/** Last attach-context/title fetch attempt — titles are job-generated, so a
	 *  missing one is retried on a slow cadence, never hot-polled (Ali: a brand-new
	 *  session may have no title at attach time; check again later). */
	lastSessionEnrichAt?: number;
	/** Typed automation-run delivery stays ordered without blocking the pump. */
	automationQueue: DeliveryQueue;
	/** Exact-target retry survives cursor advancement after a transient send failure. */
	automationRetryAttempts: Map<string, number>;
	automationRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
	/** Unchanged canonical cursors retry attachment hydration only after bounded delay. */
	attachmentRetryAttempts: Map<string, number>;
	/** Pi local session identity scopes minimal awareness across reload/rebond. */
	awarenessKey: string;
	/** Latest validated 1.3 projection tail and its not-yet-injected revision. */
	activePlanTail: string;
	pendingActivePlanTail: string;
	/** Latest validated session_polls advisory tail. */
	sessionPollsTail: string;
	pendingSessionPollsTail: string;
	/** Latest validated this-session Still to Discuss tail. */
	stillToDiscussTail: string;
	pendingStillToDiscussTail: string;
}

let pump: PumpState | null = null;
let nextPumpGeneration = 1;
/** Branch-local durable receipts, reconstructed from Pi's JSONL session. */
let interactionJournal = new InteractionEventJournal();
let interactionDelivery = new InteractionEventDeliveryController(interactionJournal);
interface ExactInteractionRun {
	active: PumpState;
	authority: InteractionEventDeliveryAuthority;
	details: InteractionEventApplicationDetails & { attempt_id: string };
	identity: ExactInteractionContinuationIdentity;
	application: "starting" | "applied" | "released";
}
interface PendingInteractionConfirmation {
	message: InteractionEventMessageEndLike;
	sessionFile: string | undefined;
	sessionManager: ExtensionContext["sessionManager"];
	active: PumpState;
	run: ExactInteractionRun;
}
const pendingInteractionConfirmations = new Set<PendingInteractionConfirmation>();
/** The only exact continuation accepted by Pi but not yet fully settled. */
let startingInteractionRun: ExactInteractionRun | null = null;
const interactionRunsByEvent = new Map<string, ExactInteractionRun>();
const INTERACTION_RETRY_MS = [500, 2_000, 5_000, 10_000] as const;

function interactionRetryDelay(attempts: number): number {
	return INTERACTION_RETRY_MS[Math.min(attempts, INTERACTION_RETRY_MS.length - 1)]!;
}

/** Cached so a mid-turn poll does not re-read settings.json every lap. */
let preemptOwnerCached = true;

// ---- Mechanical turn lifecycle (trail + final answer) ---------------------
// All of this is extension-mechanical: zero tokens, no model compliance.

interface SpeechBinding {
	readonly args: Readonly<Record<string, unknown>>;
	readonly current: () => boolean;
	readonly capability: string;
	readonly ready: Promise<{ args: Readonly<Record<string, unknown>>; token: string } | null>;
}
interface TurnState {
	speechManaged?: boolean;
	speechScopeCaptured?: boolean;
	speechBinding?: SpeechBinding;
	assistantSpeech?: { source: AssistantSpeechSource; binding?: SpeechBinding; model: Record<string, unknown> };

	/** Monotonic segment revision; protects awaited settle reconciliation. */
	revision: number;
	tracker: TurnTracker;
	trail: TrailBuilder;
	/** Immutable poll-delivered command generation this segment answers. */
	commandTurnId?: string;
	/** Exact owner command/source message this transcript segment answers. */
	commandMessageId?: string;
	/** Harness notice runs never post/complete owner command activity. */
	completionNeutral: boolean;
	/** Exact event/claim-bound activity for a directed-question continuation. */
	interaction?: ExactInteractionRun;
	/** Runtime run generation; older settle callbacks cannot clear a newer run. */
	occupancy?: RuntimeOccupancyRevision;
	lastInteractionKeepaliveAt?: number;
	/** Receipt-owned tool-batch state; never suppresses tool execution or completion. */
	receiptBatch: DirectedQuestionReceiptBatch;
	/** Every asynchronous projection that can still mutate this turn's pointer. */
	trailPostFence: TrailPostFence;
	trailDelivery: TrailDeliveryState;
	/** Captured connection/room authority; delayed segments cannot follow a reattach. */
	canPost: () => boolean;
	interval: ReturnType<typeof setInterval> | null;
	/** Trail posts so far this run — drives the adaptive cadence. */
	posts: number;
	lastPostAt: number;
}

/**
 * Adaptive trail cadence (learned the hard way: 1/sec flat blew the 60
 * req/min per-token budget on a multi-minute turn — every later tick then
 * retried into the limiter). First post lands fast so the bubble opens;
 * the gap then doubles to a 10s ceiling. ~20 posts for a 3-minute turn
 * instead of ~180.
 */
export function nextTrailDelayMs(postsSoFar: number): number {
	return Math.min(1_000 * 2 ** postsSoFar, 10_000);
}

let turn: TurnState | null = null;
let systemNoticeTurnPending = false;
let systemNoticeRunActive = false;
let nextTurnRevision = 1;
const pendingTerminalPosts = new Set<Promise<void>>();
const commandTurnBindings = new CommandTurnBindings();
let lastCtx: ExtensionContext | null = null;
const TRAIL_INTERVAL_MS = 1_000;

/**
 * Create the RUN-scoped turn state, once (item cc9e8c43). pi fires turn_start
 * once per LLM round — "repeats while LLM calls tools" — so creating state
 * there threw away every earlier round: that was the double-bubble root
 * cause (suppression marks died with each round's fresh tracker) AND the
 * reason preserved trails held only the final round. The state is born on
 * agent_start (or the first attached turn_start after a mid-run attach) and
 * lives until agent_settled — never recreated per round.
 */
/**
 * Connection-scoped outstanding auto-wake background tasks (759f2818, owner
 * direction 2026-09-17 PM). Presence — and ONLY presence — follows this set:
 * Working persists while owned bg work is outstanding and clears when the
 * last task resolves. Speech and turn-closing never consult it. Module scope
 * because it must survive per-segment tracker replacement across settles and
 * completion wakes (each new TurnTracker receives this same set).
 */
const pendingBackgroundTaskIds = new Set<string>();

/**
 * The command turn currently open server-side, if any (759f2818, live repro
 * in session ea7704f4 20:04–20:08). A settle with complete_turn:false parks
 * the command turn open; a completion-wake turn is born with NO command ids,
 * and an unbound post while a command turn is parked is fenced server-side as
 * stale_generation and silently dropped — the wake report vanished today.
 * Wake turns therefore ADOPT this identity (they are the command's own work
 * continuing), and it clears when the turn genuinely closes: a successful
 * complete_turn:true post, a reportComplete for it, or any authority
 * rotation. A stale adoption that still fences fails explicitly; it must never
 * shed its source identity to bypass the server fence.
 */
let activeCommandTurnIdentity: { turnId: string; commandMessageId: string } | null = null;

/** A completion-wake segment with no ids of its own rides the parked command
 *  turn it is continuing. Never for interaction runs (exact identity) or
 *  mid-owner-turn injections (the turn is already bound). */
function adoptParkedCommandIdentity(t: { commandTurnId?: string; commandMessageId?: string; interaction?: unknown } | null, kind: string | null): void {
	if (!t || t.interaction || kind !== "harness") return;
	if (t.commandTurnId || t.commandMessageId) return;
	if (!activeCommandTurnIdentity) return;
	t.commandTurnId = activeCommandTurnIdentity.turnId;
	t.commandMessageId = activeCommandTurnIdentity.commandMessageId;
	debug("wake adopted command turn");
}

function noteCommandTurnClosed(turnId: string | undefined): void {
	if (turnId && activeCommandTurnIdentity?.turnId === turnId) {
		activeCommandTurnIdentity = null;
	}
}

function ensureTurn(): void {
	if (turn) return;
	if (!getBond()?.sessionId) { debug("ensureTurn: not attached"); return; }
	const revision = nextTurnRevision++;
	const receiptBatch = new DirectedQuestionReceiptBatch();
	receiptBatch.reset(revision);
	turn = { revision, tracker: new TurnTracker(pendingBackgroundTaskIds), trail: new TrailBuilder(), completionNeutral: false, receiptBatch, trailPostFence: new TrailPostFence(), trailDelivery: new TrailDeliveryState(), canPost: capturePostAuthority(), interval: null, posts: 0, lastPostAt: 0 };
	debug("ensureTurn: tracking (run-scoped)");
	turn.interval = setInterval(trailTick, TRAIL_INTERVAL_MS);
	// Don't hold the process open for the trail timer in headless runs.
	if (typeof turn.interval.unref === "function") turn.interval.unref();
}

const assistantSpeechQueue = new AssistantSpeechQueue();

/** Consumed input is known at context, unlike turn_start (which precedes user events). */
function prepareAssistantSpeech(t: TurnState): Promise<void> {
	t.speechManaged = true; // Failure must never fall back to legacy normalization/finalization.
	const source = new AssistantSpeechSource();
	const active = pump;
	const bond = getBond();
	const connectionId = bond?.connectionId;
	const sessionId = bond?.sessionId;
	const attachedAt = bond?.attachedAt;
	const attachmentId = bond?.speechAttachmentId;
	const capability = bond?.connectionCapability;
	const generation = active?.generation;
	const current = () => Boolean(active && pump === active && active.generation === generation && !active.stop &&
		getBond()?.connectionId === connectionId && getBond()?.sessionId === sessionId &&
		getBond()?.attachedAt === attachedAt && getBond()?.speechAttachmentId === attachmentId && getBond()?.connectionCapability === capability);
	const firstScope = !t.speechScopeCaptured;
	t.speechScopeCaptured = true;
	const completeCommandIdentity = Boolean(t.commandTurnId) === Boolean(t.commandMessageId);
	const missingInteractionIdentity = t.occupancy?.kind === "interaction" && !t.interaction;
	if (firstScope && active && connectionId && sessionId && attachedAt && attachmentId && capability && !t.completionNeutral && completeCommandIdentity && !missingInteractionIdentity) {
		const interaction = interactionIdentity(t.interaction);
		const args = Object.freeze({ connection_id: connectionId, expected_session_id: sessionId, expected_attached_at: attachedAt, expected_attachment_id: attachmentId,
			...(interaction ? exactInteractionContinuationArgs(interaction) : t.commandTurnId && t.commandMessageId
				? { command_turn_id: t.commandTurnId, command_message_id: t.commandMessageId }
				: { local_turn: true }),
		});
		// Freeze all authority before resolveToken/network work. The promise is cached
		// for this consumed input, not rerun at each provider round or on failure.
		const ready = (async () => {
			try {
				const resolved = await resolveToken();
				if (!resolved || !current()) return null;
				const raw = await callDevspec(resolved.token, "report_pickup", { ...args, speech_scope: true }, {
					lane: "pump", retry: "never", connectionCapability: capability,
					beforeSend: () => { if (!current()) throw new DevspecToolError("Speech scope changed."); },
				});
				const result = unwrapMcpResult(raw);
				const details = result.details as Record<string, unknown> | undefined;
				if (!current() || result.isError || !details || typeof details.attempt_id !== "string" ||
					details.expected_session_id !== sessionId || details.expected_attached_at !== attachedAt || details.expected_attachment_id !== attachmentId) return null;
				return Object.freeze({ args: Object.freeze({ ...args, attempt_id: details.attempt_id }), token: resolved.token });
			} catch { return null; }
		})();
		t.speechBinding = Object.freeze({ args, current, capability, ready });
	}
	t.assistantSpeech = { source, binding: t.speechBinding, model: replyModelArgs() };
	return (t.speechBinding?.ready ?? Promise.resolve(null)).then(() => undefined);
}

/** Actual assistant messages only; journals contain no cap/claim/token and are not a replay outbox. */
function deliverAssistantSpeech(t: TurnState, message: unknown, append: (type: string, data: unknown) => void): void {
	const captured = t.assistantSpeech;
	const record = captured?.source.finalize(message);
	if (!record) return;
	const binding = captured?.binding;
	append("devspec-assistant-speech", { ...record, connectionId: binding?.args.connection_id,
		expectedSessionId: binding?.args.expected_session_id, expectedAttachedAt: binding?.args.expected_attached_at, expectedAttachmentId: binding?.args.expected_attachment_id,
		commandTurnId: binding?.args.command_turn_id, commandMessageId: binding?.args.command_message_id,
		interactionEventId: binding?.args.interaction_event_id ?? binding?.args.question_dismissal_event_id });
	trackTerminalPost(assistantSpeechQueue.enqueue(async () => {
		let stored = false;
		let attemptId: unknown;
		try {
			const ready = await binding?.ready;
			const scope = ready?.args;
			attemptId = scope?.attempt_id;
			if (scope && binding?.current() && assistantSpeechWithinBudget(record.text)) {
				if (ready && binding.current()) {
					const raw = await callDevspec(ready.token, "post_session_message", {
						...scope, assistant_source_id: record.assistantSourceId, message: record.text,
						phase: "answer", complete_turn: false, ...captured!.model,
					}, { lane: "pump", retry: "never", connectionCapability: binding.capability,
						beforeSend: () => { if (!binding.current()) throw new DevspecToolError("Speech scope changed."); } });
					const receipt = parsePostSessionReceipt(raw, { connectionId: String(scope.connection_id), sessionId: String(scope.expected_session_id), phase: "answer", assistantSourceId: record.assistantSourceId });
					stored = receipt.status === "stored" || receipt.status === "idempotently_stored";
				}
			}
		} catch { /* Exact raw text and source remain in JSONL; never relabel or replay. */ }
		append("devspec-assistant-speech-receipt", { assistantSourceId: record.assistantSourceId, attemptId, stored });
		if (!stored) {
			const warning = "DevSpec: assistant speech storage not confirmed; original text retained in Pi session. No automatic replay.";
			if (safeHasUI(lastCtx)) notify(lastCtx, warning, "warning");
			else console.error(warning);
		}
	}));
}

// Per-turn telemetry (item 1906e21f): mechanical, zero-token. Accumulates from
// pi's own message_end usage; the report rides the settle answer post (when
// attached) AND the idle heartbeat (always, so sessionless agents show too).
const telemetry = new TelemetryCollector();
/** Last settled usage plus runtime identity. Runtime-only refreshes preserve usage. */
let latestAgentStats: AgentStatsReport | null = null;
let runtimeStampTimer: ReturnType<typeof setTimeout> | null = null;

function runtimeAgentStats(ctx: ExtensionContext | null = lastCtx): AgentStatsReport {
	const model = ctx?.model;
	return refreshAgentStatsReport({
		previous: latestAgentStats,
		model: model ?? null,
		thinkingLevel: ctx?.thinkingLevel ?? null,
		supportedThinkingLevels: model ? getSupportedThinkingLevels(model) : undefined,
		context: ctx?.getContextUsage?.() ?? null,
	});
}

/** Coalesce model_select + thinking clamp into one immediate mechanical stamp. */
function scheduleRuntimeStamp(ctx: ExtensionContext): void {
	lastCtx = ctx;
	if (!pump) return;
	const completionNeutralAtSchedule = systemNoticeRunActive || systemNoticeTurnPending;
	if (runtimeStampTimer) clearTimeout(runtimeStampTimer);
	runtimeStampTimer = setTimeout(() => {
		runtimeStampTimer = null;
		const active = pump;
		if (!active || active.stop) return;
		const stats = runtimeAgentStats(lastCtx);
		latestAgentStats = stats;
		if (!completionNeutralAtSchedule && !systemNoticeRunActive) void beatBusy(active.busy, stats);
	}, 0);
	if (typeof runtimeStampTimer.unref === "function") runtimeStampTimer.unref();
}

/** Settle the turn's usage into a wire report from the current context. */
function settleTelemetry(): AgentStatsReport {
	const settled = telemetry.settleTurn();
	const ctx = lastCtx;
	const model = ctx?.model;
	const contextBudget = takeContextBudgetReport();
	latestAgentStats = buildAgentStatsReport({
		turn: settled.turn,
		session: settled.session,
		model: model ?? null,
		thinkingLevel: ctx?.thinkingLevel ?? null,
		supportedThinkingLevels: model ? getSupportedThinkingLevels(model) : undefined,
		context: ctx?.getContextUsage?.() ?? null,
		contextBudget,
	});
	debug("context budget", {
		staticChars: contextBudget.static.systemPromptChars + contextBudget.static.activeToolDefinitionChars + contextBudget.static.contextFileChars + contextBudget.static.skillChars,
		injectedChars: contextBudget.injected.totalChars,
		resultCalls: contextBudget.toolResults.calls,
		resultChars: contextBudget.toolResults.chars,
	});
	return latestAgentStats;
}

/**
 * The `model` argument on `post_session_message`, or nothing.
 *
 * Distinct from the model inside `agent_stats`. That one is runtime telemetry —
 * what the agent is configured with right now. This one becomes the message's
 * `dispatch_model`, which is what the transcript renders as VIA …, and it is
 * about the row rather than the agent.
 *
 * Pi already had the value and never sent it here: over fourteen days to
 * 2026-09-07, 0 of 824 Pi messages carried `dispatch_model` while 15 of 37
 * OpenCode messages did (devspec:3def43ba). Extension-mechanical, so it costs
 * the model nothing and cannot be forgotten — which matters, because the
 * argument is deliberately optional and Claude Code's agents, who have to
 * remember it themselves, managed 6%.
 *
 * Prefer the settled report: that is the model that actually produced this turn.
 * Fall back to live context for posts that carry no report. Both halves must be
 * non-empty — the report writes "" for a field it could not resolve, and a blank
 * provider or id is worse than no stamp.
 */
function replyModelArgs(agentStats?: AgentStatsReport): Record<string, unknown> {
	const model = agentStats?.model ?? lastCtx?.model ?? null;
	const providerID = model?.provider?.trim();
	const modelID = model?.id?.trim();
	if (!providerID || !modelID) return {};
	return { model: { providerID, modelID } };
}

/** Bind before any await, including deferred segment/fence work. */
function capturePostAuthority(): () => boolean {
	const active = pump;
	const bond = getBond();
	const connectionId = bond?.connectionId;
	const sessionId = bond?.sessionId;
	const generation = active?.generation;
	return () => Boolean(active && pump === active && active.generation === generation &&
		active.bond.connectionId === connectionId && active.bond.sessionId === sessionId &&
		getBond()?.connectionId === connectionId && getBond()?.sessionId === sessionId &&
		(!active.stop || active.closing));
}

async function postToSession(message: string, opts: { phase?: string; completeTurn?: boolean; turnKind?: string; commandTurnId?: string; commandMessageId?: string; commandTurnUnbound?: boolean; localTurn?: boolean; interaction?: ExactInteractionContinuationIdentity; workTrail?: string; trailEvents?: unknown; isCurrent?: () => boolean; agentStats?: AgentStatsReport } = {}): Promise<boolean> {
	const active = pump;
	const bond = getBond();
	const ctx = lastCtx;
	const current = capturePostAuthority();
	const failure = (status: "skipped" | "rejected" | "malformed" | "unknown"): false => {
		// No raw server/transport error, prompt, token, or thinking in diagnostics.
		debug("post delivery failed", { skipped: status === "skipped", rejected: status === "rejected", malformed: status === "malformed", unknown: status === "unknown" });
		const warning = `DevSpec remote: ${opts.turnKind === "local_prompt" ? "local prompt" : opts.phase === "trail" ? "trail" : "answer"} delivery ${status}; storage not confirmed. Not replaying automatically; check the room before resending.`;
		if (safeHasUI(ctx)) notify(ctx, warning, "warning");
		else console.error(warning);
		return false;
	};
	if (!active || !bond?.sessionId) return failure("skipped");
	const authority = { connectionId: bond.connectionId, sessionId: bond.sessionId };
	const parkedIdentity = activeCommandTurnIdentity;
	const isCurrent = () => current() && (opts.isCurrent?.() ?? true);
	let resolved;
	try { resolved = await resolveToken(); } catch { return failure("skipped"); }
	if (!resolved || !isCurrent()) return failure("skipped");
	const args = {
		connection_id: authority.connectionId,
		message,
		agent_name: AGENT_NAME,
		...(opts.commandTurnId ? { command_turn_id: opts.commandTurnId } : {}),
		...(opts.commandMessageId ? { command_message_id: opts.commandMessageId } : {}),
		...(opts.commandTurnUnbound || opts.interaction ? { command_turn_unbound: true } : {}),
		...(opts.localTurn ? { local_turn: true } : {}),
		...(opts.interaction ? exactInteractionContinuationArgs(opts.interaction) : {}),
		...(opts.phase ? { phase: opts.phase } : {}),
		...(opts.completeTurn === true ? { complete_turn: true } : opts.completeTurn === false ? { complete_turn: false } : {}),
		...(opts.turnKind ? { turn_kind: opts.turnKind } : {}),
		...(opts.workTrail ? { work_trail: opts.workTrail } : {}),
		...(opts.trailEvents && Array.isArray(opts.trailEvents) && opts.trailEvents.length > 0
			? { trail_events: opts.trailEvents }
			: {}),
		...(opts.agentStats ? { agent_stats: opts.agentStats } : {}),
		...replyModelArgs(opts.agentStats),
	};

	const laneOpts = {
		lane: "pump" as const,
		retry: "never" as const,
		beforeSend: () => { if (!isCurrent()) throw new DevspecToolError("Post authority changed before send."); },
		...(opts.interaction && active.bond.connectionCapability ? { connectionCapability: active.bond.connectionCapability } : {}),
	};
	try {
		const raw = await callDevspec(resolved.token, "post_session_message", args, laneOpts);
		const receipt = parsePostSessionReceipt(raw, {
			...authority, phase: opts.phase ?? "answer", turnKind: opts.turnKind,
		});
		if (receipt.status !== "stored" && receipt.status !== "idempotently_stored") return failure(receipt.status);
		debug("post stored", { idempotent: receipt.status === "idempotently_stored" });
		if (isCurrent() && activeCommandTurnIdentity === parkedIdentity) {
			if (opts.completeTurn === true) noteCommandTurnClosed(opts.commandTurnId);
		}
		return true;
	} catch (err) {
		// Response loss may follow a successful write. Never turn UNKNOWN into
		// NOT STORED, and never replay non-idempotent speech/local_prompt.
		return failure(err instanceof DevspecToolError ? "rejected" : "unknown");
	}
}

function trackTerminalPost(post: Promise<void>): void {
	pendingTerminalPosts.add(post);
	void post.then(
		() => pendingTerminalPosts.delete(post),
		() => pendingTerminalPosts.delete(post),
	);
}

function isCommandTurnUnbound(t: TurnState): boolean {
	// Every actionable remote command now has BOTH ids (extractor fails closed).
	// Interaction continuations are exact source-less generations too.
	return Boolean(t.interaction) || (!t.commandTurnId && !t.commandMessageId);
}

function interactionIdentity(run: ExactInteractionRun | undefined): ExactInteractionContinuationIdentity | undefined {
	return run?.identity;
}

function resetDirectedQuestionReceiptBatch(): void {
	if (!turn) return;
	turn.trailPostFence = turn.trailPostFence.rollover();
	turn.revision = nextTurnRevision++;
	turn.receiptBatch.reset(turn.revision);
}

function trailTick(): void {
	if (!turn || !remoteRunActivityPolicy(turn.completionNeutral).reportTranscript) return;
	if (turn.receiptBatch.deferTrail(turn.revision)) return;
	const now = Date.now();
	if (turn.interaction && now - (turn.lastInteractionKeepaliveAt ?? 0) >= 60_000) {
		turn.lastInteractionKeepaliveAt = now;
		void keepInteractionContinuationAlive(turn.interaction);
	}
	if (!turn.trailDelivery.dirty || turn.trailDelivery.blocked || now - turn.lastPostAt < nextTrailDelayMs(turn.posts)) return;
	const activityEvents = turn.trail.events();
	// Assistant speech belongs to the transcript. A text-only progress/final
	// message must not open an empty Activity record containing a duplicate.
	if (activityEvents.length === 0) return;
	const rendered = turn.trail.render(undefined, false);
	if (!rendered) return;
	turn.posts += 1;
	turn.lastPostAt = now;
	const postingTurn = turn;
	const snapshot = postingTurn.trailDelivery.begin();
	if (snapshot === null) return;
	postingTurn.trailPostFence.track(postToSession(rendered, { phase: "trail", isCurrent: postingTurn.canPost, commandTurnId: postingTurn.commandTurnId, commandMessageId: postingTurn.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(postingTurn), localTurn: isCommandTurnUnbound(postingTurn) && !postingTurn.interaction, interaction: interactionIdentity(postingTurn.interaction), trailEvents: activityEvents }).then(stored => postingTurn.trailDelivery.finish(snapshot, stored)));
}

/**
 * Explicitly close this connection's activity attempt (item 2c20337a). The
 * busy:false heartbeat is deliberately discarded server-side while the
 * attempt's lease is fresh (anti-flap, 8792f549), so a turn that ends WITHOUT
 * a complete_turn post — aborted, empty, or the answer post failed — would
 * otherwise strand the Working indicator until lease expiry. report_complete
 * is the explicit channel; idempotent when the attempt already closed.
 */
async function reportComplete(reason: string, commandTurnId?: string, commandMessageId?: string, commandTurnUnbound = false, interaction?: ExactInteractionContinuationIdentity, prePersistenceFailure = false): Promise<boolean> {
	const active = pump;
	if (!active || (active.stop && !active.closing)) return false;
	const authority = capturePumpAuthority({ generation: active.generation, connectionId: active.bond.connectionId });
	const resolved = await resolveToken();
	if (!resolved) return false;
	if (pump !== active || !isPumpAuthorityCurrent(authority, {
		generation: active.generation,
		connectionId: active.bond.connectionId,
	}) || (active.stop && !active.closing)) return false;
	try {
		await callDevspec(resolved.token, "report_complete", {
			connection_id: authority.connectionId,
			reason,
			...(commandTurnId ? { command_turn_id: commandTurnId } : {}),
			...(commandMessageId ? { command_message_id: commandMessageId } : {}),
			...(commandTurnUnbound && !interaction ? { command_turn_unbound: true } : {}),
			...(interaction ? exactInteractionContinuationArgs(interaction) : {}),
			...(prePersistenceFailure ? { interaction_pre_persistence_failure: true } : {}),
		}, { timeoutMs: 10_000, lane: "pump", ...(interaction && active.bond.connectionCapability ? { connectionCapability: active.bond.connectionCapability } : {}) });
		// The command is closed: drop any never-taken binding strays for it so a
		// later terminal input with identical text cannot inherit them (6f4136d8).
		commandTurnBindings.forgetByCommand(commandTurnId, commandMessageId);
		// reportComplete closes the command turn server-side — forget the parked
		// identity so later wakes post unbound instead of fencing (759f2818).
		noteCommandTurnClosed(commandTurnId);
		return true;
	} catch {
		/* lease expiry + disconnect remain backstops for best-effort callers */
		return false;
	}
}

/** Start the exact event/claim-bound activity before Pi can persist or execute it. */
async function startInteractionContinuation(
	active: PumpState,
	event: DirectedQuestionEventV1,
): Promise<ReturnType<typeof parseInteractionContinuationStartResult>> {
	if (pump !== active || active.stop) throw new Error("interaction pump authority changed");
	const authority = capturePumpAuthority({ generation: active.generation, connectionId: active.bond.connectionId });
	const resolved = await resolveToken();
	if (!resolved) throw new Error("interaction continuation requires authentication");
	const raw = await callDevspec(resolved.token, "report_pickup", {
		connection_id: authority.connectionId,
		...interactionContinuationStartArgs(event),
	}, { timeoutMs: 10_000, lane: "pump", connectionCapability: active.bond.connectionCapability });
	const { details, isError, text } = unwrapMcpResult(raw);
	if (isError) throw new Error(text || "exact interaction report_pickup failed");
	return parseInteractionContinuationStartResult(details);
}

function interactionRunIsLive(run: ExactInteractionRun): boolean {
	return run.application !== "released";
}

async function keepInteractionContinuationAlive(run: ExactInteractionRun): Promise<boolean> {
	if (!interactionRunIsLive(run) || !interactionAuthorityCurrent(run.authority)) return false;
	const resolved = await resolveToken();
	if (!resolved || !interactionRunIsLive(run) || !interactionAuthorityCurrent(run.authority)) return false;
	try {
		await callDevspec(resolved.token, "report_keepalive", {
			connection_id: run.authority.connectionId,
			...exactInteractionContinuationArgs(run.identity),
		}, { timeoutMs: 10_000, lane: "pump", connectionCapability: run.authority.connectionCapability });
		return interactionRunIsLive(run) && interactionAuthorityCurrent(run.authority);
	} catch {
		return false;
	}
}

async function releaseInteractionBeforePersistence(run: ExactInteractionRun, reason: string): Promise<boolean> {
	if (run.application !== "starting") return false;
	const resolved = await resolveToken();
	if (!resolved) {
		retainInteractionReleaseRetry(run);
		return false;
	}
	try {
		await callDevspec(resolved.token, "report_complete", {
			connection_id: run.authority.connectionId,
			reason,
			...exactInteractionContinuationArgs(run.identity),
			interaction_pre_persistence_failure: true,
		}, {
			timeoutMs: 10_000,
			lane: "pump",
			connectionCapability: run.authority.connectionCapability,
		});
		run.application = "released";
		run.active.pendingInteractionReleases.delete(run.identity.eventId);
		armInteractionRetryWake(run.active);
		interactionRunsByEvent.delete(run.details.event.event_id);
		if (startingInteractionRun === run) startingInteractionRun = null;
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already_terminal|already_applied|already_released|stale_claim|source_session_(?:unavailable|changed)/i.test(message)) {
			run.application = "released";
			run.active.pendingInteractionReleases.delete(run.identity.eventId);
			interactionRunsByEvent.delete(run.identity.eventId);
			return true;
		}
		retainInteractionReleaseRetry(run);
		return false;
	}
}

/**
 * Post a captured segment's answer. The SEGMENT is the delivery unit
 * (b1fb756a): called at run end (settleTurn) AND at a mid-run user-message
 * boundary (splitTurnAtBoundary). Returns true when a final answer post with
 * complete_turn landed (that post closes the activity attempt itself).
 * completeTurn defaults true (run end / new user message). A text-only
 * mid-run close (f0df6c3e) passes false: the bubble is finished, work is not.
 */
async function postSegmentAnswer(t: TurnState, agentStats: AgentStatsReport | null, why: string, completeTurn = true): Promise<boolean> {
	if (!remoteRunActivityPolicy(t.completionNeutral).reportTranscript) return false;
	// The final render rides the answer post (item 9b7455df): the server
	// REPLACES the fold-merged accumulation with this canonical final render —
	// every tool closed, the whole segment's thinking — so the preserved
	// 'Show work' is exact, and one fewer post is spent. It renders at the
	// larger final cap: the live-tick 12k window would discard earlier rounds
	// the fold had preserved. A segment with no answer still flushes its
	// trail the old way so the work is visible.
	const finalTrail = t.trail.render(FINAL_TRAIL_CHARS, false);
	const finalEvents = t.trail.events();
	const activityTrail = finalEvents.length > 0 ? finalTrail : undefined;
	const plan = t.speechManaged ? { kind: "none" as const } : planSettle(t.tracker, true);
	debug("settle segment", { completeTurn, planFinal: plan.kind === "final", planMirror: plan.kind === "local_mirror", trailChars: finalTrail.length, answerChars: t.tracker.lastAssistantText.length, pendingBg: t.tracker.pendingBackgroundTasks().length, harness: t.tracker.userKind === "harness", bound: Boolean(t.commandTurnId || t.commandMessageId) });
	// Context-injection / leftover harness segments never leave room content
	// (60cf5f00). A background-completion wake MAY speak (its own bubble) and
	// flushes its trail like any segment.
	if (t.tracker.userKind === "harness" && !t.tracker.harnessSpeechAllowed) return false;
	if (plan.kind === "final") {
		// phase 'answer' closes the trail bubble (preserved as "Show work").
		const localTurn = isCommandTurnUnbound(t) && !t.interaction;
		return await postToSession(plan.message, { phase: "answer", completeTurn, isCurrent: t.canPost, commandTurnId: t.commandTurnId, commandMessageId: t.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(t), localTurn, interaction: interactionIdentity(t.interaction), workTrail: activityTrail, trailEvents: finalEvents, agentStats: agentStats ?? undefined });
	} else if (plan.kind === "local_mirror") {
		const promptStored = await postToSession(plan.prompt, { turnKind: "local_prompt", localTurn: true, isCurrent: t.canPost });
		const answerStored = await postToSession(plan.answer, { phase: "answer", completeTurn, isCurrent: t.canPost, commandTurnId: t.commandTurnId, commandMessageId: t.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(t), localTurn: true, interaction: interactionIdentity(t.interaction), workTrail: activityTrail, trailEvents: finalEvents, agentStats: agentStats ?? undefined });
		return promptStored && answerStored;
	}
	if (t.trailDelivery.dirty && !t.trailDelivery.blocked && activityTrail && !t.receiptBatch.suppressEmptyFallback(t.revision)) {
		const snapshot = t.trailDelivery.begin();
		if (snapshot === null) return false;
		const stored = await postToSession(activityTrail, { phase: "trail", isCurrent: t.canPost, commandTurnId: t.commandTurnId, commandMessageId: t.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(t), localTurn: isCommandTurnUnbound(t) && !t.interaction, interaction: interactionIdentity(t.interaction), trailEvents: finalEvents });
		t.trailDelivery.finish(snapshot, stored);
	}
	return false;
}

/**
 * Settle the run's open segment at agent_settled. Returns true when a final
 * answer post with complete_turn landed (that post closes the activity
 * attempt itself); false means the run ended silently (aborted/empty/failed
 * post) and the caller must close the attempt explicitly via reportComplete.
 */
async function settleTurn(agentStats: AgentStatsReport | null, completeTurn = true): Promise<boolean> {
	const t = turn;
	if (!t) { debug("settleTurn: no turn state"); return false; }
	// No pause (759f2818, owner direction 2026-09-17): the run ending is the
	// truth. An unposted answer always posts; a process-only/silent settle
	// flushes its trail and (when no background work is outstanding)
	// reportComplete closes the attempt, sweeping any open trail row. While
	// owned background work IS outstanding the bubble still posts — just with
	// complete_turn:false, so the Working attempt honestly persists until the
	// last completion wake's settle closes it. Presence is the only axis the
	// pending set feeds; speech never consults it.
	turn = null;
	if (t.interval) clearInterval(t.interval);
	await t.trailPostFence.drain();
	const bgPending = pendingBackgroundTaskIds.size > 0;
	debug("settleTurn: settle", { answerChars: t.tracker.lastAssistantText.length, pendingBg: t.tracker.pendingBackgroundTasks().length, harness: t.tracker.userKind === "harness" });
	return await postSegmentAnswer(t, agentStats, "run_end", completeTurn && !bgPending);
}

/**
 * A user message arriving MID-RUN (owner followUp, terminal typing, an
 * injected notification) is a delivery boundary (item b1fb756a): the text
 * accumulated so far is the answer to the PREVIOUS message, and it must
 * close as its own bubble — not wait for run end and be replaced by whatever
 * the run says last (the 27-minute one-bubble incident, session d8883a49).
 * The split is mechanical: swap the state synchronously so subsequent events
 * land on the fresh segment, then close the captured one asynchronously.
 */
function splitTurnAtBoundary(why = "boundary", completeTurn = true): void {
	const t = turn;
	if (!t) return;
	if (t.interval) clearInterval(t.interval);
	const interval = setInterval(trailTick, TRAIL_INTERVAL_MS);
	if (typeof interval.unref === "function") interval.unref();
	const next = new TurnTracker(pendingBackgroundTaskIds);
	if (t.tracker.userText && !t.completionNeutral) next.carryUser(t.tracker.userText, t.tracker);
	// A user-facing progress answer closes one transcript segment. Activity after
	// it belongs to the next segment; carrying the old builder duplicated the
	// entire prior activity beneath every later answer. Exact message identity
	// now keeps the two records stable without cumulative snapshots.
	const nextRevision = nextTurnRevision++;
	const receiptBatch = new DirectedQuestionReceiptBatch();
	receiptBatch.reset(nextRevision);
	const trailPostFence = new TrailPostFence();
	turn = {
		revision: nextRevision,
		tracker: next,
		trail: new TrailBuilder(),
		receiptBatch,
		trailPostFence,
		commandTurnId: t.commandTurnId,
		commandMessageId: t.commandMessageId,
		completionNeutral: t.completionNeutral,
		interaction: t.interaction,
		occupancy: t.occupancy,
		lastInteractionKeepaliveAt: t.lastInteractionKeepaliveAt,
		trailDelivery: new TrailDeliveryState(),
		canPost: t.canPost,
		posts: 0,
		lastPostAt: 0,
		interval,
	};
	debug("delivery boundary", { completeTurn });
	const previousPolicy = remoteRunActivityPolicy(t.completionNeutral);
	const boundaryPost = (async () => {
		await t.trailPostFence.drain();
		const posted = await postSegmentAnswer(t, null, why, completeTurn);
		if (completeTurn && !posted && previousPolicy.reportCompletion && t.canPost()) {
			await reportComplete(why, t.commandTurnId, t.commandMessageId, isCommandTurnUnbound(t), interactionIdentity(t.interaction));
		}
	})();
	// A create in the fresh segment must wait for this predecessor projection too:
	// it can still finalize/clear the same connection pointer.
	trailPostFence.track(boundaryPost);
	trackTerminalPost(boundaryPost);
}

/**
 * Assert busy presence IMMEDIATELY on turn transitions. The busy flag also
 * rides each poll, but a held long-poll can be 25s old — without this, the
 * Working… indicator lags the real turn by up to a full poll cycle in both
 * directions (observed dogfooding: dots slow to appear, UI stuck on working
 * after the answer). Mechanical heartbeats are contract-sanctioned presence,
 * not prose. Best-effort: the pump remains the presence authority.
 */
async function beatBusy(busy: boolean, agentStats?: AgentStatsReport | null): Promise<void> {
	const active = pump;
	if (!active || active.stop || systemNoticeRunActive) return;
	const interaction = activeInteractionRun(active);
	if (interaction) {
		if (busy) await keepInteractionContinuationAlive(interaction);
		return;
	}
	const resolved = await resolveToken();
	if (!resolved) return;
	try {
		await callDevspec(resolved.token, "heartbeat_connection", {
			connection_id: active.bond.connectionId,
			status: "live",
			busy,
			agent_name: AGENT_NAME,
			...(agentStats ? { agent_stats: agentStats } : {}),
		}, { lane: "pump" });
	} catch {
		/* presence is best-effort — the next poll re-asserts */
	}
}

function notify(ctx: ExtensionContext | null, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (!ctx) return;
	withLiveUi(ctx, () => ctx.ui.notify(message, level));
}

/** Deliver only from an idle, current generation. Busy intake remains memory-only. */
function deliverQueuedSystemNotices(active: PumpState, ctx: ExtensionContext): boolean {
	if (pump !== active || active.stop || !shouldDeliverSystemNotices({ ctxIdle: ctx.isIdle(), pumpBusy: active.busy })) return false;
	const notices = queuedSystemNotices(active.systemNoticeKey);
	if (notices.length === 0) return false;
	const ids = notices.map((notice) => notice.notice_id);
	pi_systemNoticeSend(formatSystemNoticeMessage(notices), { notices });
	if (!commitSystemNoticeDelivery(active.systemNoticeKey, ids)) {
		throw new Error("System notice generation changed during Pi delivery.");
	}
	// Capacity is available again. Wake the main pump immediately so notice
	// negotiation resumes without waiting for the SSE safety interval.
	signalWake(active);
	return true;
}

async function ackControl(
	token: string,
	connectionId: string,
	controlId: string,
	catalog?: ModelCatalogSnapshot,
): Promise<void> {
	await callDevspec(token, "poll_connection", {
		connection_id: connectionId,
		ingress_version: 1,
		delegated_scope_version: 1,
		active_plan_projection_version: 1,
		control_ack: controlId,
		wait_ms: 0,
		...(catalog ? { model_catalog: catalog } : {}),
	}, { timeoutMs: 10_000, lane: "pump" });
}

function setRemoteStatus(ctx: ExtensionContext | null): void {
	syncBondIntoStatus(getBond());
	paintStatus(ctx);
}

async function withMaterialisedAttachments(
	cmd: OwnerCommand,
	connectionId: string,
	budget: AttachmentHydrationBudget,
): Promise<{ command: OwnerCommand; materialised: MaterialisedAttachment[] }> {
	if (!cmd.attachments || cmd.attachments.length === 0) return { command: cmd, materialised: [] };
	const token = (await resolveToken())?.token;
	if (!token) throw new Error("attachment hydration requires an authenticated connection");
	const materialised = await materialiseAttachments(
		cmd.attachments,
		{
			token,
			connectionId,
			getResource: (t, args) => callDevspec(t, "get_resource", args, { lane: "pump" }),
		},
		cmd.id,
		budget,
	);
	requireMaterialisedAttachments(materialised, cmd.attachments.length);
	return { command: { ...cmd, attachmentNotes: formatAttachmentNotes(materialised) }, materialised };
}

function ownerBundleSubset(
	bundle: OwnerCommandBundle,
	commands: readonly OwnerCommand[],
): OwnerCommandBundle {
	if (commands.length === 0) throw new Error("canonical command subset cannot be empty");
	const primaryCommand = commands.find((command) => command.delivery.is_primary) ?? commands[0]!;
	return {
		...bundle,
		commands: [...commands],
		primaryCommand,
		commandTurnId: commands[0]!.commandTurnId,
	};
}

async function hydrateOwnerBundle(
	bundle: OwnerCommandBundle,
	connectionId: string,
): Promise<{ bundle: OwnerCommandBundle; materialised: MaterialisedAttachment[] }> {
	const commands: OwnerCommand[] = [];
	const materialised: MaterialisedAttachment[] = [];
	const budget = createAttachmentHydrationBudget(bundle.commands.map((command) => command.attachments ?? []));
	try {
		for (const command of bundle.commands) {
			const hydrated = await withMaterialisedAttachments(command, connectionId, budget);
			commands.push(hydrated.command);
			materialised.push(...hydrated.materialised);
		}
		const primaryCommand = commands.find((command) => command.id === bundle.primaryCommand.id);
		if (!primaryCommand) throw new Error("canonical primary command was lost during hydration");
		return { bundle: { ...bundle, commands, primaryCommand }, materialised };
	} catch (error) {
		await cleanupMaterialisedAttachments(materialised);
		throw error;
	}
}

function untitledAttached(): boolean {
	const bond = getBond();
	return Boolean(bond?.sessionId && !isRealSessionTitle(bond.sessionTitle));
}

/** Titles are job-generated after the first substantial message. After an
 *  owner delivery or settle, retry once shortly — not a hot poll. */
function scheduleTitleRefresh(sessionId: string, delayMs = 8_000): void {
	const active = pump;
	if (!active || active.bond.sessionId !== sessionId) return;
	if (isRealSessionTitle(active.bond.sessionTitle)) return;
	const timer = setTimeout(() => {
		const current = pump;
		if (!current || current.bond.sessionId !== sessionId) return;
		if (isRealSessionTitle(current.bond.sessionTitle)) return;
		current.lastSessionEnrichAt = Date.now();
		void enrichBondWithSession(sessionId);
	}, delayMs);
	if (typeof timer.unref === "function") timer.unref();
}

async function stopPump(ctx: ExtensionContext | null, reason: "local_stop" | "owner_gone" | "auth", serverAlreadyEnded = false): Promise<void> {
	const active = pump;
	if (!active) return;
	const stoppingTurn = turn;
	const stoppingTrailFence = stoppingTurn?.trailPostFence;
	active.stop = true;
	if (active.interactionRetryTimer) clearTimeout(active.interactionRetryTimer);
	active.interactionRetryTimer = undefined;
	const starting = startingInteractionRun?.active === active ? startingInteractionRun : null;
	if (starting?.application === "starting") {
		await releaseInteractionBeforePersistence(starting, "interaction_pump_stopped_before_persistence");
	}
	startingInteractionRun = null;
	for (const [eventId, run] of interactionRunsByEvent) {
		if (run.active === active) interactionRunsByEvent.delete(eventId);
	}
	active.pendingInteractionStarts.clear();
	active.pendingInteractionReleases.clear();
	systemNoticeTurnPending = false;
	systemNoticeRunActive = false;
	revokeSystemNoticeState(active.systemNoticeKey);
	active.automationQueue.invalidate();
	for (const timer of active.automationRetryTimers.values()) clearTimeout(timer);
	active.automationRetryTimers.clear();
	active.pushGenerationFence.invalidate();
	active.pushAbort?.abort();
	if (active.pushReconnectTimer) {
		clearTimeout(active.pushReconnectTimer);
		active.pushReconnectTimer = undefined;
	}
	active.wakeGate.cancel();
	resetDirectedQuestionReceiptBatch();
	if (stoppingTrailFence) await stoppingTrailFence.drain();
	pump = null;
	commandTurnBindings.clear();
	pendingBackgroundTaskIds.clear();
	activeCommandTurnIdentity = null;
	setBond(null);
	pi_setPlanToolActive(false);
	pi_setQuestionToolActive(false);
	pi_setPollToolActive(false);
	setRemoteStatus(ctx);
	if (serverAlreadyEnded) return;
	const resolved = await resolveToken();
	if (!resolved) return;
	try {
		await callDevspec(resolved.token, "heartbeat_connection", {
			connection_id: active.bond.connectionId,
			status: "offline",
			end_reason: reason,
		}, { lane: "pump" });
	} catch {
		// Best-effort: the server idle-reaper cleans up regardless.
	}
}

/** Wake the pump's SSE waiter (if any). */
function signalWake(active: PumpState): void {
	// A generic SSE marker does not identify its lane. Remember every busy wake;
	// the idle boundary will replay one coalesced nudge so an interaction marker
	// consumed by a busy poll cannot wait for the 75s safety tick.
	active.idleBoundaryWake.noteWake(active.busy || active.runtimeOccupancy.isBusy());
	active.wakeGate.signal();
}

function nextInteractionRetryAt(active: PumpState): number | null {
	const due = [
		...[...active.pendingInteractionStarts.values()].map((item) => item.nextAt),
		...[...active.pendingInteractionReleases.values()].map((item) => item.nextAt),
	];
	return due.length === 0 ? null : Math.min(...due);
}

function armInteractionRetryWake(active: PumpState): void {
	if (active.interactionRetryTimer) clearTimeout(active.interactionRetryTimer);
	const nextAt = nextInteractionRetryAt(active);
	if (nextAt === null || active.stop || pump !== active) {
		active.interactionRetryTimer = undefined;
		return;
	}
	const delay = Math.max(0, nextAt - Date.now());
	active.interactionRetryTimer = setTimeout(() => {
		active.interactionRetryTimer = undefined;
		if (pump === active && !active.stop) signalWake(active);
	}, delay);
	if (typeof active.interactionRetryTimer.unref === "function") active.interactionRetryTimer.unref();
}

function retainInteractionStartRetry(active: PumpState, event: DirectedQuestionEventV1, localSessionId: string): void {
	const existing = active.pendingInteractionStarts.get(event.event_id);
	const attempts = (existing?.attempts ?? 0) + 1;
	active.pendingInteractionStarts.set(event.event_id, {
		event,
		generation: active.generation,
		localSessionId,
		attempts,
		nextAt: Date.now() + interactionRetryDelay(attempts - 1),
	});
	armInteractionRetryWake(active);
}

function retainInteractionReleaseRetry(run: ExactInteractionRun): void {
	const active = run.active;
	const existing = active.pendingInteractionReleases.get(run.identity.eventId);
	const attempts = (existing?.attempts ?? 0) + 1;
	active.pendingInteractionReleases.set(run.identity.eventId, {
		run,
		attempts,
		nextAt: Date.now() + interactionRetryDelay(attempts - 1),
	});
	armInteractionRetryWake(active);
}

/** Interaction awareness is dynamic, but remains on while a durable ACK is pending. */
function interactionEventsRelevant(active: PumpState): boolean {
	return Boolean(
		active.bond.connectionCapability &&
		(active.bond.sessionId || interactionJournal.hasPendingAck(active.bond.connectionId)),
	);
}

function activeInteractionRun(active: PumpState): ExactInteractionRun | undefined {
	return [...interactionRunsByEvent.values()].find((run) =>
		run.active === active && run.application !== "released");
}

/** Server attachment authority changed; the old exact workflow cannot retarget. */
function revokeInteractionForAttachmentChange(active: PumpState, ctx: ExtensionContext): boolean {
	const running = [...interactionRunsByEvent.values()].filter((run) => run.active === active);
	if (running.length === 0 && turn?.interaction?.active !== active &&
		active.pendingInteractionStarts.size === 0 && active.pendingInteractionReleases.size === 0) return false;
	ctx.abort();
	for (const confirmation of [...pendingInteractionConfirmations]) {
		if (confirmation.active !== active) continue;
		interactionDelivery.abandonMessage(confirmation.message);
		pendingInteractionConfirmations.delete(confirmation);
	}
	for (const run of running) {
		run.application = "released"; // server attachment transition seals/releases it
		interactionRunsByEvent.delete(run.details.event.event_id);
	}
	if (startingInteractionRun?.active === active) startingInteractionRun = null;
	if (turn?.interaction?.active === active) {
		turn.interaction = undefined;
		turn.lastInteractionKeepaliveAt = undefined;
		turn.completionNeutral = true;
	}
	active.pendingInteractionStarts.clear();
	active.pendingInteractionReleases.clear();
	armInteractionRetryWake(active);
	active.busy = false;
	return true;
}

function interactionApplicationDetails(
	active: PumpState,
	ctx: ExtensionContext,
	event: DirectedQuestionEventV1,
	attemptId?: string,
): InteractionEventApplicationDetails {
	return {
		version: 1,
		local_session_id: ctx.sessionManager.getSessionId(),
		connection_id: active.bond.connectionId,
		source_session_id: event.source_session_id,
		...(attemptId ? { attempt_id: attemptId } : {}),
		event,
	};
}

function readPersistedSessionEntries(sessionFile: string | undefined): SessionEntryLike[] | null {
	if (!sessionFile) return null;
	try {
		const entries: SessionEntryLike[] = [];
		for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const value = JSON.parse(line) as unknown;
			if (!value || typeof value !== "object" || Array.isArray(value)) return null;
			entries.push(value as SessionEntryLike);
		}
		return entries;
	} catch {
		return null;
	}
}

function readPersistedActiveBranchEntries(
	sessionManager: ExtensionContext["sessionManager"],
	expectedSessionFile = sessionManager.getSessionFile(),
): SessionEntryLike[] | null {
	// A session switch between scheduling and confirmation must not let the old
	// file prove application for the new active branch (or vice versa).
	if (sessionManager.getSessionFile() !== expectedSessionFile) return null;
	return persistedActiveBranchEntries(
		readPersistedSessionEntries(expectedSessionFile),
		sessionManager.getBranch() as SessionEntryLike[],
	);
}

function replaceInteractionJournal(journal: InteractionEventJournal): void {
	interactionJournal = journal;
	interactionDelivery.replaceJournal(journal);
}

function currentInteractionAuthority(active: PumpState | null = pump): InteractionEventDeliveryAuthority | null {
	if (!active || active.stop || !active.bond.connectionCapability || !active.bond.sessionId || !lastCtx) return null;
	return {
		generation: active.generation,
		connectionId: active.bond.connectionId,
		connectionCapability: active.bond.connectionCapability,
		sourceSessionId: active.bond.sessionId,
		localSessionId: lastCtx.sessionManager.getSessionId(),
	};
}

function interactionAuthorityCurrent(authority: InteractionEventDeliveryAuthority): boolean {
	return exactInteractionAuthorityMatches(authority, currentInteractionAuthority());
}

function interactionDeliveryPort(active: PumpState, run?: ExactInteractionRun): InteractionEventDeliveryPort {
	return {
		append: (state, details) => pi_appendInteractionEntry(state, details),
		send: (message, details) => {
			if (!run) throw new Error("exact interaction run is required before persistence");
			pi_sendInteractionContinuation(active, message, details, run);
		},
		wake: () => {
			if (pump === active && !active.stop) signalWake(active);
		},
	};
}

/**
 * Idle-only observation/application. ACK eligibility is granted later, from
 * the exact custom message's message_end path after a fresh JSONL disk read.
 */
async function applyInteractionEvent(
	active: PumpState,
	ctx: ExtensionContext,
	event: DirectedQuestionEventV1,
): Promise<boolean> {
	if (pump !== active || active.stop ||
		!active.bond.connectionCapability || !interactionEventMatchesWorkflow(event, {
			connectionId: active.bond.connectionId,
			sourceSessionId: active.bond.sessionId,
		})) return false;
	if (active.busy || active.runtimeOccupancy.isBusy() || !ctx.isIdle()) {
		debug("interaction apply deferred", { busy: active.busy, occupancyBusy: active.runtimeOccupancy.isBusy(), ctxIdle: ctx.isIdle() });
		retainInteractionStartRetry(active, event, ctx.sessionManager.getSessionId());
		return false;
	}
	const authority: InteractionEventDeliveryAuthority = {
		generation: active.generation,
		connectionId: active.bond.connectionId,
		connectionCapability: active.bond.connectionCapability,
		sourceSessionId: event.source_session_id,
		localSessionId: ctx.sessionManager.getSessionId(),
	};
	const observedDetails = interactionApplicationDetails(active, ctx, event);
	try {
		// Durable application from an earlier claim never executes twice. Rotate the
		// claim in the journal and make its exact ACK eligible without opening work.
		if (interactionJournal.isApplied(event.event_id)) {
			const result = interactionDelivery.stage({
				details: observedDetails,
				authority,
				idle: true,
				isAuthorityCurrent: interactionAuthorityCurrent,
				port: interactionDeliveryPort(active),
			});
			return result === "applied";
		}

		// Persist observation before the fallible exact start call. A timeout may
		// follow a committed server start; this claim must survive locally so the
		// same idempotent start can be retried promptly without waiting for lease.
		const observed = interactionJournal.observe(observedDetails);
		if (observed === "conflict") return false;
		pi_appendInteractionEntry("observed", observedDetails);
		const started = await startInteractionContinuation(active, event);
		active.pendingInteractionStarts.delete(event.event_id);
		armInteractionRetryWake(active);
		const startedSourceMatches = started.outcome !== "started" ||
			(started.sourceSessionId === event.source_session_id &&
				started.sourceSessionId === active.bond.sessionId);
		const authorityStillCurrent = startedSourceMatches && interactionAuthorityCurrent(authority)
			&& !active.busy && !active.runtimeOccupancy.isBusy() && ctx.isIdle();
		const startAction = interactionContinuationStartAction(started, authorityStillCurrent);
		if (startAction === "ignore") return true;
		if (startAction === "defer") {
			// Abort settle can close the owner attempt a beat after ctx.isIdle().
			// Keep the claimed event and retry rather than waiting for lease expiry.
			if (started.outcome === "blocked_by_activity") {
				retainInteractionStartRetry(active, event, authority.localSessionId);
			}
			return true;
		}
		if (started.outcome !== "started") return true;
		const identity: ExactInteractionContinuationIdentity = {
			attemptId: started.attemptId,
			eventId: event.event_id,
			...(event.kind === QUESTION_DISMISSAL_EVENT_KIND ? { questionId: event.question_id } : { responseId: event.response_id }),
			claimToken: event.claim_token,
		};
		const details = interactionApplicationDetails(active, ctx, event, started.attemptId) as InteractionEventApplicationDetails & { attempt_id: string };
		const run: ExactInteractionRun = { active, authority, details, identity, application: "starting" };
		// The await may have crossed rebond, reattach, local session switch, or a
		// new Pi run. Release exactly this pre-persistence claim before returning.
		if (startAction === "release") {
			await releaseInteractionBeforePersistence(run, "interaction_authority_changed_before_persistence");
			return false;
		}
		startingInteractionRun = run;
		interactionRunsByEvent.set(event.event_id, run);
		const result = interactionDelivery.stage({
			details,
			authority,
			idle: true,
			isAuthorityCurrent: interactionAuthorityCurrent,
			port: interactionDeliveryPort(active, run),
		});
		if (result !== "awaiting-persistence") {
			await releaseInteractionBeforePersistence(run, "interaction_not_persisted");
			return result === "applied";
		}
		return true;
	} catch (error) {
		const run = interactionRunsByEvent.get(event.event_id);
		if (run?.application === "starting") {
			await releaseInteractionBeforePersistence(run, "interaction_persistence_start_failed");
		} else if (interactionAuthorityCurrent(authority)) {
			// The server may have committed start before transport timeout. Retain
			// the exact claim and retry idempotently; never wait for event lease expiry.
			retainInteractionStartRetry(active, event, authority.localSessionId);
		}
		debug("interaction event application failed", { errorPresent: Boolean(error) });
		return true;
	}
}

async function drainInteractionRetries(active: PumpState, ctx: ExtensionContext): Promise<boolean> {
	let attempted = false;
	const now = Date.now();
	for (const [eventId, pending] of [...active.pendingInteractionReleases]) {
		if (pending.nextAt > now) continue;
		const { run } = pending;
		const authorityGone = pump !== active || active.stop || active.generation !== run.authority.generation ||
			active.bond.connectionId !== run.authority.connectionId ||
			active.bond.connectionCapability !== run.authority.connectionCapability;
		if (authorityGone) {
			active.pendingInteractionReleases.delete(eventId);
			run.application = "released";
			interactionRunsByEvent.delete(eventId);
			continue;
		}
		attempted = true;
		await releaseInteractionBeforePersistence(run, "interaction_release_retry");
	}
	for (const [eventId, pending] of [...active.pendingInteractionStarts]) {
		if (pending.nextAt > now) continue;
		const authorityGone = pump !== active || active.stop || active.generation !== pending.generation ||
			active.bond.connectionId !== pending.event.origin_connection_id ||
			active.bond.sessionId !== pending.event.source_session_id ||
			ctx.sessionManager.getSessionId() !== pending.localSessionId;
		if (authorityGone) {
			active.pendingInteractionStarts.delete(eventId);
			continue;
		}
		if (active.busy || active.runtimeOccupancy.isBusy() || !ctx.isIdle()) {
			pending.nextAt = Date.now() + 1_000;
			continue;
		}
		// A retained retry may hold a lease-expired claim token while fresher polls
		// already rotated the journal. Refresh from the journal so the retry uses
		// the newest token instead of failing on a stale one forever (4221d08e).
		const freshEvent = interactionJournal.eventFor(eventId);
		if (freshEvent && freshEvent.claim_token !== pending.event.claim_token) {
			pending.event = freshEvent;
		}
		attempted = true;
		await applyInteractionEvent(active, ctx, pending.event);
	}
	armInteractionRetryWake(active);
	return attempted;
}

async function acknowledgeInteractionApplication(run: ExactInteractionRun): Promise<boolean> {
	if (run.application !== "applied" || !interactionAuthorityCurrent(run.authority)) return false;
	const resolved = await resolveToken();
	if (!resolved) return false;
	try {
		const raw = await callDevspec(resolved.token, "poll_connection", {
			connection_id: run.authority.connectionId,
			interaction_event_version: 1,
			question_dismissal_event_version: 1,
			...interactionEventAckArgs(interactionEventAck(run.details.event)),
			// ACK-only catch-up cannot claim another event or package an owner command.
			catch_up: true,
			cursor_v2: run.active.cursor,
			dispatch_cursor: run.active.dispatchCursor,
			wait_ms: 0,
			listener_armed: true,
		}, { timeoutMs: 10_000, lane: "pump", connectionCapability: run.authority.connectionCapability });
		const unwrapped = unwrapMcpResult(raw);
		if (unwrapped.isError) throw new Error(unwrapped.text || "interaction ACK failed");
		const details = interactionJournal.detailsFor(run.identity.eventId);
		if (interactionJournal.markAcknowledged(run.identity.eventId, run.identity.claimToken) && details) {
			pi_appendInteractionEntry("acknowledged", details);
		}
		return true;
	} catch {
		// The main poll retries this same exact ACK; durable application is never undone.
		if (pump === run.active && !run.active.stop) signalWake(run.active);
		return false;
	}
}

async function attemptInteractionPersistenceConfirmation(
	confirmation: PendingInteractionConfirmation,
	settled: boolean,
): Promise<void> {
	try {
		const result = interactionDelivery.confirmPersistedMessage({
			message: confirmation.message,
			persistedEntries: readPersistedActiveBranchEntries(
				confirmation.sessionManager,
				confirmation.sessionFile,
			),
			isAuthorityCurrent: interactionAuthorityCurrent,
			port: interactionDeliveryPort(confirmation.active, confirmation.run),
		});
		if (result === "confirmed") {
			pendingInteractionConfirmations.delete(confirmation);
			confirmation.run.application = "applied";
			// ACK is a mechanical persistence receipt, not model completion. Send it
			// now while Pi is busy so a 30-second claim lease cannot redeliver.
			await acknowledgeInteractionApplication(confirmation.run);
		} else if (result === "rejected") {
			pendingInteractionConfirmations.delete(confirmation);
			await releaseInteractionBeforePersistence(confirmation.run, "interaction_persistence_rejected");
		} else if (settled) {
			interactionDelivery.abandonMessage(confirmation.message);
			pendingInteractionConfirmations.delete(confirmation);
			await releaseInteractionBeforePersistence(confirmation.run, "interaction_persistence_missing");
		}
	} catch (error) {
		pendingInteractionConfirmations.delete(confirmation);
		if (confirmation.run.application === "starting") {
			await releaseInteractionBeforePersistence(confirmation.run, "interaction_persistence_confirmation_failed");
		}
		debug("interaction event persistence confirmation failed", { errorPresent: Boolean(error) });
	}
}

function confirmInteractionMessageAfterPersistence(
	message: InteractionEventMessageEndLike,
	ctx: ExtensionContext,
): void {
	const active = pump;
	const messageDetails = (message.details && typeof message.details === "object")
		? message.details as { event?: { event_id?: unknown } }
		: null;
	const eventId = messageDetails?.event?.event_id;
	const run = typeof eventId === "string" ? interactionRunsByEvent.get(eventId) : undefined;
	if (!active || !run || run.active !== active) return;
	const confirmation: PendingInteractionConfirmation = {
		message,
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionManager: ctx.sessionManager,
		active,
		run,
	};
	pendingInteractionConfirmations.add(confirmation);
	// message_end handlers run immediately before Pi's synchronous JSONL append.
	// A later task usually observes it; agent_settled is the definitive fallback
	// if another async message_end handler delays persistence past this task.
	const timer = setTimeout(() => { void attemptInteractionPersistenceConfirmation(confirmation, false); }, 0);
	if (typeof timer.unref === "function") timer.unref();
}

/** Recover observed-before-application and applied-before-receipt crash windows. */
function resumePersistedInteractionEvents(active: PumpState, ctx: ExtensionContext): void {
	if (active.busy || !ctx.isIdle()) return;
	for (const details of interactionJournal.pendingApplications(active.bond.connectionId, active.bond.sessionId)) {
		if (pump !== active || active.stop || active.busy || !ctx.isIdle()) return;
		void applyInteractionEvent(active, ctx, details.event);
	}
	if (interactionJournal.hasPendingAck(active.bond.connectionId)) signalWake(active);
}

/** Wait for a wake frame (or the safety tick). Never rejects. */
function waitForWake(active: PumpState, safetyMs: number): Promise<void> {
	return active.wakeGate.wait(safetyMs);
}

/**
 * The stream dropped unexpectedly (or failed to connect). Reconnect with
 * bounded backoff (item 8b0c162b) — a proxy hiccup must not cost the bond its
 * fast lane for the rest of its life. Only when quick retries are exhausted do
 * we settle into the held long-poll fallback (pushClosed). The server's
 * grace-guarded liveness clear (10s) gives these retries their window: a
 * reconnect that lands in time re-stamps presence and defeats the clear.
 */
function schedulePushReconnect(
	active: PumpState,
	token: string,
	endpoint: string,
	streamGeneration: number,
): void {
	if (active.stop || active.pushEnded !== undefined ||
		!active.pushGenerationFence.isCurrent(streamGeneration)) return;
	const delay = nextPushReconnectDelayMs(active.pushAttempts, active.pushOpenedAt, Date.now());
	if (delay === null) {
		active.pushClosed = true;
		debug("push reconnects exhausted — held long-poll fallback");
		return;
	}
	active.pushAttempts += 1;
	debug("push reconnect attempt", { attempt: active.pushAttempts, delayMs: delay });
	if (active.pushReconnectTimer) clearTimeout(active.pushReconnectTimer);
	active.pushReconnectTimer = setTimeout(() => {
		active.pushReconnectTimer = undefined;
		if (active.stop || active.pushEnded !== undefined ||
			!active.pushGenerationFence.isCurrent(streamGeneration)) return;
		startPushChannel(active, token, endpoint);
		// A re-opened stream's first marker read always wakes (fresh baseline),
		// so nothing that moved during the outage is missed.
		signalWake(active);
	}, delay);
	if (typeof active.pushReconnectTimer.unref === "function") active.pushReconnectTimer.unref();
}

/** Open the SSE push channel; drops route through schedulePushReconnect. */
function startPushChannel(active: PumpState, token: string, endpoint: string): void {
	const streamGeneration = active.pushGenerationFence.begin();
	const controller = new AbortController();
	active.pushAbort = controller;
	active.pushOpenedAt = Date.now();
	active.pushInteractionAware = interactionEventsRelevant(active);
	const current = () => pump === active && !active.stop &&
		active.pushGenerationFence.isCurrent(streamGeneration);
	void openPushChannel({
		mcpUrl: endpoint,
		token,
		connectionId: active.bond.connectionId,
		connectionCapability: active.bond.connectionCapability,
		systemNoticeVersion: 1,
		...(active.pushInteractionAware ? { interactionEventVersion: 1 as const, questionDismissalEventVersion: 1 as const } : {}),
		signal: controller.signal,
		handlers: {
			onWake: () => {
				if (!current()) return;
				debug("push wake");
				signalWake(active);
			},
			onEnded: (reason) => {
				if (!current()) return;
				active.pushEnded = reason;
				signalWake(active);
			},
			onClose: (reason) => {
				if (controller.signal.aborted || !current()) return;
				debug("push channel closed", { reasonPresent: Boolean(reason) });
				schedulePushReconnect(active, token, endpoint, streamGeneration);
				signalWake(active);
			},
		},
	}).catch((err) => {
		if (controller.signal.aborted || !current()) return;
		debug("push channel connect failed", { errorPresent: Boolean(err) });
		schedulePushReconnect(active, token, endpoint, streamGeneration);
		signalWake(active);
	});
}

/** Restart the same stream only when its additive negotiation changed. */
function ensurePushInteractionNegotiation(active: PumpState, token: string, endpoint: string): void {
	const desired = interactionEventsRelevant(active);
	if (active.pushInteractionAware === desired) return;
	// Cancel AND fence a drop timer before opening the replacement stream. The
	// stale callback cannot create a second concurrent stream even if it races.
	if (active.pushReconnectTimer) clearTimeout(active.pushReconnectTimer);
	active.pushReconnectTimer = undefined;
	active.pushGenerationFence.invalidate();
	active.pushAbort?.abort();
	active.pushClosed = false;
	active.pushAttempts = 0;
	startPushChannel(active, token, endpoint);
	signalWake(active);
}

function automationRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function assertDeliveryAuthority(active: PumpState, lease: DeliveryLease): void {
	lease.assertCurrent();
	if (active.stop || pump !== active || pump.generation !== active.generation) {
		throw new StaleDeliveryError();
	}
}

async function deliverAutomationRun(
	active: PumpState,
	value: unknown,
	ctx: ExtensionContext,
	lease: DeliveryLease,
): Promise<void> {
	assertDeliveryAuthority(active, lease);
	if (!isAutomationRunEnvelope(value)) return;
	const root = automationRecord(value);
	const message = formatAutomationRunMessage(value, active.bond.codename ?? "this agent");
	assertDeliveryAuthority(active, lease);
	noteAutomation({
		runId: typeof root?.run_id === "string" ? root.run_id : undefined,
		id: typeof root?.automation_id === "string" ? root.automation_id : undefined,
		name: typeof root?.automation_name === "string" ? root.automation_name : undefined,
	});
	paintStatus(ctx);
	pi_send(message, ctx.isIdle() ? "now" : "followUp");
}

async function loadCurrentAutomationInbox(
	active: PumpState,
	key: string,
	token: string,
	ctx: ExtensionContext,
): Promise<{ dispatches: readonly unknown[]; identityComplete: boolean }> {
	const raw = await callDevspec(
		token,
		"get_connection_dispatch",
		{ connection_id: active.bond.connectionId, dispatch_id: key },
		{ timeoutMs: MODEL_TIMEOUT_MS, cwd: ctx.cwd, lane: "work" },
	);
	const { details, isError, text } = unwrapMcpResult(raw);
	if (isError) throw new Error(text || "automation run retry revalidation failed");
	const payload = details as { dispatches?: unknown[]; dispatch_id?: unknown; identity_complete?: unknown } | null;
	if (!Array.isArray(payload?.dispatches)) throw new Error("automation run retry revalidation returned no live inbox");
	return {
		dispatches: payload.dispatches,
		identityComplete: payload.identity_complete === true && payload.dispatch_id === key,
	};
}

function scheduleAutomationRetry(
	active: PumpState,
	key: string,
	token: string,
	ctx: ExtensionContext,
	error: unknown,
	quiet = false,
): void {
	if (active.stop || pump !== active) return;
	const authority = capturePumpAuthority({ generation: active.generation, connectionId: active.bond.connectionId });
	const authorityIsCurrent = () => pump === active && !active.stop && isPumpAuthorityCurrent(authority, {
		generation: active.generation,
		connectionId: active.bond.connectionId,
	});
	const failures = (active.automationRetryAttempts.get(key) ?? 0) + 1;
	active.automationRetryAttempts.set(key, failures);
	const delayMs = nextDeliveryRetryDelayMs(failures);
	const reason = error instanceof Error ? error.message : String(error);
	if (!active.automationRetryTimers.has(key)) {
		const timer = setTimeout(() => {
			active.automationRetryTimers.delete(key);
			if (!authorityIsCurrent()) return;
			void revalidateAutomationRunRetry({
				key,
				loadCurrentInbox: () => loadCurrentAutomationInbox(active, key, token, ctx),
				identity: automationRunId,
				assertCurrent: () => {
					if (!authorityIsCurrent()) throw new StaleDeliveryError();
				},
				withdrawCurrent: () => active.automationQueue.invalidateKey(key),
				enqueueCurrent: (currentRun) => enqueueAutomationRun(active, token, currentRun, ctx),
			}).then((outcome) => {
				if (!authorityIsCurrent()) return;
				if (outcome === "withdrawn") {
					active.automationRetryAttempts.delete(key);
				} else if (outcome === "retry") {
					scheduleAutomationRetry(active, key, token, ctx, "automation run authority is not yet confirmable", true);
				}
			}).catch((retryError) => {
				if (authorityIsCurrent()) scheduleAutomationRetry(active, key, token, ctx, retryError);
			});
		}, delayMs);
		if (typeof timer.unref === "function") timer.unref();
		active.automationRetryTimers.set(key, timer);
	}
	if (!quiet) {
		notify(ctx, `DevSpec remote: failed to deliver automation run: ${reason}. Revalidating in ${Math.ceil(delayMs / 1_000)}s.`, "warning");
	}
}

function enqueueAutomationRun(
	active: PumpState,
	token: string,
	value: unknown,
	ctx: ExtensionContext,
): void {
	if (!isAutomationRunEnvelope(value)) return;
	const key = automationRunId(value);
	if (!key) return;
	active.automationQueue.enqueue(
		key,
		async (lease) => {
			await deliverAutomationRun(active, value, ctx, lease);
			active.automationRetryAttempts.delete(key);
			const timer = active.automationRetryTimers.get(key);
			if (timer) clearTimeout(timer);
			active.automationRetryTimers.delete(key);
			if (!active.stop && pump === active) notify(ctx, "DevSpec remote: automation run delivered.");
		},
		(error) => scheduleAutomationRetry(active, key, token, ctx, error),
	);
}

/**
 * Revive a recoverably-ended server bond in place (idle timeout, redeploy,
 * transient not_found). The owning Pi process is still alive, so stopping the
 * pump would turn the server's inference into a real disconnect. Registration
 * uses the same conversation local_id; the server revives that identity and
 * rotates its hidden capability. Existing cursors/seen-command state stay on
 * the pump so recovery cannot replay answered owner turns.
 */
async function reviveRecoverableBond(
	active: PumpState,
	token: string,
	ctx: ExtensionContext,
	// Optional out-param: set when the revive demonstrably failed BECAUSE the
	// credentials are rejected (not transport noise). Lets the caller tell
	// "confirmed revocation, stop retrying" from "still ambiguous, ride it
	// out" without parsing messages (item 781886cf).
	failure?: { authFailed: boolean },
): Promise<boolean> {
	if (active.stop || pump !== active) return false;
	const prior = active.bond;
	const localId = ctx.sessionManager.getSessionId();
	try {
		const regRaw = await callDevspec(token, "register_connection", {
			local_id: localId,
			agent_name: AGENT_NAME,
			machine_hostname: hostname(),
			cwd: ctx.cwd,
			connection_capability_version: 1,
		}, { cwd: ctx.cwd, lane: "pump" });
		const reg = unwrapMcpResult(regRaw);
		if (reg.isError) return false;
		const details = (reg.details ?? {}) as Record<string, unknown>;
		const connectionId = (details.connection_id ?? details.connectionId) as string | undefined;
		const connectionCapability = connectionCapabilityFromResult(regRaw);
		if (!connectionId || !connectionCapability || active.stop || pump !== active) return false;

		let sessionId = typeof details.session_id === "string" ? details.session_id : undefined;
		let attachedAt = typeof details.attached_at === "string" ? details.attached_at : undefined;
		let speechAttachmentId = typeof details.speech_attachment_id === "string" ? details.speech_attachment_id : undefined;
		if (!sessionId && prior.sessionId) {
			const attachRaw = await callDevspec(token, "attach_connection", {
				connection_id: connectionId,
				session_id: prior.sessionId,
			}, { cwd: ctx.cwd, lane: "pump" });
			const attach = unwrapMcpResult(attachRaw);
			if (attach.isError || active.stop || pump !== active) return false;
			const attached = (attach.details ?? {}) as Record<string, unknown>;
			sessionId = typeof attached.session_id === "string" ? attached.session_id : prior.sessionId;
			attachedAt = typeof attached.attached_at === "string" ? attached.attached_at : undefined;
			speechAttachmentId = typeof attached.speech_attachment_id === "string" ? attached.speech_attachment_id : undefined;
		}

		const recoveredScope = planRecoveredConnectionScope({
			currentConnectionId: prior.connectionId,
			nextConnectionId: connectionId,
			generation: active.generation,
			nextGeneration: connectionId === prior.connectionId ? active.generation : nextPumpGeneration++,
			cursor: active.cursor,
			dispatchCursor: active.dispatchCursor,
			systemNoticeCursor: active.systemNoticeCursor,
			synced: active.synced,
			agentName: AGENT_NAME,
			codename: typeof details.codename === "string" ? details.codename : prior.codename,
		});
		const changedConnection = recoveredScope.changedConnection;
		const bond: BondState = {
			...prior,
			connectionId,
			projectId: typeof details.project_id === "string" ? details.project_id : prior.projectId,
			connectionCapability,
			codename: typeof details.codename === "string" ? details.codename : prior.codename,
			sessionId,
			attachedAt,
			speechAttachmentId,
			instructions: {
				owner_custom_instructions: (details.owner_custom_instructions as string | undefined) ?? prior.instructions?.owner_custom_instructions,
				owner_agent_rules: (details.owner_agent_rules as string | undefined) ?? prior.instructions?.owner_agent_rules,
				project_custom_instructions: (details.project_custom_instructions as string | undefined) ?? prior.instructions?.project_custom_instructions,
				project_agent_rules: (details.project_agent_rules as string | undefined) ?? prior.instructions?.project_agent_rules,
			},
		};

		active.pushGenerationFence.invalidate();
		active.pushAbort?.abort();
		if (active.pushReconnectTimer) clearTimeout(active.pushReconnectTimer);
		active.pushReconnectTimer = undefined;
		active.pushClosed = false;
		active.pushEnded = undefined;
		active.pushAttempts = 0;
		active.errors = 0;
		active.bond = bond;
		active.generation = recoveredScope.generation;
		active.cursor = recoveredScope.cursor;
		active.dispatchCursor = recoveredScope.dispatchCursor;
		active.systemNoticeCursor = recoveredScope.systemNoticeCursor;
		active.synced = recoveredScope.synced;
		active.connectionIdentity = recoveredScope.connectionIdentity;
		if (changedConnection) {
			resetDirectedQuestionReceiptBatch();
			// A replacement row is different authority: pending bindings for the old
			// connection's turns must not be inherited here (item 6f4136d8).
			commandTurnBindings.clear();
			pendingBackgroundTaskIds.clear();
			activeCommandTurnIdentity = null;
			active.advisoryCarry = [];
			active.attachmentRetryAttempts.clear();
			active.automationQueue.invalidate();
			active.automationQueue = new DeliveryQueue();
			for (const timer of active.automationRetryTimers.values()) clearTimeout(timer);
			active.automationRetryTimers.clear();
			active.automationRetryAttempts.clear();
			revokeSystemNoticeState(active.systemNoticeKey);
			active.systemNoticeKey = bindSystemNoticeState({
				piSessionId: localId,
				connectionId,
				pumpGeneration: active.generation,
			});
			// General bond recovery remains valid, but a replacement row is different
			// interaction authority and cannot inherit the old run or journal ACK.
			revokeInteractionForAttachmentChange(active, ctx);
			replaceInteractionJournal(new InteractionEventJournal());
		} else {
			// Same-row revival rotates only the hidden transport capability. Exact
			// attempts and durable receipts remain authoritative in the same workflow.
			for (const run of interactionRunsByEvent.values()) {
				if (run.active === active && run.authority.connectionId === connectionId &&
					run.authority.sourceSessionId === sessionId) {
					run.authority.connectionCapability = connectionCapability;
				}
			}
		}
		setBond(bond);
		pi_setPlanToolActive(Boolean(bond.sessionId));
		pi_setQuestionToolActive(Boolean(bond.sessionId && bond.connectionCapability));
		pi_setPollToolActive(Boolean(bond.sessionId && bond.connectionCapability));
		setRemoteStatus(ctx);
		if (bond.sessionId) void enrichBondWithSession(bond.sessionId);
		resumePersistedInteractionEvents(active, ctx);
		startPushChannel(active, token, await resolveEndpoint());
		signalWake(active);
		return true;
	} catch (err) {
		if (failure) failure.authFailed = err instanceof DevspecAuthError;
		return false;
	}
}

async function pumpLoop(ctx: ExtensionContext): Promise<void> {
	const active = pump;
	if (!active) return;
	const resolved = await resolveToken();
	if (!resolved) return;
	const token = resolved.token;

	// Push mode: SSE wakes us; we fetch the package with a no-hold poll.
	// Falls back to the held long-poll if the channel stays unavailable.
	const endpoint = await resolveEndpoint();
	startPushChannel(active, token, endpoint);
	let pushMode = true;
	// The safety tick keeps presence fresh and catches anything the stream missed.
	// Cadence is module-scope PUSH_SAFETY_MS (pinned by presence-cadence tests).
	let notifiedFallback = false;
	// Degraded-episode notice: warned once per prolonged failure run, cleared
	// with a single recovery notice on the next clean lap (item 781886cf).
	let notifiedDegraded = false;

	while (pump === active && !active.stop) {
		lastCtx = ctx;
		ensurePushInteractionNegotiation(active, token, endpoint);
		if (active.stop || pump !== active) return;
		// Server told us the bond ended — only a human End / local stop is sticky.
		if (active.pushEnded !== undefined) {
			if (isPermanentServerEnd("ended", active.pushEnded)) {
				notify(ctx, `DevSpec remote: connection ended${active.pushEnded ? ` (${active.pushEnded})` : ""}.`, "info");
				await stopPump(ctx, "owner_gone", true);
				return;
			}
			debug("push ended recoverable", { reasonPresent: Boolean(active.pushEnded) });
			if (await reviveRecoverableBond(active, token, ctx)) {
				pushMode = true;
				notifiedFallback = false;
				continue;
			}
			active.errors += 1;
			await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
			continue;
		}
		if (pushMode && active.pushClosed) {
			pushMode = false;
			if (!notifiedFallback) {
				notifiedFallback = true;
				debug("push unavailable — held long-poll fallback");
			}
		}
		if (pushMode) {
			await waitForWake(active, PUSH_SAFETY_MS);
			if (active.stop || pump !== active) return;
			if (active.pushEnded !== undefined) continue; // handled at the top
			if (active.pushClosed) continue; // fall through to long-poll next lap
		}
		const retryAt = nextInteractionRetryAt(active);
		if (retryAt !== null && retryAt > Date.now()) {
			await new Promise((resolve) => setTimeout(resolve, retryAt - Date.now()));
			if (active.stop || pump !== active) return;
		}
		if (await drainInteractionRetries(active, ctx)) continue;

		// The server can claim ten at once. Negotiate only when that complete batch
		// fits; otherwise ordinary 1.3 command polling continues while notices stay
		// server-retained behind the still-aware SSE marker.
		const systemNoticeNegotiated = hasSystemNoticeBatchCapacity(active.systemNoticeKey);
		// Claims are idle-only. A durable application ACK is different: it must
		// travel immediately while the model is busy, before the 30-second event
		// lease can redeliver. catch_up below keeps that ACK lap event/command-free.
		const interactionEventAck = interactionEventsRelevant(active)
			? interactionJournal.nextAck(active.bond.connectionId, active.bond.sessionId)
			: null;
		const interactionClaimIdle = interactionEventsRelevant(active)
			&& Boolean(active.bond.sessionId) && !active.busy
			&& !active.runtimeOccupancy.isBusy() && ctx.isIdle();
		// Busy + preempt on: claim the event so we can abort, then apply once idle.
		// Do not mix this with an ACK catch_up lap (that lane is event-free).
		const interactionClaimBusyPreempt = interactionEventsRelevant(active)
			&& Boolean(active.bond.sessionId)
			&& preemptOwnerCached
			&& !interactionClaimIdle
			&& !interactionEventAck;
		const interactionEventNegotiated = interactionClaimIdle || interactionClaimBusyPreempt || Boolean(interactionEventAck);
		let payload: unknown;
		try {
			const raw = await callDevspec(
				token,
				"poll_connection",
				{
					connection_id: active.bond.connectionId,
					ingress_version: 1,
					delegated_scope_version: 1,
					active_plan_projection_version: 1,
					...(systemNoticeNegotiated ? {
						system_notice_version: 1,
						system_notice_cursor: active.systemNoticeCursor,
					} : {}),
					...(interactionEventNegotiated ? {
						interaction_event_version: 1,
						question_dismissal_event_version: 1,
						...(interactionEventAck ? interactionEventAckArgs(interactionEventAck) : {}),
					} : {}),
					cursor_v2: active.cursor,
					dispatch_cursor: active.dispatchCursor,
					wait_ms: pushMode ? 0 : POLL_WAIT_MS,
					...(interactionEventAck && (active.busy || active.runtimeOccupancy.isBusy()) ? { catch_up: true } : {}),
					// Generic busy projection is forbidden for exact interaction attempts;
					// their lease is refreshed with report_keepalive and exact tuple.
					...(!activeInteractionRun(active) ? { busy: active.busy } : {}),
					listener_armed: true,
					agent_name: AGENT_NAME,
					agent_stats: runtimeAgentStats(ctx),
				},
				{ timeoutMs: POLL_TIMEOUT_MS, cwd: ctx.cwd, lane: "pump", ...(interactionEventNegotiated && active.bond.connectionCapability ? { connectionCapability: active.bond.connectionCapability } : {}) },
			);
			const { details, isError, text } = unwrapMcpResult(raw);
			if (isError) throw new Error(text || "poll_connection failed");
			payload = details;
			if (notifiedDegraded) {
				notifiedDegraded = false;
				notify(ctx, "DevSpec remote: connection recovered.", "info");
			}
			active.errors = 0;
		} catch (err) {
			// Only CONFIRMED credential rejection ends the bond (item 781886cf).
			// Unavailable validation, transport noise, and ambiguous 401s ride
			// out the backoff below. An auth-shaped failure first gets one
			// revive, which re-validates the token and mints a fresh capability
			// — an expired capability heals with no user action. Never stamp
			// owner_gone / local_stop for anything but a dead host / human stop:
			// confirmed rejection stamps auth.
			if (shouldEndBondOnPollFailure(err)) {
				const failure = { authFailed: false };
				if (await reviveRecoverableBond(active, token, ctx, failure)) {
					pushMode = true;
					notifiedFallback = false;
					continue;
				}
				if (failure.authFailed) {
					notify(ctx, "DevSpec remote: credentials rejected — bond ended. /devspec.login to reconnect.", "error");
					await stopPump(ctx, "auth");
					return;
				}
				// Revive failed without proving revocation (transport noise mid
				// revive) — fall through to the recoverable path, not the end.
			}
			active.errors += 1;
			if (active.errors === 1 || active.errors % MAX_CONSECUTIVE_ERRORS === 0) {
				debug("poll recoverable", { errors: active.errors, errorPresent: Boolean(err) });
			}
			if (active.errors === MAX_CONSECUTIVE_ERRORS && !notifiedDegraded) {
				// Prolonged failure, still retrying: say so once, with the one
				// manual action that helps. Short blips stay quiet by design.
				notifiedDegraded = true;
				notify(ctx, "DevSpec remote: connection troubled — retrying automatically. /devspec.remote reconnect to retry now.", "warning");
			}
			void beatBusy(active.busy);
			await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
			continue;
		}

		if (active.stop || pump !== active) return;

		// The long-poll path also reports server-side ends (status: 'ended').
		// Only a human End / local stop is sticky. Redeploy / not_found / a
		// missing reason stay recoverable — ride them out in place.
		const status = (payload as { status?: string } | null)?.status;
		if (status === "ended" || status === "not_found") {
			const endReason = (payload as { end_reason?: string | null } | null)?.end_reason ?? null;
			if (isPermanentServerEnd(status, endReason)) {
				notify(ctx, `DevSpec remote: connection ended${endReason ? ` (${endReason})` : ""}.`, "info");
				await stopPump(ctx, "owner_gone", true);
				return;
			}
			active.errors += 1;
			debug("poll recoverable server response", { ended: status === "ended", reasonPresent: Boolean(endReason) });
			if (await reviveRecoverableBond(active, token, ctx)) {
				pushMode = true;
				notifiedFallback = false;
				continue;
			}
			await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
			continue;
		}

		// Parse the complete public event lane before host application or local ACK
		// commitment. Unknown/malformed versions remain server-retained.
		let interactionEvent: DirectedQuestionEventV1 | null;
		try {
			interactionEvent = parseDirectedQuestionEventPollPayload(payload, interactionEventNegotiated);
		} catch (error) {
			active.errors += 1;
			debug("interaction event payload rejected", { errors: active.errors, errorPresent: Boolean(error) });
			await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
			continue;
		}
		if (interactionEventAck) {
			const ackDetails = interactionJournal.detailsFor(interactionEventAck.event_id);
			if (interactionJournal.markAcknowledged(interactionEventAck.event_id, interactionEventAck.claim_token) && ackDetails) {
				pi_appendInteractionEntry("acknowledged", ackDetails);
			}
		}

		// Adopt the server's CURRENT attachment every lap (edea1a91: the server is
		// the sole attachment authority — the client observes, never re-adopts from
		// local state). Without this, an owner attaching the connection from the UI
		// after a sessionless auto-bond never took effect locally: bond.sessionId
		// stayed null, so the mechanical trail and the mechanical final answer
		// skipped every turn ('not attached') and only deliberate tool-posts reached
		// the UI — the bouncing-dots regression of item ce5a1432. Applies to detach
		// too (server session_id null → posting stops).
		const serverSessionId = (payload as { session_id?: string | null } | null)?.session_id ?? null;
		const serverAttachedAt = (payload as { attached_at?: string | null } | null)?.attached_at ?? undefined;
		const serverAttachmentId = (payload as { speech_attachment_id?: string | null } | null)?.speech_attachment_id ?? undefined;
		if (serverSessionId !== (active.bond.sessionId ?? null) || serverAttachedAt !== active.bond.attachedAt || serverAttachmentId !== active.bond.speechAttachmentId) {
			resetDirectedQuestionReceiptBatch();
			// The server migration atomically seals/releases an in-flight exact
			// interaction on detach/reattach. Abort local execution immediately so
			// no model/tool side effect continues under revoked source authority.
			revokeInteractionForAttachmentChange(active, ctx);
			// A new room (or detach) invalidates pending bindings for the old room's
			// turns: identical terminal text must not inherit them (item 6f4136d8).
			commandTurnBindings.clear();
			pendingBackgroundTaskIds.clear();
			activeCommandTurnIdentity = null;
			const next = {
				...active.bond,
				sessionId: serverSessionId ?? undefined,
				attachedAt: serverAttachedAt,
				speechAttachmentId: serverAttachmentId,
				// A new room (or detach) must not keep the previous room's title.
				sessionTitle: undefined,
				ownerName: undefined,
				attachContext: undefined,
				roomDigest: undefined,
			};
			active.bond = next;
			const detachTail = authoritativeActivePlanTransitionTail(
				active.awarenessKey,
				active.activePlanTail,
				"",
			);
			if (detachTail) active.pendingActivePlanTail = detachTail;
			active.activePlanTail = "";
			active.pendingSessionPollsTail = "";
			active.sessionPollsTail = "";
			active.pendingStillToDiscussTail = "";
			active.stillToDiscussTail = "";
			setBond(next);
			pi_setPlanToolActive(Boolean(serverSessionId));
			pi_setQuestionToolActive(Boolean(serverSessionId && next.connectionCapability));
			pi_setPollToolActive(Boolean(serverSessionId && next.connectionCapability));
			setRemoteStatus(ctx);
			debug("attachment adopted from server", { attached: Boolean(serverSessionId) });
			// Refresh display identity only. Command-turn context is canonical ingress.
			if (serverSessionId) {
				void enrichBondWithSession(serverSessionId);
				// Reattachment may follow a message_end whose custom message persisted
				// while authority was detached. Rebuild from disk before considering ACK.
				replaceInteractionJournal(InteractionEventJournal.reconstruct(
					readPersistedActiveBranchEntries(ctx.sessionManager) ?? [],
					ctx.sessionManager.getSessionId(),
				));
			}
			resumePersistedInteractionEvents(active, ctx);
			ensurePushInteractionNegotiation(active, token, endpoint);
		}

		if (interactionEvent) {
			const idle = !active.busy && !active.runtimeOccupancy.isBusy() && ctx.isIdle();
			if (decideInteractionDelivery({
				idle,
				preemptEnabled: preemptOwnerCached,
				hasEvent: true,
			}) === "preempt") {
				interactionJournal.observe(interactionApplicationDetails(active, ctx, interactionEvent));
				if (interactionJournal.notePreemptAbort(interactionEvent.event_id)) {
					debug("preempt: aborting running turn for question answer");
					pi_abort();
					const settled = await waitUntil(
						() => ctx.isIdle() && !active.busy && !active.runtimeOccupancy.isBusy(),
						{ timeoutMs: 8_000, intervalMs: 50 },
					);
					debug("preempt", { settled });
					if (shouldClearStrandedBusyAfterAbort({ settled, ctxIdle: ctx.isIdle(), occupancyBusy: active.runtimeOccupancy.isBusy(), pumpBusy: active.busy })) {
						// The abort landed but settle accounting never ran (item 3f07f97b):
						// nothing is running, so busy is stranded, not live. Clear it so
						// the event can apply instead of deferring forever.
						active.busy = false;
						void beatBusy(false);
						debug("preempt: cleared stranded busy after unsettled abort");
					}
				} else {
					debug("interaction preempt already aborted for event; awaiting idle");
					if (shouldClearStrandedBusyAfterAbort({ settled: false, ctxIdle: ctx.isIdle(), occupancyBusy: active.runtimeOccupancy.isBusy(), pumpBusy: active.busy })) {
						// Same recovery for a wedge that formed before this fix (item
						// 3f07f97b): no fresh abort ran this lap, but nothing is running
						// and busy is set, so it is stranded all the same.
						active.busy = false;
						void beatBusy(false);
						debug("preempt: cleared stranded busy after unsettled abort");
					}
				}
				if (pump !== active || active.stop) continue;
			}
			if (!await applyInteractionEvent(active, ctx, interactionEvent)) {
				active.errors += 1;
				debug("interaction event exact-workflow guard rejected", { errors: active.errors });
				await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
			}
			// The server's event-only lane intentionally carries no canonical ingress,
			// dispatch, notice, cursor, control, plan, trail, or activity payload.
			continue;
		}

		// Titles are job-generated from the first substantial message: an attach
		// that found none retries on a slow cadence (never hot-polled) until one
		// lands — and a refresh never re-injects the attach block.
		if (active.bond.sessionId && !isRealSessionTitle(active.bond.sessionTitle)) {
			const last = active.lastSessionEnrichAt ?? 0;
			if (Date.now() - last > 60_000) {
				active.lastSessionEnrichAt = Date.now();
				void enrichBondWithSession(active.bond.sessionId);
			}
		}

		const pkg = parsePollPayload(payload, active.connectionIdentity, { systemNoticeNegotiated });
		if (pkg.canonicalState === "invalid") {
			// A negotiated changed response without a valid known ingress envelope
			// has no executable or contextual meaning. Keep the canonical cursor
			// unchanged so a corrected response can be retried.
			const dispatches = (payload as { dispatches?: unknown[] } | null)?.dispatches ?? [];
			for (const dispatch of dispatches) enqueueAutomationRun(active, token, dispatch, ctx);
			if (pkg.dispatchCursor) active.dispatchCursor = pkg.dispatchCursor;
			active.errors += 1;
			debug("canonical ingress rejected", { errors: active.errors, errorPresent: Boolean(pkg.canonicalError) });
			await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
			continue;
		}

		if (pkg.systemNotices.length > 0) {
			if (!acceptSystemNotices(active.systemNoticeKey, pkg.systemNotices)) {
				active.errors += 1;
				debug("system notice memory queue rejected", { errors: active.errors, count: pkg.systemNotices.length });
				await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
				continue;
			}
			// This independent point advances only after the entire validated batch is
			// retained in bounded memory (busy) or synchronously accepted by idle Pi.
			if (pkg.systemNoticeCursor) active.systemNoticeCursor = pkg.systemNoticeCursor;
			// A claim may be capped while more rows remain. Coalesce one immediate
			// no-hold lap while another complete batch still fits; once capacity is
			// below ten, ordinary SSE-driven command polling continues under 1.3.
			if (hasSystemNoticeBatchCapacity(active.systemNoticeKey)) signalWake(active);
			if (!active.busy && ctx.isIdle()) {
				try { deliverQueuedSystemNotices(active, ctx); } catch (error) {
					debug("system notice idle delivery failed", { errorPresent: Boolean(error) });
				}
			}
		}

		if (pkg.activeSessionPlans !== undefined) {
			const planTail = serializeActiveSessionPlansProjection(pkg.activeSessionPlans, active.bond.connectionId);
			const transitionTail = authoritativeActivePlanTransitionTail(
				active.awarenessKey,
				active.activePlanTail,
				planTail,
			);
			if (transitionTail) active.pendingActivePlanTail = transitionTail;
			active.activePlanTail = planTail;
			pi_setPlanToolActive(Boolean(active.bond.sessionId || planTail));
		}

		if (pkg.sessionPolls !== undefined) {
			const pollTail = serializeSessionPollsProjection(pkg.sessionPolls);
			if (pollTail !== active.sessionPollsTail) active.pendingSessionPollsTail = pollTail;
			active.sessionPollsTail = pollTail;
			pi_setPollToolActive(Boolean(active.bond.sessionId && active.bond.connectionCapability));
		}

		if (pkg.stillToDiscuss !== undefined) {
			const discussTail = serializeStillToDiscussProjection(pkg.stillToDiscuss);
			if (discussTail !== active.stillToDiscussTail) active.pendingStillToDiscussTail = discussTail;
			active.stillToDiscussTail = discussTail;
		}

		const control = parseControlCommand(pkg.control);
		if (control) {
			lastCtx = ctx;
			// Reload is terminal for this pump frame (item e4d5612c). Ack first so
			// a revived bond cannot see the same pending CONTROL, then reload, then
			// return. Do not notify on the old ctx after a successful reload.
			if (control.verb === "reload") {
				const lap = await runReloadLap({
					ack: () => ackControl(token, active.bond.connectionId, control.id),
					reload: () => reloadWithContext(commandReloadContext() ?? (ctx as { reload?: () => Promise<void> })),
				});
				debug("control reload", { succeeded: lap.status === "reloaded", errorPresent: Boolean(lap.error) });
				if (lap.status === "reloaded") return;
				notify(ctx, `DevSpec remote: reload failed — ${lap.error ?? lap.status}`, "error");
			} else {
				let catalog: ModelCatalogSnapshot | undefined;
				try {
					const result = await executeControlCommand(control, {
						isIdle: () => ctx.isIdle(),
						abort: () => ctx.abort(),
						compact: () => compactWithContext(ctx),
						reload: () => reloadWithContext(commandReloadContext() ?? (ctx as { reload?: () => Promise<void> })),
						setThinkingLevel: (level) => pi_setThinking(level),
						setModel: (modelId) => pi_setModel(modelId),
						notify: (message) => notify(ctx, message),
					});
					debug("control completed", { resultPresent: Boolean(result) });
					if (control.verb === "list_models") {
						catalog = collectModelCatalog({
							scopedModels: ctx.scopedModels,
							modelRegistry: ctx.modelRegistry,
							model: ctx.model,
						});
						notify(ctx, `DevSpec remote: list_models — ${catalog.models.length} models.`);
					} else {
						notify(ctx, `DevSpec remote: ${control.verb} — ${result}.`);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					debug("control failed", { messageChars: msg.length });
					notify(ctx, `DevSpec remote: ${control.verb} failed — ${msg}`, "error");
				} finally {
					// Pi emits no event when a request clamps to the already-active level.
					if (control.verb === "set_thinking") scheduleRuntimeStamp(ctx);
				}
				void ackControl(token, active.bond.connectionId, control.id, catalog).catch(() => {});
			}
		}

		// Canonical replay/reseed semantics replace timestamp inference: history is
		// inactive at the server boundary and can never enter ownerCommands.
		if (!active.synced && pkg.canonicalState === "valid") {
			active.synced = true;
			debug("canonical ingress synced", { cursorPresent: Boolean(pkg.cursorV2) });
		}
		if (pkg.advisoryContext && !pkg.ownerBundle && !pkg.rejectedBundle) {
			// Carry at most one server-bounded advisory window. It joins the next
			// command's model turn but is never an independently queued message.
			active.advisoryCarry = [pkg.advisoryContext];
		}

		let commandDeliveryFailed = false;
		let commandRetryDelayMs = 0;
		if (pkg.rejectedBundle) {
			const unseen = active.seenOwnerCommands.takeUnseen(pkg.rejectedBundle.commands);
			if (unseen.length > 0) {
				const rejected = ownerBundleSubset(pkg.rejectedBundle, unseen);
				// Unavailable attachments are terminal for this immutable envelope, but
				// consume them only after the server acknowledges the explicit rejection.
				// A reporting failure releases the unseen subset and retains the cursor.
				const reported = await reportComplete("delivery_unavailable", rejected.commandTurnId, rejected.primaryCommand.id);
				if (reported) {
					active.attachmentRetryAttempts.delete(rejected.commandTurnId);
					active.seenOwnerCommands.commitBundle(unseen);
				} else {
					active.seenOwnerCommands.releaseBundle(unseen);
					commandDeliveryFailed = true;
					const failures = (active.attachmentRetryAttempts.get(rejected.commandTurnId) ?? 0) + 1;
					active.attachmentRetryAttempts.set(rejected.commandTurnId, failures);
					commandRetryDelayMs = nextDeliveryRetryDelayMs(failures);
				}

			}
		}

		if (pkg.ownerBundle) {
			const unseen = active.seenOwnerCommands.takeUnseen(pkg.ownerBundle.commands);
			if (unseen.length > 0) {
				const selectedBundle = ownerBundleSubset(pkg.ownerBundle, unseen);
				let attachmentLease: AttachmentDeliveryLease | undefined;
				try {
					// Hydrate the exact unseen subset atomically before deciding/performing
					// preemption. Overlapping retry windows cannot replay earlier commands.
					const hydration = await hydrateOwnerBundle(selectedBundle, active.bond.connectionId);
					const hydrated = hydration.bundle;
					attachmentLease = new AttachmentDeliveryLease(hydration.materialised);
					const mode = decideOwnerDelivery({
						idle: ctx.isIdle(),
						preemptEnabled: preemptOwnerCached,
						hasOwnerCommand: true,
					});
					const formatted = formatInboundBundleMessage(hydrated);
					const contextByEnvelope = new Map(
						[...active.advisoryCarry, hydrated.advisoryContext].map((context) => [context.envelopeId, context]),
					);
					const contexts = [...contextByEnvelope.values()];
					const queueItem = {
						hiddenContent: formatCanonicalDeliveryContext(hydrated, contexts),
						details: { bundle: hydrated, contexts },
					};
					const primary = hydrated.primaryCommand;
					const requester = primary.requester.display_name ?? primary.requester.user_id;
					if (pump !== active || active.stop) throw new Error("Remote bond changed before owner delivery.");
					let sendMode: "now" | "steer" | "followUp";
					let deliveryNotice: string;
					if (mode === "preempt") {
						debug("preempt: aborting running turn for owner instruction");
						pi_abort();
						const settled = await waitUntil(() => ctx.isIdle(), {
							timeoutMs: 8_000,
							intervalMs: 50,
						});
						sendMode = sendModeAtSendTime(mode, ctx.isIdle(), settled);
						debug("preempt", { settled, immediate: sendMode === "now" });
						if (pump !== active || active.stop) throw new Error("Remote bond changed during owner preemption.");
						deliveryNotice = `DevSpec remote: interrupted — ${requester} first.`;
					} else {
						sendMode = sendModeAtSendTime(mode, ctx.isIdle());
						if (pump !== active || active.stop) throw new Error("Remote bond changed before owner send.");
						deliveryNotice = mode === "queue" || sendMode === "followUp"
							? `DevSpec remote: queued canonical command turn (${requester}).`
							: `DevSpec remote: delivered canonical command turn (${requester}).`;
					}
					pi_send(formatted, sendMode, hydrated.commandTurnId, primary.id, queueItem);
					attachmentLease.accept();
					active.attachmentRetryAttempts.delete(hydrated.commandTurnId);
					// Commit immediately after Pi accepts the sole queue item; later UI
					// bookkeeping cannot turn an accepted send into a replay.
					active.seenOwnerCommands.commitBundle(unseen);
					notify(ctx, deliveryNotice);
					if (untitledAttached()) {
						setSessionPreview(previewFromText(primary.text));
						paintStatus(ctx);
						if (active.bond.sessionId) scheduleTitleRefresh(active.bond.sessionId);
					}
				} catch (err) {
					await attachmentLease?.cleanupIfPending();
					commandDeliveryFailed = true;
					active.seenOwnerCommands.releaseBundle(unseen);
					const failures = (active.attachmentRetryAttempts.get(selectedBundle.commandTurnId) ?? 0) + 1;
					active.attachmentRetryAttempts.set(selectedBundle.commandTurnId, failures);
					commandRetryDelayMs = nextDeliveryRetryDelayMs(failures);
					const reason = sanitizeAttachmentFailureReason(err, "delivery failed");
					notify(ctx, `DevSpec remote: failed to deliver canonical command turn: ${reason}. Retrying in ${Math.ceil(commandRetryDelayMs / 1_000)}s.`, "warning");
				}
			}
		}
		if (!commandDeliveryFailed) {
			if (pkg.cursorV2) active.cursor = pkg.cursorV2;
			if (pkg.ownerBundle) active.advisoryCarry = [];
		}
		const dispatches = (payload as { dispatches?: unknown[] } | null)?.dispatches ?? [];
		for (const dispatch of dispatches) enqueueAutomationRun(active, token, dispatch, ctx);
		if (pkg.dispatchCursor) active.dispatchCursor = pkg.dispatchCursor;
		if (commandRetryDelayMs > 0 && pump === active && !active.stop) {
			await new Promise((resolve) => setTimeout(resolve, commandRetryDelayMs));
			if (pump === active && !active.stop) signalWake(active);
		}
	}
}

interface BondOutcome {
	ok: boolean;
	error?: string;
	errorKind?: "auth" | "api";
	codename?: string;
	attached?: boolean;
}

/**
 * Register/revive the bond and start the pump. Shared by /devspec.remote and
 * the auto-bond on session_start. Never throws.
 */
async function bondNow(ctx: ExtensionContext, sessionArg?: string): Promise<BondOutcome> {
	const resolved = await resolveToken();
	if (!resolved) return { ok: false, error: "Not connected to DevSpec — /devspec.login first.", errorKind: "auth" };

	// Bond key = this pi conversation's id (never cwd/shell). The server
	// revives the same (owner, local_id) bond within its 24h window.
	const localId = ctx.sessionManager.getSessionId();
	let regText: string;
	let d: Record<string, unknown>;
	let connectionCapability: string;
	try {
		const regRaw = await callDevspec(resolved.token, "register_connection", {
			local_id: localId,
			agent_name: AGENT_NAME,
			machine_hostname: hostname(),
			cwd: ctx.cwd,
			connection_capability_version: 1,
		}, { cwd: ctx.cwd, lane: "pump" });
		const reg = unwrapMcpResult(regRaw);
		if (reg.isError) return { ok: false, error: `register failed: ${reg.text}`, errorKind: "api" };
		regText = reg.text;
		d = (reg.details ?? {}) as Record<string, unknown>;
		const negotiatedCapability = connectionCapabilityFromResult(regRaw);
		if (!negotiatedCapability) throw new Error("register_connection did not return negotiated connection capability v1 metadata");
		connectionCapability = negotiatedCapability;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), errorKind: "api" };
	}
	const connectionId = (d.connection_id ?? d.connectionId) as string | undefined;
	if (!connectionId) return { ok: false, error: `register returned no connection id: ${regText.slice(0, 200)}`, errorKind: "api" };

	const bond: BondState = {
		connectionId,
		projectId: typeof d.project_id === "string" ? d.project_id : undefined,
		connectionCapability,
		codename: typeof d.codename === "string" ? d.codename : undefined,
		sessionId: (d.session_id as string | undefined) ?? undefined,
		attachedAt: typeof d.attached_at === "string" ? d.attached_at : undefined,
		speechAttachmentId: typeof d.speech_attachment_id === "string" ? d.speech_attachment_id : undefined,
		instructions: {
			owner_custom_instructions: d.owner_custom_instructions as string | undefined,
			owner_agent_rules: d.owner_agent_rules as string | undefined,
			project_custom_instructions: d.project_custom_instructions as string | undefined,
			project_agent_rules: d.project_agent_rules as string | undefined,
		},
	};

	let attached = false;
	if (sessionArg) {
		try {
			const attRaw = await callDevspec(resolved.token, "attach_connection", {
				connection_id: connectionId,
				session_id: sessionArg,
			}, { cwd: ctx.cwd, lane: "pump" });
			const att = unwrapMcpResult(attRaw);
			if (att.isError) {
				notify(ctx, `DevSpec remote: bonded but attach failed: ${att.text}`, "warning");
			} else {
				const ad = (att.details ?? {}) as Record<string, unknown>;
				bond.sessionId = (ad.session_id as string | undefined) ?? bond.sessionId;
				bond.attachedAt = typeof ad.attached_at === "string" ? ad.attached_at : undefined;
				bond.speechAttachmentId = typeof ad.speech_attachment_id === "string" ? ad.speech_attachment_id : undefined;
				attached = true;
			}
		} catch (err) {
			notify(ctx, `DevSpec remote: bonded but attach failed: ${err instanceof Error ? err.message : err}`, "warning");
		}
	}

	setBond(bond);
	const generation = nextPumpGeneration++;
	const connectionIdentity: RemoteConnectionIdentity = {
		connection_id: connectionId,
		agent_name: AGENT_NAME,
		codename: bond.codename ?? null,
		label: bond.codename ? `${AGENT_NAME} · ${bond.codename}` : AGENT_NAME,
	};
	const systemNoticeKey = bindSystemNoticeState({
		piSessionId: localId,
		connectionId,
		pumpGeneration: generation,
	});
	pump = {
		generation,
		bond,
		connectionIdentity,
		systemNoticeKey,
		busy: false,
		stop: false,
		errors: 0,
		synced: false,
		seenOwnerCommands: new SeenOwnerCommands(),
		advisoryCarry: [],
		pushAttempts: 0,
		pushGenerationFence: new PushChannelGenerationFence(),
		runtimeOccupancy: new RuntimeOccupancyFence(),
		idleBoundaryWake: new BusyWakeLatch(),
		localSessionId: localId,
		pendingInteractionStarts: new Map(),
		pendingInteractionReleases: new Map(),
		wakeGate: new WakeGenerationGate(),
		automationQueue: new DeliveryQueue(),
		automationRetryAttempts: new Map(),
		automationRetryTimers: new Map(),
		attachmentRetryAttempts: new Map(),
		awarenessKey: localId,
		activePlanTail: "",
		pendingActivePlanTail: "",
		sessionPollsTail: "",
		pendingSessionPollsTail: "",
		stillToDiscussTail: "",
		pendingStillToDiscussTail: "",
	};
	pi_setPlanToolActive(Boolean(bond.sessionId));
	pi_setQuestionToolActive(Boolean(bond.sessionId && bond.connectionCapability));
	pi_setPollToolActive(Boolean(bond.sessionId && bond.connectionCapability));
	preemptOwnerCached = (await loadSettings()).preemptOwner;
	setRemoteStatus(ctx);
	// Initial runtime identity must be visible before this agent has completed a
	// turn. The first long-poll below carries this report with its heartbeat.
	latestAgentStats = runtimeAgentStats(ctx);
	// Revive/register can already be attached. Refresh title/owner display
	// identity; canonical ingress remains the only model-context source.
	if (bond.sessionId) void enrichBondWithSession(bond.sessionId);
	if (pump) resumePersistedInteractionEvents(pump, ctx);
	void pumpLoop(ctx);
	return { ok: true, codename: bond.codename, attached };
}

// Late-bound so the loop can reference the ExtensionAPI closure.
let pi_systemNoticeSend: (message: string, details: { notices: unknown[] }) => void = () => {};
let pi_appendInteractionEntry: (
	state: "observed" | "applied" | "acknowledged",
	details: InteractionEventApplicationDetails,
) => void = () => {};
let pi_sendInteractionContinuation: (
	active: PumpState,
	message: string,
	details: InteractionEventApplicationDetails,
	run: ExactInteractionRun,
) => void = () => {};
let pi_send: (
	message: string,
	mode?: "now" | "steer" | "followUp",
	commandTurnId?: string,
	commandMessageId?: string,
	canonicalQueueItem?: CanonicalQueueItem,
) => void = () => {};
let pi_abort: () => void = () => {};
let pi_compact: () => void = () => {};
let pi_reload: () => Promise<void> = async () => {};
let pi_setThinking: (level: string) => string = () => { throw new Error("setThinkingLevel is not available"); };
let pi_setModel: (modelId: string) => Promise<boolean> = async () => false;
let pi_setPlanToolActive: (enabled: boolean) => void = () => {};
let pi_setQuestionToolActive: (enabled: boolean) => void = () => {};
let pi_setPollToolActive: (enabled: boolean) => void = () => {};

/**
 * Refresh display identity only. Conversational/model context is accepted
 * exclusively from negotiated canonical ingress; transcript reads never
 * become command-turn context or trigger model recovery.
 */
async function enrichBondWithSession(sessionId: string): Promise<void> {
	const resolved = await resolveToken();
	if (!resolved) return;
	try {
		const raw = await callDevspec(resolved.token, "get_session_transcript", { session_id: sessionId }, { lane: "pump" });
		const unwrapped = unwrapMcpResult(raw);
		if (unwrapped.isError) {
			debug("session enrich fetch failed", { resultChars: unwrapped.text.length });
			return;
		}
		const shaped = shapeTranscript(sessionId, unwrapped.details);
		const active = pump;
		// The attachment may have moved on (or detached) while the fetch flew.
		if (!active?.bond || active.bond.sessionId !== sessionId) return;
		const next: BondState = {
			...active.bond,
			sessionTitle: isRealSessionTitle(shaped.title)
				? shaped.title
				: isRealSessionTitle(active.bond.sessionTitle)
					? active.bond.sessionTitle
					: undefined,
			ownerName: shaped.ownerName ?? active.bond.ownerName,
		};
		active.bond = next;
		setBond(next);
		if (!isRealSessionTitle(next.sessionTitle)) {
			const preview = firstTextPreview((unwrapped.details as { messages?: unknown } | null)?.messages);
			if (preview) setSessionPreview(preview);
		}
		setRemoteStatus(lastCtx);
		debug("session enriched", { titlePresent: Boolean(shaped.title), ownerPresent: Boolean(shaped.ownerName), tail: 0, agenda: 0, attachContext: false });
	} catch (err) {
		debug("session enrich error", { errorPresent: Boolean(err) });
	}
}

export default function (pi: ExtensionAPI) {
	rememberExtensionRunner();
	const subagentFleet = new SubagentFleetClient(pi.events);
	const reconcileSubagentFleetOwnership = async (
		trackedTurn: TurnState,
		attempts = 2,
	): Promise<"active" | "idle" | "unknown" | "stale"> => {
		const expectedRevision = trackedTurn.revision;
		let snapshot: SubagentFleetSnapshot | null = null;
		for (let attempt = 0; attempt < attempts && !snapshot; attempt += 1) {
			snapshot = await subagentFleet.refreshFresh();
			if (turn !== trackedTurn || trackedTurn.revision !== expectedRevision) return "stale";
		}
		if (!snapshot) return "unknown";
		if (snapshot.totalActive > 0) {
			trackedTurn.tracker.noteBackgroundTask(SUBAGENT_FLEET_TASK_ID);
			return "active";
		}
		trackedTurn.tracker.resolveBackgroundTask(SUBAGENT_FLEET_TASK_ID);
		return "idle";
	};
	const refreshSubagentFleet = (toolCallId: string, trackedTurn: TurnState | null) => {
		if (!trackedTurn) return;
		void subagentFleet.refresh().then((snapshot) => {
			// A late optional-RPC reply must never mutate a later delivery segment.
			if (!snapshot || turn !== trackedTurn) return;
			if (trackedTurn.trail.applySubagentFleet(toolCallId, snapshot)) trackedTurn.trailDelivery.markDirty();
		});
	};
	pi_appendInteractionEntry = (state, details) => {
		pi.appendEntry(INTERACTION_EVENT_JOURNAL_TYPE, interactionEventJournalEntry(state, details));
	};
	pi_sendInteractionContinuation = (active, message, details, run) => {
		// Exact server activity already exists. Only now may Pi persist/inject the
		// dedicated custom continuation; agent_start never performs authority lookup.
		if (startingInteractionRun && startingInteractionRun !== run) {
			throw new Error("An interaction continuation is already starting.");
		}
		startingInteractionRun = run;
		try {
			pi.sendMessage({
				customType: interactionEventCustomType(details.event),
				content: message,
				display: true,
				details,
			}, { triggerTurn: true });
		} catch (error) {
			startingInteractionRun = null;
			throw error;
		}
	};
	pi_systemNoticeSend = (message, details) => {
		// Called only after the pump proves idle; triggerTurn starts a fresh
		// harness-attributed run from this model-visible custom message.
		systemNoticeTurnPending = true;
		try {
			pi.sendMessage({
				customType: SYSTEM_NOTICE_CUSTOM_TYPE,
				content: message,
				display: true,
				details,
			}, { triggerTurn: true });
		} catch (error) {
			systemNoticeTurnPending = false;
			throw error;
		}
	};
	pi_send = (message, mode = "now", commandTurnId, commandMessageId, canonicalQueueItem) => {
		commandTurnBindings.remember(message, commandTurnId, commandMessageId, canonicalQueueItem);
		try {
			// Exactly one Pi queue item. Delegated scope is already in its visible
			// canonical framing; idle turns additionally receive hidden typed data
			// when Pi emits before_agent_start.
			if (mode === "steer") pi.sendUserMessage(message, { deliverAs: "steer" });
			else if (mode === "followUp") pi.sendUserMessage(message, { deliverAs: "followUp" });
			else pi.sendUserMessage(message);
		} catch (error) {
			commandTurnBindings.forget(message, commandTurnId, commandMessageId);
			throw error;
		}
	};
	pi_abort = () => {
		if (lastCtx && !lastCtx.isIdle()) lastCtx.abort();
	};
	pi_compact = () => {
		lastCtx?.compact?.({});
	};
	pi_reload = async () => {
		await reloadWithContext(commandReloadContext() ?? (lastCtx as { reload?: () => Promise<void> } | null));
	};
	pi_setThinking = (level) => {
		if (typeof pi.setThinkingLevel !== "function") throw new Error("setThinkingLevel is not available");
		if (typeof pi.getThinkingLevel !== "function") throw new Error("getThinkingLevel is not available");
		pi.setThinkingLevel(level as ModelThinkingLevel);
		return pi.getThinkingLevel();
	};
	pi_setModel = async (modelId) => {
		const slash = modelId.indexOf("/");
		if (slash === -1) return false;
		const provider = modelId.slice(0, slash);
		const id = modelId.slice(slash + 1);
		const model = lastCtx?.modelRegistry?.find?.(provider, id);
		if (!model) return false;
		return Boolean(await pi.setModel?.(model));
	};
	pi_setPlanToolActive = (enabled) => {
		const next = withPlanToolActive(pi.getActiveTools(), enabled);
		if (next.join("\0") !== pi.getActiveTools().join("\0")) pi.setActiveTools(next);
	};
	pi_setQuestionToolActive = (enabled) => {
		const next = withDirectedQuestionToolActive(pi.getActiveTools(), enabled);
		if (next.join("\0") !== pi.getActiveTools().join("\0")) pi.setActiveTools(next);
	};
	pi_setPollToolActive = (enabled) => {
		const next = withPollToolActive(pi.getActiveTools(), enabled);
		if (next.join("\0") !== pi.getActiveTools().join("\0")) pi.setActiveTools(next);
	};

	pi.on("model_select", (_event, ctx) => {
		scheduleRuntimeStamp(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		scheduleRuntimeStamp(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastCtx = ctx;
		const active = pump;
		const newInteractionRun = startingInteractionRun;
		const continuedInteractionRun = turn?.interaction ?? (active ? activeInteractionRun(active) : undefined);
		const requestedKind = newInteractionRun ? "interaction" : systemNoticeTurnPending ? "system_notice" : "owner";
		const occupancy = active?.runtimeOccupancy.begin(requestedKind) ?? null;
		// The occupancy, not the one-shot pending flag, owns run classification
		// across Pi retry/compaction agent_start events.
		const completionNeutral = occupancy?.kind === "system_notice";
		const activityPolicy = remoteRunActivityPolicy(completionNeutral);
		const interactionRun = newInteractionRun ?? (occupancy?.kind === "interaction" ? continuedInteractionRun : undefined);
		systemNoticeRunActive = completionNeutral;

		if (newInteractionRun) {
			startingInteractionRun = null;
			if (!active || newInteractionRun.active !== active || newInteractionRun.application === "released" ||
				!interactionAuthorityCurrent(newInteractionRun.authority)) {
				active?.runtimeOccupancy.finish(occupancy);
				debug("interaction authority revoked before agent start");
				ctx.abort();
				await releaseInteractionBeforePersistence(newInteractionRun, "interaction_authority_changed_before_agent_start");
				return;
			}
			active.busy = true;
		} else if (occupancy?.kind === "interaction" && (!active || !continuedInteractionRun ||
			!interactionAuthorityCurrent(continuedInteractionRun.authority))) {
			// A retry start after detach/replacement cannot fall through to generic
			// owner activity under the new attachment.
			debug("interaction authority revoked before agent start");
			ctx.abort();
			if (active) revokeInteractionForAttachmentChange(active, ctx);
			return;
		} else if (active && activityPolicy.reportPresence) {
			active.busy = true;
			void beatBusy(true);
		}

		// The run begins — the delivery unit. Turn state is born here (or on
		// the first attached turn_start after a mid-run attach), never per round.
		ensureTurn();
		if (turn && completionNeutral) turn.completionNeutral = true;
		if (turn && newInteractionRun) {
			turn.interaction = newInteractionRun;
			turn.commandTurnId = undefined;
			turn.commandMessageId = undefined;
			turn.lastInteractionKeepaliveAt = Date.now();
		}
		if (turn) {
			turn.occupancy = occupancy ?? undefined;
			turn.revision = nextTurnRevision++;
			turn.receiptBatch.reset(turn.revision);
		}
	});
	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		const activeAtSettle = pump;
		const occupancyAtSettle = activeAtSettle?.runtimeOccupancy.capture() ?? null;
		const turnAtSettle = turn;
		const revisionAtSettle = turnAtSettle?.revision;
		await Promise.all([...pendingInteractionConfirmations].map((confirmation) =>
			attemptInteractionPersistenceConfirmation(confirmation, true)));
		// The parent model may be locally finished while async children still own
		// the user-visible job. Reconcile pi-subagents' documented current-session
		// fleet before deciding whether this command attempt is terminal. The DTO
		// exposes only a bounded aggregate here—no child ids, prompts, or paths.
		const settlingTurn = turnAtSettle;
		if (settlingTurn?.tracker.userKind && settlingTurn.tracker.userKind !== "harness") {
			const reconciliation = await reconcileSubagentFleetOwnership(settlingTurn);
			// Pi may accept a newer command while an extension settle handler awaits.
			// The stale callback owns nothing in that newer segment.
			if (reconciliation === "stale") return;
		}
		// Awaited reconciliation/persistence may overlap a newer run. The older
		// callback must not clear its occupancy, busy state, turn, or exact attempt.
		if (turn !== settlingTurn || settlingTurn?.revision !== revisionAtSettle ||
			(activeAtSettle && !activeAtSettle.runtimeOccupancy.finish(occupancyAtSettle))) return;
		// Capture after fleet reconciliation and before settleTurn releases the
		// segment; terminal fallback must never complete a newer owner command.
		const commandTurnId = settlingTurn?.commandTurnId;
		const commandMessageId = settlingTurn?.commandMessageId;
		const commandTurnUnbound = settlingTurn ? isCommandTurnUnbound(settlingTurn) : false;
		const interactionRun = settlingTurn?.interaction;
		const completionNeutral = occupancyAtSettle?.kind === "system_notice" || settlingTurn?.completionNeutral === true;
		const activityPolicy = remoteRunActivityPolicy(completionNeutral);
		// Settle telemetry FIRST so the idle/parked heartbeat and answer post carry
		// this turn's report, not the previous one's.
		const agentStats = settleTelemetry();
		// A settled parent model run can still own automatic background work.
		// Keep the pump authoritative Working signal alive until the final owned
		// continuation settles; otherwise polls broadcast false and close the
		// durable attempt while an async child is visibly still running.
		// Presence follows outstanding background work (owner direction
		// 2026-09-17 PM): with owned bg tasks still pending the agent is still
		// working — the run settled but the job has not. The wake of the last
		// task's completion re-runs this with an empty set and clears Working.
		// This parks PRESENCE ONLY: the answer already posted above regardless
		// (759f2818), so a long-running task can never hold speech hostage.
		const keepWorking = !completionNeutral && pendingBackgroundTaskIds.size > 0;
		if (pump && activityPolicy.reportPresence) {
			pump.busy = keepWorking;
			if (!interactionRun) void beatBusy(keepWorking, agentStats);
			const trueIdle = !keepWorking && !pump.runtimeOccupancy.isBusy() && ctx.isIdle();
			if (pump.idleBoundaryWake.consumeAtIdle(trueIdle)) signalWake(pump);
		} else if (pump) {
			const trueIdle = !pump.busy && !pump.runtimeOccupancy.isBusy() && ctx.isIdle();
			if (pump.idleBoundaryWake.consumeAtIdle(trueIdle)) signalWake(pump);
		}
		if (!completionNeutral && untitledAttached() && pump?.bond.sessionId) {
			scheduleTitleRefresh(pump.bond.sessionId);
		}
		trackTerminalPost((async () => {
			const posted = await settleTurn(agentStats, true);
			// No complete_turn post landed (aborted/empty turn, or the post
			// failed) — close the exact activity honestly. Outstanding owned
			// background work is the one exception: the attempt stays open so
			// Working persists until the last completion wake settles.
			if (!posted && activityPolicy.reportCompletion && pendingBackgroundTaskIds.size === 0 && (settlingTurn?.canPost() ?? pump === activeAtSettle)) {
				await reportComplete("turn_end", commandTurnId, commandMessageId, commandTurnUnbound, interactionIdentity(interactionRun));
			}
			if (interactionRun) {
				interactionRunsByEvent.delete(interactionRun.details.event.event_id);
				if (startingInteractionRun === interactionRun) startingInteractionRun = null;
			}
		})());
		// Local telemetry above is safe; from here onward the notice run is over.
		// Busy notices may wake only after final settlement proves both Pi and pump
		// idle. The next custom run remains unbound from every owner generation.
		if (completionNeutral) systemNoticeTurnPending = false;
		systemNoticeRunActive = false;
		if (pump && !pump.busy && ctx.isIdle()) {
			try { deliverQueuedSystemNotices(pump, ctx); } catch (error) {
				debug("system notice settle drain failed", { errorPresent: Boolean(error) });
			}
		}
	});

	// ---- Turn lifecycle events (mechanical trail + final answer) ------------

	pi.on("context", async (_event, ctx) => {
		lastCtx = ctx;
		ensureTurn();
		const t = turn;
		if (!t) return;
		const prepared = prepareAssistantSpeech(t);
		if (t.tracker.shouldMirrorPrompt && t.tracker.userText) {
			t.tracker.shouldMirrorPrompt = false;
			await postToSession(t.tracker.userText, { turnKind: "local_prompt", localTurn: true, isCurrent: t.canPost });
		}
		await prepared;
	});

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
		// Per-LLM-round event — the state must SURVIVE it, never be recreated
		// (cc9e8c43). Lazily covers a mid-run attach too.
		ensureTurn();
		if (turn) turn.receiptBatch.reset(turn.revision);
	});

	// Leftover bg receipts arrive as custom_message (customType
	// background-task-notification) and may then replay the last typed prompt
	// as a user message. Stamp harness origin here so that replay cannot
	// remirror (item 56b9a3b4). Typed /commands never take this path.
	pi.on("before_agent_start", (event, ctx) => {
		const canonicalQueueItem = commandTurnBindings.peek(event.prompt)?.canonicalQueueItem;
		const active = pump;
		// A queued owner turn may start after a newer projection arrived. Bind its
		// immutable canonical prefix to the latest validated tail exactly once.
		const planTail = activePlanTailForDelivery(
			Boolean(canonicalQueueItem),
			active?.activePlanTail ?? "",
			active?.pendingActivePlanTail ?? "",
		);
		if (active && planTail) {
			active.pendingActivePlanTail = "";
			if (planTail === ACTIVE_PLAN_CLEAR_TOMBSTONE) clearActivePlanAwareness(active.awarenessKey);
			else if (active.activePlanTail && planTail === active.activePlanTail) {
				markActivePlanAwareness(active.awarenessKey, planTail);
			}
		}
		const pollTail = activePlanTailForDelivery(
			Boolean(canonicalQueueItem),
			active?.sessionPollsTail ?? "",
			active?.pendingSessionPollsTail ?? "",
		);
		if (active && pollTail) active.pendingSessionPollsTail = "";
		const discussTail = activePlanTailForDelivery(
			Boolean(canonicalQueueItem),
			active?.stillToDiscussTail ?? "",
			active?.pendingStillToDiscussTail ?? "",
		);
		if (active && discussTail) active.pendingStillToDiscussTail = "";
		const hiddenContent = appendActivePlanTail(
			appendActivePlanTail(
				appendActivePlanTail(canonicalQueueItem?.hiddenContent ?? "", planTail),
				pollTail,
			),
			discussTail,
		);
		const injected = hiddenContent ? {
			message: {
				customType: canonicalQueueItem ? "devspec-remote-ingress-context" : "devspec-active-session-plans",
				content: hiddenContent,
				display: false,
				...(canonicalQueueItem ? { details: canonicalQueueItem.details } : {}),
			},
		} : undefined;
		ensureTurn();
		if (!turn) return injected;
		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf || leaf.type !== "custom_message") return injected;
		const customType = leaf.customType;
		const content = typeof leaf.content === "string"
			? leaf.content
			: Array.isArray(leaf.content)
				? leaf.content
					.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
					.map((b) => b.text)
					.join("\n")
				: "";
		if (!isHarnessOrigin(content, customType)) return injected;
		// Context/harness may wake the model. Do not close the live owner
		// turn as complete (item 60cf5f00). A terminal task notification
		// resolves only its matching owner-started task (item 15cb0983).
		const details = (leaf as { details?: unknown }).details;
		turn.tracker.userMessage(content, {
			customType,
			backgroundTaskId: backgroundTaskNotificationId(content, details),
		});
		// A completion wake rides the parked command turn it continues — an
		// unbound wake post while a command turn is parked is fenced as
		// stale_generation server-side and drops silently (759f2818 live repro).
		adoptParkedCommandIdentity(turn, turn.tracker.userKind);
		return injected;
	});

	pi.on("message_start", async (event, ctx) => {
		lastCtx = ctx;
		const msg = event.message as { role?: string; customType?: string; details?: unknown } | undefined;
		const customType = typeof msg?.customType === "string" ? msg.customType : null;
		if (customType === SYSTEM_NOTICE_CUSTOM_TYPE) systemNoticeTurnPending = false;
		if (!turn) return;
		const text = extractText(event.message);
		const harness = isHarnessOrigin(text, customType);
		if (msg?.role === "user" || msg?.role === "custom" || harness) {
			const isRealUserMessage = msg?.role === "user" && !harness;
			if (customType === SYSTEM_NOTICE_CUSTOM_TYPE) turn.completionNeutral = true;
			const activityTransition = isRealUserMessage
				? transitionToRealUserActivity({
					systemNoticeRunActive,
					segmentCompletionNeutral: turn.completionNeutral,
				})
				: null;
			if (activityTransition?.previousCompletionNeutral) turn.completionNeutral = true;
			const incomingCommand = isRealUserMessage ? commandTurnBindings.take(text) : undefined;
			// A mid-run OWNER/LOCAL user message is a delivery boundary
			// (b1fb756a). Context/harness injections stay on this turn so
			// they cannot complete_turn a working sentence (item 60cf5f00).
			// Notice-to-user always gets a fresh segment even before assistant text:
			// local input must not be mistaken for a replay of the harness message.
			if (isRealUserMessage && (isDeliveryBoundary(turn.tracker) || activityTransition?.beginBusyPresence)) {
				splitTurnAtBoundary();
			} else if (isRealUserMessage && (turn.commandMessageId || isCommandTurnUnbound(turn))) {
				// A pure tool-call/no-text segment is not a display boundary, but its
				// activity identity still must terminate before the new user segment
				// replaces it (notably a preemption-timeout steer). The captured prior
				// policy prevents a neutral notice from completing an owner attempt.
				const previousTurn = turn;
				const previousPolicy = activityTransition?.previousPolicy ??
					remoteRunActivityPolicy(previousTurn.completionNeutral);
				if (previousPolicy.reportCompletion) {
					trackTerminalPost(reportComplete(
						"turn_end",
						previousTurn.commandTurnId,
						previousTurn.commandMessageId,
						isCommandTurnUnbound(previousTurn),
						interactionIdentity(previousTurn.interaction),
					).then(() => undefined));
				}
			}
			// Atomically leave notice neutrality before starting the real segment.
			// Bind immutable command identity (or clear it for local input), then
			// begin normal busy presence exactly once for this same-run transition.
			if (isRealUserMessage) {
				// A genuine user follow-up promotes the one run-level occupancy. Low-level
				// retry starts never do this merely because the pending flag was cleared.
				if (pump && turn.occupancy?.kind === "system_notice") {
					const promoted = pump.runtimeOccupancy.promote(turn.occupancy, "owner");
					if (promoted) {
						turn.occupancy = promoted;
						turn.revision = nextTurnRevision++;
					}
				}
				systemNoticeTurnPending = false;
				systemNoticeRunActive = activityTransition?.nextSystemNoticeRunActive ?? false;
				turn.completionNeutral = activityTransition?.nextCompletionNeutral ?? false;
				turn.revision = nextTurnRevision++;
				turn.receiptBatch.reset(turn.revision);
				turn.commandTurnId = incomingCommand?.turnId;
				turn.commandMessageId = incomingCommand?.commandMessageId;
				// The newest bound command owns the open server turn; completion
				// wakes adopt this identity until a complete_turn closes it (759f2818).
				if (incomingCommand?.turnId && incomingCommand?.commandMessageId) {
					activeCommandTurnIdentity = { turnId: incomingCommand.turnId, commandMessageId: incomingCommand.commandMessageId };
				}
				turn.interaction = undefined;
				turn.lastInteractionKeepaliveAt = undefined;
				turn.speechBinding = undefined;
				turn.speechScopeCaptured = false;
				turn.tracker.userMessage(text, { customType });
				if (activityTransition?.beginBusyPresence && pump) {
					pump.busy = true;
					void beatBusy(true);
				}
			} else {
				turn.tracker.userMessage(text, {
					customType,
					backgroundTaskId: harness ? backgroundTaskNotificationId(text, msg?.details) : null,
				});
				if (harness) adoptParkedCommandIdentity(turn, turn.tracker.userKind);
			}
			// Idle triggerTurn custom messages bypass before_agent_start in Pi. The
			// awaited message_start event is the earliest common point before the
			// completion-wake model can author its recap. Fleet reconciliation is
			// side-effect only now: wake speech is never gated on background state
			// (759f2818), so a transient status miss cannot swallow anything.
			if (harness && isSubagentAsyncNotification(text, customType)) {
				await reconcileSubagentFleetOwnership(turn);
			}
		}
		// A new assistant message = a new LLM round. If the previous close was
		// a finished text-only answer, that bubble is done — split it off
		// (complete_turn=false) so this round's thinking/tools open a new trail.
		else if (msg?.role === "assistant") {
			if (!turn.speechManaged && isClosedAnswerBoundary(turn.tracker)) splitTurnAtBoundary("closed_answer", false);
			turn.trail.beginAssistantMessage();
		}
	});

	pi.on("message_update", (event, ctx) => {
		lastCtx = ctx;
		if (!turn) return;
		const msg = event.message as { role?: string } | undefined;
		if (msg?.role !== "assistant") return;
		const { text, thinking } = extractAssistantParts(event.message);
		turn.trail.setThinking(thinking);
		turn.trail.setText(text);
		turn.trailDelivery.markDirty();
	});

	pi.on("message_end", (event, ctx) => {
		lastCtx = ctx;
		// Telemetry accumulates for EVERY assistant message while bonded —
		// including turns the trail skips (unattached/local), so sessionless
		// agents still report on the idle heartbeat.
		const msg = event.message as ({ role?: string; usage?: MessageUsage } & InteractionEventMessageEndLike) | undefined;
		if (msg?.role === "custom" && (msg.customType === INTERACTION_EVENT_CUSTOM_TYPE || msg.customType === QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE)) {
			// Pi 0.84 persists this finalized custom message immediately after all
			// message_end extension handlers return. A later task verifies the exact
			// JSONL row before the controller makes ACK eligible.
			confirmInteractionMessageAfterPersistence(msg, ctx);
		}
		if (pump && msg?.role === "assistant") {
			telemetry.addMessageUsage(msg.usage);
		}
		if (!turn) { debug("message_end: no turn"); return; }
		if (msg?.role === "assistant") {
			deliverAssistantSpeech(turn, event.message, (type, data) => pi.appendEntry(type, data));
			// Feed the trail from the finalized message too: message_update
			// streams live in the TUI, but headless modes (RPC/print/SDK) emit
			// no deltas — this keeps the trail complete there (flushed at
			// settle) without double-posting in the TUI (cumulative snapshots).
			const { text, thinking, hasToolCalls, stopReason } = extractAssistantParts(event.message);
			turn.receiptBatch.noteAssistantText(text, turn.revision);
			turn.trail.setThinking(thinking);
			turn.trail.setText(text);
			// Round sealed: the next deltas open fresh entries (cc9e8c43).
			turn.trail.beginAssistantMessage();
			turn.trailDelivery.markDirty();
			// Every user-facing text on a tool-carrying message is its own bubble
			// (owner direction 2026-09-17 — terminal parity), not just the first.
			const speechSplit = shouldSplitSpeech(turn.tracker, { text, hasToolCalls });
			const classification = turn.tracker.assistantFinal(text, speechSplit || isClosedAnswer({
				text,
				hasToolCalls,
				stopReason,
			}));
			debug("speech", { candidate: classification === "stored", process: classification === "process", split: speechSplit, chars: text.trim().length, tools: hasToolCalls, closedStop: stopReason === "stop" });
			if (!turn.speechManaged && speechSplit) splitTurnAtBoundary("speech", false);
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		lastCtx = ctx;
		noteVerbStart(event.toolCallId, event.toolName, event.args);
		paintStatus(ctx);
		if (!turn) return;
		const trackedTurn = turn;
		const revision = trackedTurn.revision;
		const potentialReceipt = isPotentialDirectedQuestionCreate(event.toolName, event.args);
		// Mark synchronously before the first await. Timer ticks from this point on
		// cannot open a pointer that overtakes canonical receipt takeover.
		trackedTurn.receiptBatch.start(event.toolCallId, revision, potentialReceipt);
		trackedTurn.trail.toolStart(event.toolCallId, event.toolName, event.args);
		trackedTurn.trailDelivery.markDirty();
		if (event.toolName === "subagent_wait") refreshSubagentFleet(event.toolCallId, trackedTurn);
		if (!potentialReceipt) return;

		const activeAtStart = pump;
		const authority = activeAtStart
			? capturePumpAuthority({ generation: activeAtStart.generation, connectionId: activeAtStart.bond.connectionId })
			: null;
		await trackedTurn.trailPostFence.drain();
		const current = Boolean(activeAtStart && authority && turn === trackedTurn &&
			trackedTurn.revision === revision && pump === activeAtStart && !activeAtStart.stop &&
			isPumpAuthorityCurrent(authority, {
				generation: activeAtStart.generation,
				connectionId: activeAtStart.bond.connectionId,
			}));
		if (!current) {
			trackedTurn.receiptBatch.finish(event.toolCallId, {
				success: false,
				terminatingReceipt: false,
			}, revision);
			debug("stale tool receipt abort");
			ctx.abort();
		}
	});

	pi.on("tool_execution_update", (event, ctx) => {
		lastCtx = ctx;
		if (!turn) return;
		turn.trail.toolUpdate(event.toolCallId, event.partialResult);
		turn.trailDelivery.markDirty();
		// Reuse the host tool's existing progress cadence; the client deduplicates
		// overlapping requests, so this creates no independent polling loop.
		if (event.toolName === "subagent_wait") refreshSubagentFleet(event.toolCallId, turn);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		lastCtx = ctx;
		noteVerbEnd(event.toolCallId);
		paintStatus(ctx);
		if (!turn) return;
		// Register ownership only from a successful launch receipt that promises
		// both terminal notification and automatic wake. tool_execution_start is
		// too early: a failed launch would otherwise park the turn forever.
		const backgroundTaskId = automaticBackgroundTaskId(event.toolName, event.result, event.isError);
		if (backgroundTaskId) turn.tracker.noteBackgroundTask(backgroundTaskId);
		const terminatingReceipt = isReceiptOwningDirectedQuestionCreate(
			event.toolName,
			event.result,
			event.isError,
		);
		turn.receiptBatch.finish(event.toolCallId, {
			success: !event.isError,
			terminatingReceipt,
		}, turn.revision);
		turn.trail.toolEnd(event.toolCallId, event.toolName, !event.isError, event.result);
		turn.trailDelivery.markDirty();
	});

	pi.on("session_shutdown", async () => {
		subagentFleet.dispose();
		for (const confirmation of pendingInteractionConfirmations) {
			interactionDelivery.abandonMessage(confirmation.message);
			if (confirmation.run.application === "starting") {
				await releaseInteractionBeforePersistence(confirmation.run, "interaction_shutdown_before_persistence");
			}
		}
		pendingInteractionConfirmations.clear();
		if (startingInteractionRun?.application === "starting") {
			await releaseInteractionBeforePersistence(startingInteractionRun, "interaction_shutdown_before_persistence");
		}
		startingInteractionRun = null;
		if (runtimeStampTimer) {
			clearTimeout(runtimeStampTimer);
			runtimeStampTimer = null;
		}
		// Close any open trail / Working row BEFORE tearing the pump down
		// (item 781886cf). A crash mid-turn must not leave empty bubbles.
		const openTurn = turn;
		if (openTurn?.interval) clearInterval(openTurn.interval);
		openTurn?.trailPostFence.invalidate();
		turn = null;
		systemNoticeTurnPending = false;
		systemNoticeRunActive = false;
		const active = pump;
		if (!active) return;
		if (active.interactionRetryTimer) clearTimeout(active.interactionRetryTimer);
		active.interactionRetryTimer = undefined;
		active.pendingInteractionStarts.clear();
		active.pendingInteractionReleases.clear();
		active.closing = true;
		active.stop = true;
		revokeSystemNoticeState(active.systemNoticeKey);
		active.pushGenerationFence.invalidate();
		active.pushAbort?.abort();
		if (active.pushReconnectTimer) clearTimeout(active.pushReconnectTimer);
		active.wakeGate.cancel();
		// Let detached boundary/settle posts finish while pump authority still
		// exists, so their failure fallback can report the exact segment.
		if (pendingTerminalPosts.size > 0) {
			await Promise.allSettled([...pendingTerminalPosts]);
		}
		if (openTurn) await openTurn.trailPostFence.drain();
		// Close the activity attempt while the bond is still on the wire.
		if (openTurn && remoteRunActivityPolicy(openTurn.completionNeutral).reportCompletion) {
			try { await reportComplete("process_exit", openTurn.commandTurnId, openTurn.commandMessageId, isCommandTurnUnbound(openTurn), interactionIdentity(openTurn.interaction)); } catch { /* best-effort */ }
		}
		pump = null;
		commandTurnBindings.clear();
		pendingBackgroundTaskIds.clear();
		activeCommandTurnIdentity = null;
		setBond(null);
		pi_setPlanToolActive(false);
		pi_setQuestionToolActive(false);
		pi_setPollToolActive(false);
		resetStatus();
		paintStatus(lastCtx);

		// Going-away stamp (item 8b0c162b): tell DevSpec immediately rather than
		// leaving the UI to age the bond out of the 90s liveness window. NON-STICKY
		// (no end_reason — this is a process exit, not a deliberate remote-stop; the
		// bond revives on the next register) and GUARDED (observed_alive_until) so a
		// same-bond rebond that already re-stamped presence is never clobbered.
		// Best-effort: the server's socket-close clear is the guaranteed backstop.
		const resolved = await resolveToken();
		if (!resolved) return;
		try {
			await callDevspec(resolved.token, "heartbeat_connection", {
				connection_id: active.bond.connectionId,
				status: "offline",
				agent_name: AGENT_NAME,
				observed_alive_until: new Date().toISOString(),
			}, { timeoutMs: 3_000, lane: "pump" });
		} catch {
			/* process is going away — the SSE-close path covers it */
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		replaceInteractionJournal(InteractionEventJournal.reconstruct(
			readPersistedActiveBranchEntries(ctx.sessionManager) ?? [],
			ctx.sessionManager.getSessionId(),
		));
		// Auto-bond: interactive sessions become DevSpec capacity on launch
		// (zero-command). Headless modes never auto-bond — scripts, one-shots
		// and cloud workers bond explicitly (RPC command / future flag).
		if (ctx.mode !== "tui" || pump) return;
		const settings = await loadSettings();
		if (!settings.autoBond) return;
		const resolved = await resolveToken();
		if (!resolved) return;
		const outcome = await bondNow(ctx);
		if (outcome.ok) {
			lastCtx = ctx;
			notify(ctx, `DevSpec remote: auto-bonded as ${outcome.codename ?? "agent"} — you're reachable from the Agents page. /devspec.remote stop to end.`);
		} else {
			notify(ctx, `DevSpec remote: auto-bond failed: ${outcome.error}`, outcome.errorKind === "auth" ? "warning" : "error");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		replaceInteractionJournal(InteractionEventJournal.reconstruct(
			readPersistedActiveBranchEntries(ctx.sessionManager) ?? [],
			ctx.sessionManager.getSessionId(),
		));
		if (pump) {
			resumePersistedInteractionEvents(pump, ctx);
			signalWake(pump);
		}
	});

	pi.registerCommand("devspec.reload", {
		description: "Reload this Pi extension (same as /reload). Used by DevSpec CONTROL.",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});

	pi.registerCommand("devspec.remote", {
		description: "Bond this pi session as DevSpec capacity. Usage: /devspec.remote [--session <id>] | stop | reconnect | auto [on|off] | preempt [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "stop" || arg === "off" || arg === "end") {
				if (!pump) {
					notify(ctx, "DevSpec remote: not bonded.", "info");
					return;
				}
				const codename = pump.bond.codename;
				await stopPump(ctx, "local_stop");
				notify(ctx, `DevSpec remote: bond ended${codename ? ` (${codename})` : ""}. Auto-bond stays ${(await loadSettings()).autoBond ? "on" : "off"} for new sessions.`);
				return;
			}

			if (arg === "auto" || arg.startsWith("auto ")) {
				const sub = arg.split(/\s+/)[1];
				if (sub === "on" || sub === "off") {
					const next = await saveSettings({ autoBond: sub === "on" });
					notify(ctx, `DevSpec remote: auto-bond ${next.autoBond ? "ON — new interactive sessions bond on launch" : "OFF — bond manually with /devspec.remote"}.`);
				} else {
					const cur = await loadSettings();
					notify(ctx, `DevSpec remote: auto-bond is ${cur.autoBond ? "on" : "off"} (interactive sessions only).`);
				}
				return;
			}

			if (arg === "preempt" || arg.startsWith("preempt ")) {
				const sub = arg.split(/\s+/)[1];
				if (sub === "on" || sub === "off") {
					const next = await saveSettings({ preemptOwner: sub === "on" });
					preemptOwnerCached = next.preemptOwner;
					notify(ctx, `DevSpec remote: owner-message preemption ${next.preemptOwner ? "ON — mid-turn owner messages interrupt" : "OFF — they queue until the turn finishes"}.`);
				} else {
					const cur = await loadSettings();
					notify(ctx, `DevSpec remote: owner-message preemption is ${cur.preemptOwner ? "on" : "off"}.`);
				}
				return;
			}

			// Manual retry for a troubled bond (item 781886cf): the pump already
			// retries automatically, so this only hurries the next lap — it never
			// rebuilds state, reloads extensions, or disturbs a healthy bond.
			if (arg === "reconnect" || arg === "retry") {
				if (!pump) {
					const outcome = await bondNow(ctx);
					if (!outcome.ok) {
						notify(ctx, `DevSpec remote: ${outcome.error}`, outcome.errorKind === "auth" ? "warning" : "error");
						return;
					}
					notify(
						ctx,
						`DevSpec remote: bonded as ${outcome.codename ?? "agent"}` +
							`${outcome.attached ? " · attached" : " · sessionless (available on the Agents page)"}. ` +
							`Owner messages will arrive as user messages here.`,
					);
					return;
				}
				pump.errors = 0;
				signalWake(pump);
				notify(ctx, "DevSpec remote: retrying now.", "info");
				return;
			}

			const sessionId = namedSessionFromRemoteArg(arg);

			if (pump) {
				const action = bondedRemoteAction(arg);
				// Already bonded, and no room named — nothing to do.
				if (action.type === "report_already_bonded") {
					notify(ctx, `DevSpec remote: already bonded as ${pump.bond.codename ?? pump.bond.connectionId}. Use /devspec.remote stop first.`, "warning");
					return;
				}

				// Already bonded AND a room was named: ATTACH this bond to it.
				//
				// Refusing here used to make `--session` unreachable in practice.
				// Interactive Pi auto-bonds on session_start, so by the time any
				// `/devspec.remote --session <id>` runs — a resume command, a
				// copied attach line, or a person typing it — there is always a
				// bond, and the guard swallowed the room. Naming a session is an
				// explicit instruction to be in that room, not a duplicate connect.
				const resolved = await resolveToken();
				if (!resolved) {
					notify(ctx, "DevSpec remote: not connected to DevSpec — /devspec.login first.", "warning");
					return;
				}
				try {
					const attRaw = await callDevspec(resolved.token, "attach_connection", {
						connection_id: pump.bond.connectionId,
						session_id: action.sessionId,
					}, { cwd: ctx.cwd, lane: "pump" });
					const att = unwrapMcpResult(attRaw);
					if (att.isError) {
						notify(ctx, `DevSpec remote: attach failed: ${att.text}`, "error");
						return;
					}
				} catch (err) {
					notify(ctx, `DevSpec remote: attach failed: ${err instanceof Error ? err.message : err}`, "error");
					return;
				}
				// The pump adopts the server's attachment on its next poll, which
				// owns the bond/tool/status updates — so this deliberately does
				// not write that state a second time.
				notify(
					ctx,
					`DevSpec remote: ${pump.bond.codename ?? "this agent"} attached to the session. ` +
						`Owner messages will arrive as user messages here.`,
				);
				return;
			}

			const outcome = await bondNow(ctx, sessionId);
			if (!outcome.ok) {
				notify(ctx, `DevSpec remote: ${outcome.error}`, outcome.errorKind === "auth" ? "warning" : "error");
				return;
			}
			notify(
				ctx,
				`DevSpec remote: bonded as ${outcome.codename ?? "agent"}` +
					`${outcome.attached ? " · attached" : " · sessionless (available on the Agents page)"}. ` +
					`Owner messages will arrive as user messages here.`,
			);
		},
	});
}
