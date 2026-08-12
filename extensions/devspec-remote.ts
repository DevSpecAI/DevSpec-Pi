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
import { resolveToken } from "./core/auth-store.ts";
import { callDevspec, DevspecAuthError } from "./core/client.ts";
import { getBond, setBond, type BondState } from "./core/bond-state.ts";
import { formatInboundMessage, parsePollPayload } from "./core/remote-payload.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { extractAssistantParts, extractText, TrailBuilder } from "./core/trail.ts";
import { planSettle, TurnTracker } from "./core/turn-lifecycle.ts";
import { formatDispatchMessage } from "./core/dispatch.ts";
import { openPushChannel } from "./core/push-channel.ts";
import { resolveEndpoint } from "./core/auth-store.ts";

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
	// Push channel state (SSE wake mode; falls back to held long-poll).
	pushAbort?: AbortController;
	pushClosed?: boolean;
	pushEnded?: string | null;
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
}

let turn: TurnState | null = null;
let lastCtx: ExtensionContext | null = null;
const TRAIL_INTERVAL_MS = 1_000;

async function postToSession(message: string, opts: { phase?: string; completeTurn?: boolean; turnKind?: string } = {}): Promise<boolean> {
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
		});
		return true;
	} catch (err) {
		debug(`postToSession failed: ${err instanceof Error ? err.message : err}`);
		notify(lastCtx, `DevSpec remote: post failed (${err instanceof Error ? err.message.slice(0, 120) : err})`, "warning");
		return false;
	}
}

function trailTick(): void {
	if (!turn?.dirty) return;
	const rendered = turn.trail.render();
	if (!rendered) return;
	turn.dirty = false;
	void postToSession(rendered, { phase: "trail" });
}

async function settleTurn(): Promise<void> {
	const t = turn;
	turn = null;
	if (!t) { debug("settleTurn: no turn state"); return; }
	if (t.interval) clearInterval(t.interval);
	const bond = getBond();
	if (!bond?.sessionId) { debug("settleTurn: not attached"); return; }

	// Final trail flush, then the settle plan.
	if (t.dirty) {
		const rendered = t.trail.render();
		debug(`settleTurn: trail flush ${rendered.length} chars`);
		if (rendered) await postToSession(rendered, { phase: "trail" });
	} else {
		debug("settleTurn: not dirty, no trail flush");
	}
	const plan = planSettle(t.tracker, true);
	debug(`settleTurn: plan ${plan.kind}`);
	if (plan.kind === "final") {
		// phase 'answer' closes the trail bubble (preserved as "Show work").
		await postToSession(plan.message, { phase: "answer", completeTurn: true });
	} else if (plan.kind === "local_mirror") {
		await postToSession(plan.prompt, { turnKind: "local_prompt" });
		await postToSession(plan.answer, { phase: "answer", completeTurn: true });
	}
}

/**
 * Assert busy presence IMMEDIATELY on turn transitions. The busy flag also
 * rides each poll, but a held long-poll can be 25s old — without this, the
 * Working… indicator lags the real turn by up to a full poll cycle in both
 * directions (observed dogfooding: dots slow to appear, UI stuck on working
 * after the answer). Mechanical heartbeats are contract-sanctioned presence,
 * not prose. Best-effort: the pump remains the presence authority.
 */
async function beatBusy(busy: boolean): Promise<void> {
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

/** Try to open the SSE push channel. True = push mode active. */
function startPushChannel(active: PumpState, token: string, endpoint: string): boolean {
	const controller = new AbortController();
	active.pushAbort = controller;
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
				active.pushClosed = true;
				debug(`push channel closed: ${reason}`);
				signalWake(active);
			},
		},
	}).catch((err) => {
		if (controller.signal.aborted) return;
		active.pushClosed = true;
		debug(`push channel connect failed: ${err instanceof Error ? err.message : err}`);
		signalWake(active);
	});
	return true;
}

