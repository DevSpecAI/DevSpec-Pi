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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostname } from "node:os";
import { debugRemote as debug } from "./core/debug.ts";
import { DeliveryQueue, StaleDeliveryError, nextDeliveryRetryDelayMs, type DeliveryLease } from "./core/delivery-queue.ts";
import { revalidateDispatchRetry } from "./core/dispatch-retry.ts";
import {
	callDevspec,
	isPermanentServerEnd,
	MODEL_TIMEOUT_MS,
	shouldEndBondOnPollFailure,
} from "./core/client.ts";
import { getBond, setBond, type BondState } from "./core/bond-state.ts";
import {
	formatInboundMessage,
	formatIngressAdvisoryContext,
	parsePollPayload,
	type IngressAdvisoryContext,
	type OwnerCommand,
} from "./core/remote-payload.ts";
import { CommandTurnBindings } from "./core/command-turn.ts";
import { compactWithContext, executeControlCommand, parseControlCommand, reloadWithContext, runReloadLap } from "./core/control.ts";
import { withLiveUi } from "./core/ctx-guard.ts";
import { commandReloadContext, rememberExtensionRunner } from "./core/command-runner.ts";
import { collectModelCatalog, type ModelCatalogSnapshot } from "./core/model-catalog.ts";
import { formatAttachmentNotes, materialiseAttachments, requireMaterialisedAttachments } from "./core/attachments.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { shapeTranscript } from "./core/attach-context.ts";
import { extractAssistantParts, extractText, FINAL_TRAIL_CHARS, TrailBuilder } from "./core/trail.ts";
import { SubagentFleetClient } from "./core/subagent-fleet.ts";
import { buildAgentStatsReport, refreshAgentStatsReport, TelemetryCollector, type AgentStatsReport, type MessageUsage } from "./core/telemetry.ts";
import { takeContextBudgetReport } from "./core/context-budget.ts";
import { automaticBackgroundTaskId, backgroundTaskNotificationId, planSettle, isDeliveryBoundary, isClosedAnswer, isClosedAnswerBoundary, shouldSplitFirstAnswer, isHarnessOrigin, shouldPauseSettle, TurnTracker } from "./core/turn-lifecycle.ts";
import {
	assertHydratedAssignmentIdentity,
	dispatchImplementationDelivery,
	dispatchSummary,
	formatDispatchMessage,
	formatPlaybookDispatchMessage,
	isPlaybookDispatch,
} from "./core/dispatch.ts";
import {
	buildImplementationKickoff,
	createImplementationContractLoader,
	loadImplementationContext,
} from "./core/implementation-contract.ts";
import { recordActiveDelivery, rollbackActiveDelivery } from "./core/active-deliveries.ts";
import {
	firstTextPreview,
	isRealSessionTitle,
	noteVerbEnd,
	notePlaybook,
	noteVerbStart,
	noteWork,
	paintStatus,
	previewFromText,
	resetStatus,
	setSessionPreview,
	syncBondIntoStatus,
} from "./core/status-line.ts";
import { openPushChannel, nextPushReconnectDelayMs } from "./core/push-channel.ts";
import { resolveEndpoint, resolveToken } from "./core/auth-store.ts";
import { loadSettings, saveSettings } from "./core/settings.ts";
import { decideOwnerDelivery, PREEMPT_TAIL, waitUntil } from "./core/preempt.ts";
import {
	SeenOwnerCommands,
	sendModeAtSendTime,
} from "./core/owner-inject.ts";

const AGENT_NAME = "Pi";
const POLL_WAIT_MS = 25_000;
/** Hold + margin; must stay under the MCP client default timeout. */
const POLL_TIMEOUT_MS = 45_000;
const ERROR_BACKOFF_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 10;

interface PumpState {
	/** Monotonic authority generation; async work may commit only while this pump remains current. */
	generation: number;
	bond: BondState;
	cursor?: string;
	dispatchCursor?: string;
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
	wakePending?: boolean;
	wakeWaiter?: (() => void) | null;
	/** Last attach-context/title fetch attempt — titles are job-generated, so a
	 *  missing one is retried on a slow cadence, never hot-polled (Ali: a brand-new
	 *  session may have no title at attach time; check again later). */
	lastSessionEnrichAt?: number;
	/** Dispatch contract hydration is ordered but never awaited by the pump. */
	dispatchQueue: DeliveryQueue;
	/** Local retry survives dispatch-cursor advancement after transient preparation failure. */
	dispatchRetryAttempts: Map<string, number>;
	dispatchRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
}

let pump: PumpState | null = null;
let nextPumpGeneration = 1;
/** Cached so a mid-turn poll does not re-read settings.json every lap. */
let preemptOwnerCached = true;

// ---- Mechanical turn lifecycle (trail + final answer) ---------------------
// All of this is extension-mechanical: zero tokens, no model compliance.

