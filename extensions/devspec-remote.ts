/**
 * DevSpec Pi — remote control (Phase 4, slice 1).
 *
 *   /devspec.remote [--session <id>]   bond this pi session as DevSpec capacity
 *   /devspec.remote stop               end the bond (sticky 'local_stop')
 *
 * Design (VISION.md + the delivery contract):
 * - Bond key = the pi session id (conversation id — never cwd/shell). The
 *   server revives the same (owner, local_id) bond within its 24h window, so
 *   `pi -c` keeps the same connection and codename.
 * - ONE held poll_connection long-poll (25s) carries heartbeat + commands +
 *   advisory; owner commands arrive as REAL user messages (sendUserMessage,
 *   followUp while busy). Advisory tiers never wake the agent.
 * - Egress is agent-canonical: the model answers with the native
 *   post_session_message tool (complete_turn on the final answer). No
 *   mirror-as-primary.
 * - The pump asserts busy from pi's own turn events and reports
 *   listener_armed from the live loop — never from leftover state.
 * - Headless: works in -p/rpc/json; notifications degrade to no-ops.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostname } from "node:os";
import { appendFileSync } from "node:fs";

function debug(line: string): void {
	if (process.env.DEVSPEC_DEBUG_REMOTE) {
		try { appendFileSync("/tmp/devspec-remote-debug.log", `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
	}
}
import { callDevspec, DevspecAuthError } from "./core/client.ts";
import { getBond, setBond, type BondState } from "./core/bond-state.ts";
import { formatInboundMessage, parsePollPayload } from "./core/remote-payload.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { extractAssistantParts, extractText, TrailBuilder } from "./core/trail.ts";
import { buildAgentStatsReport, TelemetryCollector, type AgentStatsReport, type MessageUsage } from "./core/telemetry.ts";
import { planSettle, TurnTracker } from "./core/turn-lifecycle.ts";
import { formatDispatchMessage } from "./core/dispatch.ts";
import { buildRoomDigest } from "./core/orientation.ts";
import { openPushChannel, nextPushReconnectDelayMs } from "./core/push-channel.ts";
import { resolveEndpoint, resolveToken } from "./core/auth-store.ts";
import { loadSettings, saveSettings } from "./core/settings.ts";

const AGENT_NAME = "Pi";
const POLL_WAIT_MS = 25_000;
/** Hold + margin; must stay under the MCP client default timeout. */
const POLL_TIMEOUT_MS = 45_000;
const ERROR_BACKOFF_MS = 5_000;
const MAX_CONSECUTIVE_ERRORS = 10;

interface PumpState {
	bond: BondState;
	cursor?: string;
	dispatchCursor?: string;
	busy: boolean;
	stop: boolean;
	errors: number;
	/**
	 * False until the first package has been processed. The cold-start poll
	 * has no cursor, so the server answers with the catch-up WINDOW — which
	 * includes already-answered commands. Re-delivering those re-runs old
	 * work (observed live: a replied-to UI message re-injected on rebond).
	 * The first package is ORIENTATION ONLY: adopt its cursors, deliver
	 * nothing. Only arrivals after that point are actionable.
	 */
	synced: boolean;
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
}

let pump: PumpState | null = null;

// ---- Mechanical turn lifecycle (trail + final answer) ---------------------
// All of this is extension-mechanical: zero tokens, no model compliance.