async function pumpLoop(ctx: ExtensionContext): Promise<void> {
	const active = pump;
	if (!active) return;
	const resolved = await resolveToken();
	if (!resolved) return;
	const token = resolved.token;

	// Push mode: SSE wakes us; we fetch the package with a no-hold poll.
	// Falls back to the held long-poll if the channel is unavailable.
	let pushMode = startPushChannel(active, token, await resolveEndpoint());
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

		const pkg = parsePollPayload(payload, active.bond.connectionId);
		if (pkg.cursor) active.cursor = pkg.cursor;
		if (pkg.dispatchCursor) active.dispatchCursor = pkg.dispatchCursor;

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
	pi.on("agent_settled", () => {
		if (pump) {
			pump.busy = false;
			void beatBusy(false);
		}
		void settleTurn();
	});

	// ---- Turn lifecycle events (mechanical trail + final answer) ------------

	pi.on("turn_start", (_event, ctx) => {
		lastCtx = ctx;
		if (!getBond()?.sessionId) { debug("turn_start: not attached, skipping"); return; }
		turn = { tracker: new TurnTracker(), trail: new TrailBuilder(), dirty: false, interval: null };
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
		if (!turn) { debug("message_end: no turn"); return; }
		const msg = event.message as { role?: string } | undefined;
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
		if (pump) {
			pump.stop = true;
			pump = null;
			setBond(null);
		}
	});

	pi.registerCommand("devspec.remote", {
		description: "Bond this pi session as DevSpec capacity. Usage: /devspec.remote [--session <id>] | stop",
		handler: async (args, ctx) => {
			const arg = args.trim();

			if (arg === "stop" || arg === "off" || arg === "end") {
				if (!pump) {
					notify(ctx, "DevSpec remote: not bonded.", "info");
					return;
				}
				const codename = pump.bond.codename;
				await stopPump(ctx, "local_stop");
				notify(ctx, `DevSpec remote: bond ended${codename ? ` (${codename})` : ""}.`);
				return;
			}

			if (pump) {
				notify(ctx, `DevSpec remote: already bonded as ${pump.bond.codename ?? pump.bond.connectionId}. Use /devspec.remote stop first.`, "warning");
				return;
			}

			const resolved = await resolveToken();
			if (!resolved) {
				notify(ctx, "Not connected to DevSpec — /devspec.login first.", "warning");
				return;
			}

			// Register/revive the bond. local_id = this pi conversation's id.
			const localId = ctx.sessionManager.getSessionId();
			const regRaw = await callDevspec(resolved.token, "register_connection", {
				local_id: localId,
				agent_name: AGENT_NAME,
				machine_hostname: hostname(),
				cwd: ctx.cwd,
			}, { cwd: ctx.cwd });
			const reg = unwrapMcpResult(regRaw);
			if (reg.isError) {
				notify(ctx, `DevSpec remote: register failed: ${reg.text}`, "error");
				return;
			}
			const d = (reg.details ?? {}) as Record<string, unknown>;
			const connectionId = (d.connection_id ?? d.connectionId) as string | undefined;
			if (!connectionId) {
				notify(ctx, `DevSpec remote: register returned no connection id: ${reg.text.slice(0, 200)}`, "error");
				return;
			}

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

			// Optional attach.
			const sessionMatch = arg.match(/^(?:--session|-s)\s+(\S+)$/);
			if (sessionMatch) {
				const attRaw = await callDevspec(resolved.token, "attach_connection", {
					connection_id: connectionId,
					session_id: sessionMatch[1],
				}, { cwd: ctx.cwd });
				const att = unwrapMcpResult(attRaw);
				if (att.isError) {
					notify(ctx, `DevSpec remote: bonded but attach failed: ${att.text}`, "warning");
				} else {
					const ad = (att.details ?? {}) as Record<string, unknown>;
					bond.sessionId = (ad.session_id as string | undefined) ?? bond.sessionId;
				}
			}

			setBond(bond);
			pump = { bond, busy: false, stop: false, errors: 0 };
			setRemoteStatus(ctx);
			void pumpLoop(ctx);

			notify(
				ctx,
				`DevSpec remote: bonded as ${bond.codename ?? connectionId.slice(0, 8)}` +
					`${bond.sessionId ? " · attached" : " · sessionless (available on the Agents page)"}. ` +
					`Owner messages will arrive as user messages here.`,
			);
		},
	});
}