interface TurnState {
	tracker: TurnTracker;
	trail: TrailBuilder;
	/** Immutable poll-delivered command generation this segment answers. */
	commandTurnId?: string;
	/** Exact owner command/source message this transcript segment answers. */
	commandMessageId?: string;
	dirty: boolean;
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

/** One rate-limit/failure warning per turn is enough; the rest go to debug. */
let postWarnedThisTurn = false;

let turn: TurnState | null = null;
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
function ensureTurn(): void {
	if (turn) return;
	if (!getBond()?.sessionId) { debug("ensureTurn: not attached"); return; }
	turn = { tracker: new TurnTracker(), trail: new TrailBuilder(), dirty: false, interval: null, posts: 0, lastPostAt: 0 };
	postWarnedThisTurn = false;
	debug("ensureTurn: tracking (run-scoped)");
	turn.interval = setInterval(trailTick, TRAIL_INTERVAL_MS);
	// Don't hold the process open for the trail timer in headless runs.
	if (typeof turn.interval.unref === "function") turn.interval.unref();
}

// Per-turn telemetry (item 1906e21f): mechanical, zero-token. Accumulates from
// pi's own message_end usage; the report rides the settle answer post (when
// attached) AND the idle heartbeat (always, so sessionless agents show too).
const telemetry = new TelemetryCollector();
/** Last settled usage plus runtime identity. Runtime-only refreshes preserve usage. */
let latestAgentStats: AgentStatsReport | null = null;
let runtimeStampTimer: ReturnType<typeof setTimeout> | null = null;

function runtimeAgentStats(ctx: ExtensionContext | null = lastCtx): AgentStatsReport {
	const model = ctx?.model as { provider?: string; id?: string } | undefined;
	return refreshAgentStatsReport({
		previous: latestAgentStats,
		model: model ?? null,
		thinkingLevel: ctx?.thinkingLevel ?? null,
		context: ctx?.getContextUsage?.() ?? null,
	});
}

/** Coalesce model_select + thinking clamp into one immediate mechanical stamp. */
function scheduleRuntimeStamp(ctx: ExtensionContext): void {
	lastCtx = ctx;
	if (!pump) return;
	if (runtimeStampTimer) clearTimeout(runtimeStampTimer);
	runtimeStampTimer = setTimeout(() => {
		runtimeStampTimer = null;
		const active = pump;
		if (!active || active.stop) return;
		const stats = runtimeAgentStats(lastCtx);
		latestAgentStats = stats;
		void beatBusy(active.busy, stats);
	}, 0);
	if (typeof runtimeStampTimer.unref === "function") runtimeStampTimer.unref();
}

/** Settle the turn's usage into a wire report from the current context. */
function settleTelemetry(): AgentStatsReport {
	const settled = telemetry.settleTurn();
	const ctx = lastCtx;
	const model = ctx?.model as { provider?: string; id?: string } | undefined;
	const contextBudget = takeContextBudgetReport();
	latestAgentStats = buildAgentStatsReport({
		turn: settled.turn,
		session: settled.session,
		model: model ?? null,
		thinkingLevel: ctx?.thinkingLevel ?? null,
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

async function postToSession(message: string, opts: { phase?: string; completeTurn?: boolean; turnKind?: string; commandTurnId?: string; commandMessageId?: string; commandTurnUnbound?: boolean; workTrail?: string; trailEvents?: unknown; agentStats?: AgentStatsReport } = {}): Promise<boolean> {
	const active = pump;
	const bond = getBond();
	if (!active || !bond?.sessionId) return false;
	const resolved = await resolveToken();
	if (!resolved) return false;
	if (pump !== active || (active.stop && !active.closing)) return false;
	try {
		await callDevspec(resolved.token, "post_session_message", {
			connection_id: bond.connectionId,
			message,
			agent_name: AGENT_NAME,
			...(opts.commandTurnId ? { command_turn_id: opts.commandTurnId } : {}),
			...(opts.commandMessageId ? { command_message_id: opts.commandMessageId } : {}),
			...(opts.commandTurnUnbound ? { command_turn_unbound: true } : {}),
			...(opts.phase ? { phase: opts.phase } : {}),
			...(opts.completeTurn === true ? { complete_turn: true } : opts.completeTurn === false ? { complete_turn: false } : {}),
			...(opts.turnKind ? { turn_kind: opts.turnKind } : {}),
			...(opts.workTrail ? { work_trail: opts.workTrail } : {}),
			...(opts.trailEvents && Array.isArray(opts.trailEvents) && opts.trailEvents.length > 0
				? { trail_events: opts.trailEvents }
				: {}),
			...(opts.agentStats ? { agent_stats: opts.agentStats } : {}),
		}, { lane: "pump" });
		return true;
	} catch (err) {
		debug("post to session failed", { errorPresent: Boolean(err) });
		if (!postWarnedThisTurn) {
			postWarnedThisTurn = true;
			notify(lastCtx, `DevSpec remote: post failed (${err instanceof Error ? err.message.slice(0, 120) : err}) — further failures this turn logged to debug only.`, "warning");
		}
		return false;
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
	// No ids therefore means a genuinely local/synthetic segment, even if its
	// text happens to resemble the remote envelope prefix.
	return !t.commandTurnId && !t.commandMessageId;
}

function trailTick(): void {
	if (!turn?.dirty) return;
	const now = Date.now();
	if (now - turn.lastPostAt < nextTrailDelayMs(turn.posts)) return;
	const activityEvents = turn.trail.events();
	// Assistant speech belongs to the transcript. A text-only progress/final
	// message must not open an empty Activity record containing a duplicate.
	if (activityEvents.length === 0) return;
	const rendered = turn.trail.render(undefined, false);
	if (!rendered) return;
	turn.dirty = false;
	turn.posts += 1;
	turn.lastPostAt = now;
	void postToSession(rendered, { phase: "trail", commandTurnId: turn.commandTurnId, commandMessageId: turn.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(turn), trailEvents: activityEvents });
}

/**
 * Explicitly close this connection's activity attempt (item 2c20337a). The
 * busy:false heartbeat is deliberately discarded server-side while the
 * attempt's lease is fresh (anti-flap, 8792f549), so a turn that ends WITHOUT
 * a complete_turn post — aborted, empty, or the answer post failed — would
 * otherwise strand the Working indicator until lease expiry. report_complete
 * is the explicit channel; idempotent when the attempt already closed.
 */
async function reportComplete(reason: string, commandTurnId?: string, commandMessageId?: string, commandTurnUnbound = false): Promise<void> {
	const active = pump;
	if (!active || (active.stop && !active.closing)) return;
	const resolved = await resolveToken();
	if (!resolved) return;
	if (pump !== active || (active.stop && !active.closing)) return;
	try {
		await callDevspec(resolved.token, "report_complete", {
			connection_id: active.bond.connectionId,
			reason,
			...(commandTurnId ? { command_turn_id: commandTurnId } : {}),
			...(commandMessageId ? { command_message_id: commandMessageId } : {}),
			...(commandTurnUnbound ? { command_turn_unbound: true } : {}),
		}, { timeoutMs: 10_000, lane: "pump" });
	} catch {
		/* best-effort — lease expiry + the disconnect paths are the backstop */
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
	const bond = getBond();
	if (!bond?.sessionId) { debug("settle segment not attached"); return false; }

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
	const plan = planSettle(t.tracker, true);
	debug("settle segment", { completeTurn, trailChars: finalTrail.length });
	if (t.tracker.userKind === "harness") return false;
	if (plan.kind === "final") {
		// phase 'answer' closes the trail bubble (preserved as "Show work").
		return await postToSession(plan.message, { phase: "answer", completeTurn, commandTurnId: t.commandTurnId, commandMessageId: t.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(t), workTrail: activityTrail, trailEvents: finalEvents, agentStats: agentStats ?? undefined });
	} else if (plan.kind === "local_mirror") {
		await postToSession(plan.prompt, { turnKind: "local_prompt" });
		return await postToSession(plan.answer, { phase: "answer", completeTurn, commandTurnId: t.commandTurnId, commandMessageId: t.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(t), workTrail: activityTrail, trailEvents: finalEvents, agentStats: agentStats ?? undefined });
	}
	if (t.dirty && activityTrail) {
		await postToSession(activityTrail, { phase: "trail", commandTurnId: t.commandTurnId, commandMessageId: t.commandMessageId, commandTurnUnbound: isCommandTurnUnbound(t), trailEvents: finalEvents });
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
	// Wait / unresolved bg_run: park the owner tracker. The next
	// [bg completed] agent_start continues this turn (item 6ea9aa47).
	if (shouldPauseSettle(t.tracker)) {
		debug("settleTurn: pause — wait/bg_run close, keeping owner tracker");
		return true;
	}
	turn = null;
	if (t.interval) clearInterval(t.interval);
	return await postSegmentAnswer(t, agentStats, "run_end", completeTurn);
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
	const next = new TurnTracker();
	if (t.tracker.userText) next.carryUser(t.tracker.userText, t.tracker);
	// A user-facing progress answer closes one transcript segment. Activity after
	// it belongs to the next segment; carrying the old builder duplicated the
	// entire prior activity beneath every later answer. Exact message identity
	// now keeps the two records stable without cumulative snapshots.
	turn = {
		tracker: next,
		trail: new TrailBuilder(),
		commandTurnId: t.commandTurnId,
		commandMessageId: t.commandMessageId,
		dirty: false,
		posts: 0,
		lastPostAt: 0,
		interval,
	};
	postWarnedThisTurn = false;
	debug("delivery boundary", { completeTurn });
	trackTerminalPost(postSegmentAnswer(t, null, why, completeTurn).then(async (posted) => {
		if (completeTurn && !posted) await reportComplete(why, t.commandTurnId, t.commandMessageId, isCommandTurnUnbound(t));
	}));
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
	if (!active || active.stop) return;
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

async function ackControl(
	token: string,
	connectionId: string,
	controlId: string,
	catalog?: ModelCatalogSnapshot,
): Promise<void> {
	await callDevspec(token, "poll_connection", {
		connection_id: connectionId,
		ingress_version: 1,
		control_ack: controlId,
		wait_ms: 0,
		...(catalog ? { model_catalog: catalog } : {}),
	}, { timeoutMs: 10_000, lane: "pump" });
}

function setRemoteStatus(ctx: ExtensionContext | null): void {
	syncBondIntoStatus(getBond());
	paintStatus(ctx);
}

async function withMaterialisedAttachments(cmd: OwnerCommand, connectionId: string): Promise<OwnerCommand> {
	if (!cmd.attachments || cmd.attachments.length === 0) return cmd;
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
	);
	requireMaterialisedAttachments(materialised, cmd.attachments.length);
	return { ...cmd, attachmentNotes: formatAttachmentNotes(materialised) };
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

async function stopPump(ctx: ExtensionContext | null, reason: "local_stop" | "owner_gone", serverAlreadyEnded = false): Promise<void> {
	const active = pump;
	if (!active) return;
	active.stop = true;
	active.dispatchQueue.invalidate();
	for (const timer of active.dispatchRetryTimers.values()) clearTimeout(timer);
	active.dispatchRetryTimers.clear();
	active.pushAbort?.abort();
	if (active.pushReconnectTimer) {
		clearTimeout(active.pushReconnectTimer);
		active.pushReconnectTimer = undefined;
	}
	if (active.wakeWaiter) {
		const w = active.wakeWaiter;
		active.wakeWaiter = null;
		w();
	}
	pump = null;
	commandTurnBindings.clear();
	setBond(null);
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
	active.wakePending = true;
	if (active.wakeWaiter) {
		const w = active.wakeWaiter;
		active.wakeWaiter = null;
		w();
	}
}

/** Wait for a wake frame (or the safety tick). Never rejects. */
function waitForWake(active: PumpState, safetyMs: number): Promise<void> {
	if (active.wakePending) {
		active.wakePending = false;
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		active.wakeWaiter = resolve;
		const t = setTimeout(() => {
			if (active.wakeWaiter === resolve) active.wakeWaiter = null;
			resolve();
		}, safetyMs);
		if (typeof t.unref === "function") t.unref();
	});
}

/**
 * The stream dropped unexpectedly (or failed to connect). Reconnect with
 * bounded backoff (item 8b0c162b) — a proxy hiccup must not cost the bond its
 * fast lane for the rest of its life. Only when quick retries are exhausted do
 * we settle into the held long-poll fallback (pushClosed). The server's
 * grace-guarded liveness clear (10s) gives these retries their window: a
 * reconnect that lands in time re-stamps presence and defeats the clear.
 */
function schedulePushReconnect(active: PumpState, token: string, endpoint: string): void {
	if (active.stop || active.pushEnded !== undefined) return;
	const delay = nextPushReconnectDelayMs(active.pushAttempts, active.pushOpenedAt, Date.now());
	if (delay === null) {
		active.pushClosed = true;
		debug("push reconnects exhausted — held long-poll fallback");
		return;
	}
	active.pushAttempts += 1;
	debug("push reconnect attempt", { attempt: active.pushAttempts, delayMs: delay });
	active.pushReconnectTimer = setTimeout(() => {
		active.pushReconnectTimer = undefined;
		if (active.stop || active.pushEnded !== undefined) return;
		startPushChannel(active, token, endpoint);
		// A re-opened stream's first marker read always wakes (fresh baseline),
		// so nothing that moved during the outage is missed.
		signalWake(active);
	}, delay);
	if (typeof active.pushReconnectTimer.unref === "function") active.pushReconnectTimer.unref();
}

/** Open the SSE push channel; drops route through schedulePushReconnect. */
function startPushChannel(active: PumpState, token: string, endpoint: string): void {
	const controller = new AbortController();
	active.pushAbort = controller;
	active.pushOpenedAt = Date.now();
	void openPushChannel({
		mcpUrl: endpoint,
		token,
		connectionId: active.bond.connectionId,
		signal: controller.signal,
		handlers: {
			onWake: () => {
				debug("push wake");
				signalWake(active);
			},
			onEnded: (reason) => {
				active.pushEnded = reason;
				signalWake(active);
			},
			onClose: (reason) => {
				if (controller.signal.aborted) return;
				debug("push channel closed", { reasonPresent: Boolean(reason) });
				schedulePushReconnect(active, token, endpoint);
				signalWake(active);
			},
		},
	}).catch((err) => {
		if (controller.signal.aborted) return;
		debug("push channel connect failed", { errorPresent: Boolean(err) });
		schedulePushReconnect(active, token, endpoint);
		signalWake(active);
	});
}

function dispatchRecord(value: unknown): Record<string, unknown> | null {
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

async function deliverDispatch(
	active: PumpState,
	token: string,
	rawDispatch: unknown,
	ctx: ExtensionContext,
	lease: DeliveryLease,
): Promise<void> {
	assertDeliveryAuthority(active, lease);
	if (isPlaybookDispatch(rawDispatch)) {
		const root = dispatchRecord(rawDispatch);
		const message = formatPlaybookDispatchMessage(rawDispatch, active.bond.codename ?? "this agent");
		assertDeliveryAuthority(active, lease);
		notePlaybook({
			runId: typeof root?.run_id === "string" ? root.run_id : undefined,
			id: typeof root?.playbook_id === "string" ? root.playbook_id : undefined,
			name: typeof root?.playbook_name === "string" ? root.playbook_name : undefined,
		});
		paintStatus(ctx);
		pi_send(message, ctx.isIdle() ? "now" : "followUp");
		return;
	}

	let dispatch = rawDispatch;
	let delivery = dispatchImplementationDelivery(dispatch);
	if (!delivery) {
		// A minimal envelope carrying only an assignment id used to be hydrated with
		// get_assignment. That tool is gone (DevSpec item 1e455001) and so is the
		// dispatch model behind it: work is not sent to an agent, it is reserved by
		// one. So an envelope this thin cannot be resolved into work any more, and
		// pretending otherwise would mean guessing at members.
		//
		// This is a loud, precise failure ON PURPOSE. It means the server sent
		// something this plugin's version cannot understand, which is worth reporting
		// rather than papering over.
		const assignmentId = dispatchSummary(dispatch).assignmentId;
		throw new Error(
			assignmentId
				? `dispatch ${assignmentId} carried no implementation kickoff or members, and get_assignment no longer exists to hydrate it — reserve work with reserve_work_items instead`
				: "work dispatch carried no assignment identity",
		);
	}

	const implementationContext = await loadImplementationContext({
		reference: delivery.reference,
		loader: createImplementationContractLoader(token),
		assertCurrent: () => assertDeliveryAuthority(active, lease),
	});
	assertDeliveryAuthority(active, lease);
	const kickoff = buildImplementationKickoff({
		actionItemIds: delivery.actionItemIds,
		assignmentId: delivery.assignmentId,
		context: implementationContext,
		contractReference: delivery.reference,
	});
	const message = formatDispatchMessage(
		dispatch,
		active.bond.codename ?? "this agent",
		implementationContext,
		delivery,
	);
	assertDeliveryAuthority(active, lease);
	const recorded = recordActiveDelivery(kickoff, implementationContext);
	try {
		pi_send(message, ctx.isIdle() ? "now" : "followUp");
	} catch (error) {
		rollbackActiveDelivery(recorded);
		throw error;
	}
	// No await follows the final authority checkpoint above: message, delivery and
	// status commit in one JavaScript turn, so stop/rebond cannot interleave.
	const summary = dispatchSummary(dispatch);
	noteWork({ id: summary.assignmentId, title: summary.title });
	paintStatus(ctx);
	if (implementationContext.warning) notify(ctx, implementationContext.warning, "warning");
}

function dispatchRetryKey(dispatch: unknown): string | undefined {
	const root = dispatchRecord(dispatch);
	return (
		(typeof root?.run_id === "string" && root.run_id) ||
		dispatchSummary(dispatch).assignmentId ||
		undefined
	);
}

async function loadCurrentDispatchInbox(
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
	if (isError) throw new Error(text || "dispatch retry revalidation failed");
	const payload = details as { dispatches?: unknown[]; dispatch_id?: unknown; identity_complete?: unknown } | null;
	if (!Array.isArray(payload?.dispatches)) throw new Error("dispatch retry revalidation returned no live inbox");
	return {
		dispatches: payload.dispatches,
		identityComplete: payload.identity_complete === true && payload.dispatch_id === key,
	};
}

function scheduleDispatchRetry(
	active: PumpState,
	key: string,
	token: string,
	ctx: ExtensionContext,
	error: unknown,
	quiet = false,
): void {
	if (active.stop || pump !== active) return;
	const failures = (active.dispatchRetryAttempts.get(key) ?? 0) + 1;
	active.dispatchRetryAttempts.set(key, failures);
	const delayMs = nextDeliveryRetryDelayMs(failures);
	const reason = error instanceof Error ? error.message : String(error);
	if (!active.dispatchRetryTimers.has(key)) {
		const timer = setTimeout(() => {
			active.dispatchRetryTimers.delete(key);
			if (active.stop || pump !== active) return;
			void revalidateDispatchRetry({
				key,
				loadCurrentInbox: () => loadCurrentDispatchInbox(active, key, token, ctx),
				identity: dispatchRetryKey,
				assertCurrent: () => {
					if (active.stop || pump !== active) throw new StaleDeliveryError();
				},
				withdrawCurrent: () => active.dispatchQueue.invalidateKey(key),
				enqueueCurrent: (currentDispatch) => enqueueDispatch(active, token, currentDispatch, ctx),
			}).then((outcome) => {
				if (outcome === "withdrawn") {
					active.dispatchRetryAttempts.delete(key);
				} else if (outcome === "retry") {
					scheduleDispatchRetry(active, key, token, ctx, "dispatch authority is not yet confirmable", true);
				}
			}).catch((retryError) => scheduleDispatchRetry(active, key, token, ctx, retryError));
		}, delayMs);
		if (typeof timer.unref === "function") timer.unref();
		active.dispatchRetryTimers.set(key, timer);
	}
	if (!quiet) {
		notify(ctx, `DevSpec remote: failed to deliver dispatch: ${reason}. Revalidating in ${Math.ceil(delayMs / 1_000)}s.`, "warning");
	}
}

function enqueueDispatch(
	active: PumpState,
	token: string,
	dispatch: unknown,
	ctx: ExtensionContext,
): void {
	const key = dispatchRetryKey(dispatch);
	if (!key) return;
	active.dispatchQueue.enqueue(
		key,
		async (lease) => {
			await deliverDispatch(active, token, dispatch, ctx, lease);
			active.dispatchRetryAttempts.delete(key);
			const timer = active.dispatchRetryTimers.get(key);
			if (timer) clearTimeout(timer);
			active.dispatchRetryTimers.delete(key);
			if (!active.stop && pump === active) notify(ctx, "DevSpec remote: work dispatch delivered.");
		},
		(error) => scheduleDispatchRetry(active, key, token, ctx, error),
	);
}

async function pumpLoop(ctx: ExtensionContext): Promise<void> {
	const active = pump;
	if (!active) return;
	const resolved = await resolveToken();
	if (!resolved) return;
	const token = resolved.token;

	// Push mode: SSE wakes us; we fetch the package with a no-hold poll.
	// Falls back to the held long-poll if the channel stays unavailable.
	startPushChannel(active, token, await resolveEndpoint());
	let pushMode = true;
	// The safety tick keeps presence fresh and catches anything the stream missed.
	const PUSH_SAFETY_MS = 75_000;
	let notifiedFallback = false;

	while (pump === active && !active.stop) {
		lastCtx = ctx;
		// Server told us the bond ended — only a human End / local stop is sticky.
		if (active.pushEnded !== undefined) {
			if (isPermanentServerEnd("ended", active.pushEnded)) {
				notify(ctx, `DevSpec remote: connection ended${active.pushEnded ? ` (${active.pushEnded})` : ""}.`, "info");
				await stopPump(ctx, "owner_gone", true);
				return;
			}
			debug("push ended recoverable", { reasonPresent: Boolean(active.pushEnded) });
			active.pushEnded = undefined;
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

		let payload: unknown;
		try {
			const raw = await callDevspec(
				token,
				"poll_connection",
				{
					connection_id: active.bond.connectionId,
					ingress_version: 1,
					cursor_v2: active.cursor,
					dispatch_cursor: active.dispatchCursor,
					wait_ms: pushMode ? 0 : POLL_WAIT_MS,
					busy: active.busy,
					listener_armed: true,
					agent_name: AGENT_NAME,
					agent_stats: runtimeAgentStats(ctx),
				},
				{ timeoutMs: POLL_TIMEOUT_MS, cwd: ctx.cwd, lane: "pump" },
			);
			const { details, isError, text } = unwrapMcpResult(raw);
			if (isError) throw new Error(text || "poll_connection failed");
			payload = details;
			active.errors = 0;
		} catch (err) {
			// Only a rejected token ends the bond from the client. A hung or
			// parse-failed poll is recoverable (item 781886cf) — keep heartbeats
			// and retry. Never stamp owner_gone / local_stop for transport noise.
			if (shouldEndBondOnPollFailure(err)) {
				notify(ctx, "DevSpec remote: token rejected — bond ended. /devspec.login to reconnect.", "error");
				await stopPump(ctx, "owner_gone");
				return;
			}
			active.errors += 1;
			if (active.errors === 1 || active.errors % MAX_CONSECUTIVE_ERRORS === 0) {
				debug("poll recoverable", { errors: active.errors, errorPresent: Boolean(err) });
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
			void beatBusy(active.busy);
			await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
			continue;
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
		if (serverSessionId !== (active.bond.sessionId ?? null)) {
			const next = {
				...active.bond,
				sessionId: serverSessionId ?? undefined,
				// A new room (or detach) must not keep the previous room's title.
				sessionTitle: undefined,
				ownerName: undefined,
				attachContext: undefined,
				roomDigest: undefined,
			};
			active.bond = next;
			setBond(next);
			setRemoteStatus(ctx);
			debug("attachment adopted from server", { attached: Boolean(serverSessionId) });
			// Refresh display identity only. Command-turn context is canonical ingress.
			if (serverSessionId) void enrichBondWithSession(serverSessionId);
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

		const pkg = parsePollPayload(payload, active.bond.connectionId);
		if (pkg.canonicalState === "invalid") {
			// A negotiated changed response without a valid known ingress envelope
			// has no executable or contextual meaning. Keep the canonical cursor
			// unchanged so a corrected response can be retried.
			const dispatches = (payload as { dispatches?: unknown[] } | null)?.dispatches ?? [];
			for (const dispatch of dispatches) enqueueDispatch(active, token, dispatch, ctx);
			if (pkg.dispatchCursor) active.dispatchCursor = pkg.dispatchCursor;
			active.errors += 1;
			debug("canonical ingress rejected", { errors: active.errors, errorPresent: Boolean(pkg.canonicalError) });
			await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
			continue;
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
		if (pkg.advisoryContext && pkg.ownerCommands.length === 0) {
			// Preserve the latest honestly bounded advisory window. It is delivered
			// only beside the next exact command and never wakes by itself.
			active.advisoryCarry = [pkg.advisoryContext];
		}

		let commandDeliveryFailed = false;
		for (const rejected of active.seenOwnerCommands.takeUnseen(pkg.rejectedCommands)) {
			// Canonical `unavailable` is a permanent fail-closed command result.
			active.seenOwnerCommands.commit(rejected);
			void reportComplete("delivery_unavailable", rejected.commandTurnId, rejected.id);
		}

		for (const cmd of active.seenOwnerCommands.takeUnseen(pkg.ownerCommands)) {
			let deliveryMessage: string | undefined;
			try {
				// Hydrate before deciding/performing preemption. A failure must occur
				// before abort or any Pi model/user message side effect.
				const hydrated = await withMaterialisedAttachments(cmd, active.bond.connectionId);
				const mode = decideOwnerDelivery({
					idle: ctx.isIdle(),
					preemptEnabled: preemptOwnerCached,
					hasOwnerCommand: true,
				});
				const formatted = formatInboundMessage(
					hydrated,
					active.bond.codename ?? "this agent",
					active.bond,
				);
				const contexts = [...active.advisoryCarry, cmd.advisoryContext]
					.filter((bundle, index, all) => all.findIndex((candidate) => candidate.envelopeId === bundle.envelopeId) === index);
				if (pump !== active || active.stop) throw new Error("Remote bond changed before owner delivery.");
				if (mode === "preempt") {
					debug("preempt: aborting running turn for owner instruction");
					deliveryMessage = `${formatted}\n\n${PREEMPT_TAIL}`;
					pi_abort();
					const settled = await waitUntil(() => ctx.isIdle(), {
						timeoutMs: 8_000,
						intervalMs: 50,
					});
					const sendMode = sendModeAtSendTime(mode, ctx.isIdle(), settled);
					debug("preempt", { settled, immediate: sendMode === "now" });
					if (pump !== active || active.stop) throw new Error("Remote bond changed during owner preemption.");
					pi_send(deliveryMessage, sendMode, cmd.commandTurnId, cmd.id, contexts);
					notify(ctx, `DevSpec remote: interrupted — ${cmd.userName ?? "owner"} first.`);
				} else {
					const sendMode = sendModeAtSendTime(mode, ctx.isIdle());
					deliveryMessage = formatted;
					if (pump !== active || active.stop) throw new Error("Remote bond changed before owner send.");
					pi_send(deliveryMessage, sendMode, cmd.commandTurnId, cmd.id, contexts);
					notify(ctx, mode === "queue" || sendMode === "followUp"
						? `DevSpec remote: queued owner message (${cmd.userName ?? "owner"}).`
						: `DevSpec remote: delivered owner message (${cmd.userName ?? "owner"}).`);
				}
				active.seenOwnerCommands.commit(cmd);
				if (untitledAttached()) {
					setSessionPreview(previewFromText(cmd.text));
					paintStatus(ctx);
					if (active.bond.sessionId) scheduleTitleRefresh(active.bond.sessionId);
				}
			} catch (err) {
				commandDeliveryFailed = true;
				active.seenOwnerCommands.release(cmd);
				if (deliveryMessage) commandTurnBindings.forget(deliveryMessage, cmd.commandTurnId, cmd.id);
				notify(ctx, `DevSpec remote: failed to deliver owner message: ${err instanceof Error ? err.message : err}`, "warning");
			}
		}
		if (!commandDeliveryFailed) {
			if (pkg.cursorV2) active.cursor = pkg.cursorV2;
			if (pkg.ownerCommands.length > 0) active.advisoryCarry = [];
		}
		const dispatches = (payload as { dispatches?: unknown[] } | null)?.dispatches ?? [];
		for (const dispatch of dispatches) enqueueDispatch(active, token, dispatch, ctx);
		if (pkg.dispatchCursor) active.dispatchCursor = pkg.dispatchCursor;
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
	try {
		const regRaw = await callDevspec(resolved.token, "register_connection", {
			local_id: localId,
			agent_name: AGENT_NAME,
			machine_hostname: hostname(),
			cwd: ctx.cwd,
		}, { cwd: ctx.cwd, lane: "pump" });
		const reg = unwrapMcpResult(regRaw);
		if (reg.isError) return { ok: false, error: `register failed: ${reg.text}`, errorKind: "api" };
		regText = reg.text;
		d = (reg.details ?? {}) as Record<string, unknown>;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), errorKind: "api" };
	}
	const connectionId = (d.connection_id ?? d.connectionId) as string | undefined;
	if (!connectionId) return { ok: false, error: `register returned no connection id: ${regText.slice(0, 200)}`, errorKind: "api" };

	const bond: BondState = {
		connectionId,
		codename: typeof d.codename === "string" ? d.codename : undefined,
		sessionId: (d.session_id as string | undefined) ?? undefined,
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
				attached = true;
			}
		} catch (err) {
			notify(ctx, `DevSpec remote: bonded but attach failed: ${err instanceof Error ? err.message : err}`, "warning");
		}
	}

	setBond(bond);
	pump = {
		generation: nextPumpGeneration++,
		bond,
		busy: false,
		stop: false,
		errors: 0,
		synced: false,
		seenOwnerCommands: new SeenOwnerCommands(),
		advisoryCarry: [],
		pushAttempts: 0,
		dispatchQueue: new DeliveryQueue(),
		dispatchRetryAttempts: new Map(),
		dispatchRetryTimers: new Map(),
	};
	preemptOwnerCached = (await loadSettings()).preemptOwner;
	setRemoteStatus(ctx);
	// Initial runtime identity must be visible before this agent has completed a
	// turn. The first long-poll below carries this report with its heartbeat.
	latestAgentStats = runtimeAgentStats(ctx);
	// Revive/register can already be attached. Refresh title/owner display
	// identity; canonical ingress remains the only model-context source.
	if (bond.sessionId) void enrichBondWithSession(bond.sessionId);
	void pumpLoop(ctx);
	return { ok: true, codename: bond.codename, attached };
}

// Late-bound so the loop can reference the ExtensionAPI closure.
let pi_send: (
	message: string,
	mode?: "now" | "steer" | "followUp",
	commandTurnId?: string,
	commandMessageId?: string,
	contexts?: readonly IngressAdvisoryContext[],
) => void = () => {};
let pi_abort: () => void = () => {};
let pi_compact: () => void = () => {};
let pi_reload: () => Promise<void> = async () => {};
let pi_setThinking: (level: string) => void = () => {};
let pi_setModel: (modelId: string) => Promise<boolean> = async () => false;

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
	const refreshSubagentFleet = (toolCallId: string, trackedTurn: TurnState | null) => {
		if (!trackedTurn) return;
		void subagentFleet.refresh().then((snapshot) => {
			// A late optional-RPC reply must never mutate a later delivery segment.
			if (!snapshot || turn !== trackedTurn) return;
			if (trackedTurn.trail.applySubagentFleet(toolCallId, snapshot)) trackedTurn.dirty = true;
		});
	};
	pi_send = (message, mode = "now", commandTurnId, commandMessageId, contexts = []) => {
		try {
			for (const context of contexts) {
				const custom = {
					customType: "devspec-remote-ingress-context",
					content: formatIngressAdvisoryContext(context, {
						id: commandMessageId ?? "unbound",
						commandTurnId: commandTurnId ?? "unbound",
					}),
					display: false,
					details: {
						envelope_id: context.envelopeId,
						command_message_id: commandMessageId,
						command_turn_id: commandTurnId,
						context: context.context,
						window: context.window,
					},
				};
				if (mode === "steer") pi.sendMessage(custom, { triggerTurn: false, deliverAs: "steer" });
				else if (mode === "followUp") pi.sendMessage(custom, { triggerTurn: false, deliverAs: "followUp" });
				else pi.sendMessage(custom, { triggerTurn: false });
			}
			commandTurnBindings.remember(message, commandTurnId, commandMessageId);
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
		pi.setThinkingLevel?.(level as never);
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

	pi.on("model_select", (_event, ctx) => {
		scheduleRuntimeStamp(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		scheduleRuntimeStamp(ctx);
	});

	pi.on("agent_start", () => {
		if (pump) {
			pump.busy = true;
			void beatBusy(true);
		}
		// The run begins — the delivery unit. Turn state is born here (or on
		// the first attached turn_start after a mid-run attach), never per round.
		ensureTurn();
	});
	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		// Capture before settleTurn releases the segment; terminal fallback must
		// never complete a newer owner command that arrived during this settle.
		const commandTurnId = turn?.commandTurnId;
		const commandMessageId = turn?.commandMessageId;
		const commandTurnUnbound = turn ? isCommandTurnUnbound(turn) : false;
		// Settle telemetry FIRST (pure, instant) so the idle heartbeat and the
		// answer post carry this turn's report, not the previous one's.
		const agentStats = settleTelemetry();
		if (pump) {
			pump.busy = false;
			void beatBusy(false, agentStats);
		}
		if (untitledAttached() && pump?.bond.sessionId) {
			scheduleTitleRefresh(pump.bond.sessionId);
		}
		trackTerminalPost((async () => {
			const posted = await settleTurn(agentStats, true);
			// Pause (wait/bg_run) keeps the tracker and the working attempt.
			// No complete_turn post landed (aborted/empty turn, or the post
			// failed) — close the working attempt explicitly (item 2c20337a).
			if (!posted) await reportComplete("turn_end", commandTurnId, commandMessageId, commandTurnUnbound);
		})());
	});

	// ---- Turn lifecycle events (mechanical trail + final answer) ------------

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
		// Per-LLM-round event — the state must SURVIVE it, never be recreated
		// (cc9e8c43). Lazily covers a mid-run attach too.
		ensureTurn();
	});

	// Leftover bg receipts arrive as custom_message (customType
	// background-task-notification) and may then replay the last typed prompt
	// as a user message. Stamp harness origin here so that replay cannot
	// remirror (item 56b9a3b4). Typed /commands never take this path.
	pi.on("before_agent_start", (_event, ctx) => {
		ensureTurn();
		if (!turn) return;
		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf || leaf.type !== "custom_message") return;
		const customType = leaf.customType;
		const content = typeof leaf.content === "string"
			? leaf.content
			: Array.isArray(leaf.content)
				? leaf.content
					.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
					.map((b) => b.text)
					.join("\n")
				: "";
		if (!isHarnessOrigin(content, customType)) return;
		// Context/harness may wake the model. Do not close the live owner
		// turn as complete (item 60cf5f00). A terminal task notification
		// resolves only its matching owner-started task (item 15cb0983).
		const details = (leaf as { details?: unknown }).details;
		turn.tracker.userMessage(content, {
			customType,
			backgroundTaskId: backgroundTaskNotificationId(content, details),
		});
	});

	pi.on("message_start", (event, ctx) => {
		lastCtx = ctx;
		if (!turn) return;
		const msg = event.message as { role?: string; customType?: string; details?: unknown } | undefined;
		const text = extractText(event.message);
		const customType = typeof msg?.customType === "string" ? msg.customType : null;
		const harness = isHarnessOrigin(text, customType);
		if (msg?.role === "user" || msg?.role === "custom" || harness) {
			const isRealUserMessage = msg?.role === "user" && !harness;
			const incomingCommand = isRealUserMessage ? commandTurnBindings.take(text) : undefined;
			// A mid-run OWNER/LOCAL user message is a delivery boundary
			// (b1fb756a). Context/harness injections stay on this turn so
			// they cannot complete_turn a working sentence (item 60cf5f00).
			// The old segment posts its own exact command_message_id. The server
			// completes that activity but keeps the shared command generation open
			// while a newer command in it is still pending/working.
			if (isRealUserMessage && isDeliveryBoundary(turn.tracker)) {
				splitTurnAtBoundary();
			} else if (isRealUserMessage && (turn.commandMessageId || isCommandTurnUnbound(turn))) {
				// A pure tool-call/no-text segment is not a display boundary, but its
				// activity identity still must terminate before the new user segment
				// replaces it (notably a preemption-timeout steer).
				trackTerminalPost(reportComplete(
					"turn_end",
					turn.commandTurnId,
					turn.commandMessageId,
					isCommandTurnUnbound(turn),
				));
			}
			// Harness context belongs to the current owner generation. A real user
			// message starts a new segment: bind the server turn id retained when the
			// poller injected it, or clear the old binding for a local prompt.
			if (isRealUserMessage) {
				turn.commandTurnId = incomingCommand?.turnId;
				turn.commandMessageId = incomingCommand?.commandMessageId;
			}
			turn.tracker.userMessage(text, {
				customType,
				backgroundTaskId: harness ? backgroundTaskNotificationId(text, msg?.details) : null,
			});
		}
		// A new assistant message = a new LLM round. If the previous close was
		// a finished text-only answer, that bubble is done — split it off
		// (complete_turn=false) so this round's thinking/tools open a new trail.
		else if (msg?.role === "assistant") {
			if (isClosedAnswerBoundary(turn.tracker)) splitTurnAtBoundary("closed_answer", false);
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
		turn.dirty = true;
	});

	pi.on("message_end", (event, ctx) => {
		lastCtx = ctx;
		// Telemetry accumulates for EVERY assistant message while bonded —
		// including turns the trail skips (unattached/local), so sessionless
		// agents still report on the idle heartbeat.
		const msg = event.message as { role?: string; usage?: MessageUsage } | undefined;
		if (pump && msg?.role === "assistant") {
			telemetry.addMessageUsage(msg.usage);
		}
		if (!turn) { debug("message_end: no turn"); return; }
		if (msg?.role === "assistant") {
			// Feed the trail from the finalized message too: message_update
			// streams live in the TUI, but headless modes (RPC/print/SDK) emit
			// no deltas — this keeps the trail complete there (flushed at
			// settle) without double-posting in the TUI (cumulative snapshots).
			const { text, thinking, hasToolCalls, stopReason } = extractAssistantParts(event.message);
			turn.trail.setThinking(thinking);
			turn.trail.setText(text);
			// Round sealed: the next deltas open fresh entries (cc9e8c43).
			turn.trail.beginAssistantMessage();
			turn.dirty = true;
			const firstSplit = shouldSplitFirstAnswer(turn.tracker, { text, hasToolCalls });
			turn.tracker.assistantFinal(text, firstSplit || isClosedAnswer({
				text,
				hasToolCalls,
				stopReason,
				awaitingBackground: turn.tracker.awaitingBackground,
			}));
			// First user-facing line after a user message is the answer for the
			// thinking so far, even when this same message also starts tools.
			if (firstSplit) splitTurnAtBoundary("first_answer", false);
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		lastCtx = ctx;
		noteVerbStart(event.toolCallId, event.toolName, event.args);
		paintStatus(ctx);
		if (!turn) return;
		turn.trail.toolStart(event.toolCallId, event.toolName, event.args);
		turn.dirty = true;
		if (event.toolName === "subagent_wait") refreshSubagentFleet(event.toolCallId, turn);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		lastCtx = ctx;
		if (!turn) return;
		turn.trail.toolUpdate(event.toolCallId, event.partialResult);
		turn.dirty = true;
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
		turn.trail.toolEnd(event.toolCallId, event.toolName, !event.isError, event.result);
		turn.dirty = true;
	});

	pi.on("session_shutdown", async () => {
		subagentFleet.dispose();
		if (runtimeStampTimer) {
			clearTimeout(runtimeStampTimer);
			runtimeStampTimer = null;
		}
		// Close any open trail / Working row BEFORE tearing the pump down
		// (item 781886cf). A crash mid-turn must not leave empty bubbles.
		const openTurn = turn;
		if (openTurn?.interval) clearInterval(openTurn.interval);
		turn = null;
		const active = pump;
		if (!active) return;
		active.closing = true;
		active.stop = true;
		active.pushAbort?.abort();
		if (active.pushReconnectTimer) clearTimeout(active.pushReconnectTimer);
		if (active.wakeWaiter) {
			const w = active.wakeWaiter;
			active.wakeWaiter = null;
			w();
		}
		// Let detached boundary/settle posts finish while pump authority still
		// exists, so their failure fallback can report the exact segment.
		if (pendingTerminalPosts.size > 0) {
			await Promise.allSettled([...pendingTerminalPosts]);
		}
		// Close the activity attempt while the bond is still on the wire.
		if (openTurn) {
			try { await reportComplete("process_exit", openTurn.commandTurnId, openTurn.commandMessageId, isCommandTurnUnbound(openTurn)); } catch { /* best-effort */ }
		}
		pump = null;
		commandTurnBindings.clear();
		setBond(null);
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
		description: "Bond this pi session as DevSpec capacity. Usage: /devspec.remote [--session <id>] | stop | auto [on|off] | preempt [on|off]",
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

			if (pump) {
				notify(ctx, `DevSpec remote: already bonded as ${pump.bond.codename ?? pump.bond.connectionId}. Use /devspec.remote stop first.`, "warning");
				return;
			}

			const sessionMatch = arg.match(/^(?:--session|-s)\s+(\S+)$/);
			const outcome = await bondNow(ctx, sessionMatch?.[1]);
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