interface TurnState {
	tracker: TurnTracker;
	trail: TrailBuilder;
	dirty: boolean;
	interval: ReturnType<typeof setInterval> | null;
	/** Trail posts so far this turn — drives the adaptive cadence. */
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
let lastCtx: ExtensionContext | null = null;
const TRAIL_INTERVAL_MS = 1_000;

// Per-turn telemetry (item 1906e21f): mechanical, zero-token. Accumulates from
// pi's own message_end usage; the report rides the settle answer post (when
// attached) AND the idle heartbeat (always, so sessionless agents show too).
const telemetry = new TelemetryCollector();

/** Settle the turn's usage into a wire report from the current context. Null when nothing was tracked. */
function settleTelemetry(): AgentStatsReport | null {
	const settled = telemetry.settleTurn();
	const ctx = lastCtx;
	const model = ctx?.model as { provider?: string; id?: string } | undefined;
	return buildAgentStatsReport({
		turn: settled.turn,
		session: settled.session,
		model: model ?? null,
		thinkingLevel: ctx?.thinkingLevel ?? null,
		context: ctx?.getContextUsage?.() ?? null,
	});
}

async function postToSession(message: string, opts: { phase?: string; completeTurn?: boolean; turnKind?: string; workTrail?: string; agentStats?: AgentStatsReport } = {}): Promise<boolean> {
	const bond = getBond();
	if (!bond?.sessionId) return false;
	const resolved = await resolveToken();
	if (!resolved) return false;
	try {
		await callDevspec(resolved.token, "post_session_message", {
			connection_id: bond.connectionId,
			message,
			agent_name: AGENT_NAME,
			...(opts.phase ? { phase: opts.phase } : {}),
			...(opts.completeTurn ? { complete_turn: true } : {}),
			...(opts.turnKind ? { turn_kind: opts.turnKind } : {}),
			...(opts.workTrail ? { work_trail: opts.workTrail } : {}),
			...(opts.agentStats ? { agent_stats: opts.agentStats } : {}),
		});
		return true;
	} catch (err) {
		debug(`postToSession failed: ${err instanceof Error ? err.message : err}`);
		if (!postWarnedThisTurn) {
			postWarnedThisTurn = true;
			notify(lastCtx, `DevSpec remote: post failed (${err instanceof Error ? err.message.slice(0, 120) : err}) — further failures this turn logged to debug only.`, "warning");
		}
		return false;
	}
}

function trailTick(): void {
	if (!turn?.dirty) return;
	const now = Date.now();
	if (now - turn.lastPostAt < nextTrailDelayMs(turn.posts)) return;
	const rendered = turn.trail.render();
	if (!rendered) return;
	turn.dirty = false;
	turn.posts += 1;
	turn.lastPostAt = now;
	void postToSession(rendered, { phase: "trail" });
}

/**
 * Explicitly close this connection's activity attempt (item 2c20337a). The
 * busy:false heartbeat is deliberately discarded server-side while the
 * attempt's lease is fresh (anti-flap, 8792f549), so a turn that ends WITHOUT
 * a complete_turn post — aborted, empty, or the answer post failed — would
 * otherwise strand the Working indicator until lease expiry. report_complete
 * is the explicit channel; idempotent when the attempt already closed.
 */
async function reportComplete(reason: string): Promise<void> {
	const active = pump;
	if (!active || active.stop) return;
	const resolved = await resolveToken();
	if (!resolved) return;
	try {
		await callDevspec(resolved.token, "report_complete", {
			connection_id: active.bond.connectionId,
			reason,
		}, { timeoutMs: 10_000 });
	} catch {
		/* best-effort — lease expiry + the disconnect paths are the backstop */
	}
}

/**
 * Settle the turn. Returns true when a final answer post with complete_turn
 * landed (that post closes the activity attempt itself); false means the turn
 * ended silently (aborted/empty/failed post) and the caller must close the
 * attempt explicitly via reportComplete.
 */
async function settleTurn(agentStats: AgentStatsReport | null): Promise<boolean> {
	const t = turn;
	turn = null;
	if (!t) { debug("settleTurn: no turn state"); return false; }
	if (t.interval) clearInterval(t.interval);
	const bond = getBond();
	if (!bond?.sessionId) { debug("settleTurn: not attached"); return false; }

	// The final render rides the answer post (item 9b7455df): the server
	// REPLACES the fold-merged accumulation with this canonical final render —
	// every tool closed, full thinking — so the preserved 'Show work' is exact,
	// and one fewer post is spent. A turn with no answer still flushes its
	// trail the old way so the work is visible.
	const finalTrail = t.trail.render();
	const plan = planSettle(t.tracker, true);
	debug(`settleTurn: plan ${plan.kind}, final trail ${finalTrail.length} chars`);
	if (plan.kind === "final") {
		// phase 'answer' closes the trail bubble (preserved as "Show work").
		return await postToSession(plan.message, { phase: "answer", completeTurn: true, workTrail: finalTrail || undefined, agentStats: agentStats ?? undefined });
	} else if (plan.kind === "local_mirror") {
		await postToSession(plan.prompt, { turnKind: "local_prompt" });
		return await postToSession(plan.answer, { phase: "answer", completeTurn: true, workTrail: finalTrail || undefined, agentStats: agentStats ?? undefined });
	}
	if (t.dirty && finalTrail) {
		await postToSession(finalTrail, { phase: "trail" });
	}
	return false;
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
		});
	} catch {
		/* presence is best-effort — the next poll re-asserts */
	}
}

function notify(ctx: ExtensionContext | null, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx?.hasUI) ctx.ui.notify(message, level);
}

