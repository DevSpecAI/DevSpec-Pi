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
import { resolveToken } from "./core/auth-store.ts";
import { callDevspec, DevspecAuthError } from "./core/client.ts";
import { getBond, setBond, type BondState } from "./core/bond-state.ts";
import { formatInboundMessage, parsePollPayload } from "./core/remote-payload.ts";
import { unwrapMcpResult } from "./core/result.ts";

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
}

let pump: PumpState | null = null;

function notify(ctx: ExtensionContext | null, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx?.hasUI) ctx.ui.notify(message, level);
}

function setRemoteStatus(ctx: ExtensionContext | null): void {
	if (!ctx?.hasUI) return;
	const bond = getBond();
	ctx.ui.setStatus("devspec-remote", bond ? `⛁ ${bond.codename ?? "bonded"}` : undefined);
}

async function stopPump(ctx: ExtensionContext | null, reason: "local_stop" | "owner_gone"): Promise<void> {
	const active = pump;
	if (!active) return;
	active.stop = true;
	pump = null;
	setBond(null);
	setRemoteStatus(ctx);
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

async function pumpLoop(ctx: ExtensionContext): Promise<void> {
	const active = pump;
	if (!active) return;
	const resolved = await resolveToken();
	if (!resolved) return;
	const token = resolved.token;

	while (pump === active && !active.stop) {
		let payload: unknown;
		try {
			const raw = await callDevspec(
				token,
				"poll_connection",
				{
					connection_id: active.bond.connectionId,
					cursor: active.cursor,
					dispatch_cursor: active.dispatchCursor,
					wait_ms: POLL_WAIT_MS,
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
		if (pkg.dispatchCount > 0) {
			notify(ctx, `DevSpec remote: ${pkg.dispatchCount} work dispatch(es) waiting (dispatch handling lands in slice 2).`);
		}
	}
}

// Late-bound so the loop can reference the ExtensionAPI closure.
let pi_send: (message: string, followUp?: boolean) => void = () => {};

export default function (pi: ExtensionAPI) {
	pi_send = (message, followUp) =>
		followUp ? pi.sendUserMessage(message, { deliverAs: "followUp" }) : pi.sendUserMessage(message);

	pi.on("agent_start", () => {
		if (pump) pump.busy = true;
	});
	pi.on("agent_settled", () => {
		if (pump) pump.busy = false;
	});

	pi.on("session_shutdown", async () => {
		// Extensions are rebound on session switch; the pump must not outlive it.
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