function setRemoteStatus(ctx: ExtensionContext | null): void {
	if (!ctx?.hasUI) return;
	const bond = getBond();
	ctx.ui.setStatus("devspec-remote", bond ? `⛁ ${bond.codename ?? "bonded"}` : undefined);
}

async function stopPump(ctx: ExtensionContext | null, reason: "local_stop" | "owner_gone", serverAlreadyEnded = false): Promise<void> {
	const active = pump;
	if (!active) return;
	active.stop = true;
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
		});
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
	debug(`push reconnect attempt ${active.pushAttempts} in ${delay}ms`);
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
				debug(`push channel closed: ${reason}`);
				schedulePushReconnect(active, token, endpoint);
				signalWake(active);
			},
		},
	}).catch((err) => {
		if (controller.signal.aborted) return;
		debug(`push channel connect failed: ${err instanceof Error ? err.message : err}`);
		schedulePushReconnect(active, token, endpoint);
		signalWake(active);
	});
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
		// Server told us the bond ended — tear down without re-ending it.
		if (active.pushEnded !== undefined) {
			notify(ctx, `DevSpec remote: connection ended${active.pushEnded ? ` (${active.pushEnded})` : ""}.`, "info");
			await stopPump(ctx, "owner_gone", true);
			return;
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
					cursor: active.cursor,
					dispatch_cursor: active.dispatchCursor,
					wait_ms: pushMode ? 0 : POLL_WAIT_MS,
					busy: active.busy,
					listener_armed: true,
					agent_name: AGENT_NAME,
				},
				{ timeoutMs: POLL_TIMEOUT_MS, cwd: ctx.cwd },
			);
			const { details, isError, text } = unwrapMcpResult(raw);
			if (isError) throw new Error(text || "poll_connection failed");
			payload = details;
			active.errors = 0;
		} catch (err) {
			if (err instanceof DevspecAuthError) {
				notify(ctx, "DevSpec remote: token rejected — bond ended. /devspec.login to reconnect.", "error");
				await stopPump(ctx, "owner_gone");
				return;
			}
			active.errors += 1;
			if (active.errors >= MAX_CONSECUTIVE_ERRORS) {
				notify(ctx, `DevSpec remote: ${active.errors} consecutive poll failures — bond ended locally.`, "error");
				await stopPump(ctx, "owner_gone");
				return;
			}
			await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
			continue;
		}

		if (active.stop || pump !== active) return;

		// The long-poll path also reports server-side ends (status: 'ended').
		const status = (payload as { status?: string } | null)?.status;
		if (status === "ended" || status === "not_found") {
			const endReason = (payload as { end_reason?: string | null } | null)?.end_reason;
			notify(ctx, `DevSpec remote: connection ended${endReason ? ` (${endReason})` : ""}.`, "info");
			await stopPump(ctx, "owner_gone", true);
			return;
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
			const next = { ...active.bond, sessionId: serverSessionId ?? undefined };
			active.bond = next;
			setBond(next);
			debug(`attachment adopted from server: ${serverSessionId ?? "sessionless"}`);
		}

		const pkg = parsePollPayload(payload, active.bond.connectionId);
		if (pkg.cursor) active.cursor = pkg.cursor;
		if (pkg.dispatchCursor) active.dispatchCursor = pkg.dispatchCursor;

		// Cold-start orientation: cursors adopted above, nothing delivered.
		if (!active.synced) {
			active.synced = true;
			// Room orientation: the catch-up window's ambient context becomes a
			// one-shot digest (injected by devspec-context on the next turn) so
			// the agent sees what it missed — including its own prior answers —
			// without anything being replayed as an instruction.
			const digest = buildRoomDigest(payload, active.bond.codename ?? "this agent");
			if (digest) {
				setBond({ ...active.bond, roomDigest: digest });
				debug(`synced with room digest (${digest.length} chars)`);
			} else {
				debug(`synced (cursor ${active.cursor ?? "none"}; ${pkg.ownerCommands.length} historical command(s) not replayed)`);
			}
			continue;
		}

		for (const cmd of pkg.ownerCommands) {
			try {
				if (ctx.isIdle()) {
					pi_send(formatInboundMessage(cmd, active.bond.codename ?? "this agent"));
				} else {
					pi_send(formatInboundMessage(cmd, active.bond.codename ?? "this agent"), true);
				}
				notify(ctx, `DevSpec remote: delivered owner message (${cmd.userName ?? "owner"}).`);
			} catch (err) {
				notify(ctx, `DevSpec remote: failed to deliver owner message: ${err instanceof Error ? err.message : err}`, "warning");
			}
		}
		const dispatches = (payload as { dispatches?: unknown[] } | null)?.dispatches ?? [];
		for (const dispatch of dispatches) {
			try {
				const message = formatDispatchMessage(dispatch, active.bond.codename ?? "this agent");
				if (ctx.isIdle()) pi_send(message);
				else pi_send(message, true);
				notify(ctx, "DevSpec remote: work dispatch delivered.");
			} catch (err) {
				notify(ctx, `DevSpec remote: failed to deliver dispatch: ${err instanceof Error ? err.message : err}`, "warning");
			}
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
	try {
		const regRaw = await callDevspec(resolved.token, "register_connection", {
			local_id: localId,
			agent_name: AGENT_NAME,
			machine_hostname: hostname(),
			cwd: ctx.cwd,
		}, { cwd: ctx.cwd });
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
			}, { cwd: ctx.cwd });
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
	pump = { bond, busy: false, stop: false, errors: 0, synced: false, pushAttempts: 0 };
	setRemoteStatus(ctx);
	void pumpLoop(ctx);
	return { ok: true, codename: bond.codename, attached };
}

// Late-bound so the loop can reference the ExtensionAPI closure.
let pi_send: (message: string, followUp?: boolean) => void = () => {};

export default function (pi: ExtensionAPI) {
	pi_send = (message, followUp) =>
		followUp ? pi.sendUserMessage(message, { deliverAs: "followUp" }) : pi.sendUserMessage(message);

	pi.on("agent_start", () => {
		if (pump) {
			pump.busy = true;
			void beatBusy(true);
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		// Settle telemetry FIRST (pure, instant) so the idle heartbeat and the
		// answer post carry this turn's report, not the previous one's.
		const agentStats = settleTelemetry();
		if (pump) {
			pump.busy = false;
			void beatBusy(false, agentStats);
		}
		void (async () => {
			const posted = await settleTurn(agentStats);
			// No complete_turn post landed (aborted/empty turn, or the post
			// failed) — close the working attempt explicitly (item 2c20337a).
			if (!posted) await reportComplete("turn_end");
		})();
	});

	// ---- Turn lifecycle events (mechanical trail + final answer) ------------

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
		if (!getBond()?.sessionId) { debug("turn_start: not attached, skipping"); return; }
		turn = { tracker: new TurnTracker(), trail: new TrailBuilder(), dirty: false, interval: null, posts: 0, lastPostAt: 0 };
		postWarnedThisTurn = false;
		debug("turn_start: tracking");
		turn.interval = setInterval(trailTick, TRAIL_INTERVAL_MS);
		// Don't hold the process open for the trail timer in headless runs.
		if (typeof turn.interval.unref === "function") turn.interval.unref();
	});

	pi.on("message_start", (event, ctx) => {
		lastCtx = ctx;
		if (!turn) return;
		const msg = event.message as { role?: string } | undefined;
		if (msg?.role === "user") turn.tracker.userMessage(extractText(event.message));
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
			const { text, thinking } = extractAssistantParts(event.message);
			turn.trail.setThinking(thinking);
			turn.trail.setText(text);
			turn.dirty = true;
			turn.tracker.assistantFinal(text);
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		lastCtx = ctx;
		if (!turn) return;
		turn.trail.toolStart(event.toolName, event.args);
		turn.dirty = true;
	});

	pi.on("tool_execution_end", (event, ctx) => {
		lastCtx = ctx;
		if (!turn) return;
		turn.trail.toolEnd(event.toolName, !event.isError, event.result);
		turn.tracker.toolEnd(event.toolName, event.isError ?? false);
		turn.dirty = true;
	});

	pi.on("session_shutdown", async () => {
		// Extensions are rebound on session switch; the pump must not outlive it.
		if (turn?.interval) clearInterval(turn.interval);
		turn = null;
		const active = pump;
		if (!active) return;
		active.stop = true;
		active.pushAbort?.abort();
		if (active.pushReconnectTimer) clearTimeout(active.pushReconnectTimer);
		if (active.wakeWaiter) {
			const w = active.wakeWaiter;
			active.wakeWaiter = null;
			w();
		}
		pump = null;
		setBond(null);

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
			}, { timeoutMs: 3_000 });
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
			notify(ctx, `DevSpec remote: auto-bonded as ${outcome.codename ?? "agent"} — you're reachable from the Agents page. /devspec.remote stop to end.`);
		}
	});

	pi.registerCommand("devspec.remote", {
		description: "Bond this pi session as DevSpec capacity. Usage: /devspec.remote [--session <id>] | stop | auto [on|off]",
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
