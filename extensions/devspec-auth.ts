/**
 * DevSpec Pi — authentication extension.
 *
 * Commands:
 *   /devspec.login [token]   — verify + store a token (paste from DevSpec's
 *                              Agents settings page), or use DEVSPEC_MCP_TOKEN
 *   /devspec.logout          — remove the stored token
 *   /devspec.status          — show connection state
 *
 * On session start: resolves the token, shows connection state in the footer,
 * and verifies once per process (never on a timer — rate budget matters).
 *
 * Headless (print/json modes): no prompts, no status line; login explains the
 * env-var path instead. See VISION.md principle 2 (headless-first).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAdapterGuardState, SUPPRESSION_NOTICE } from "./core/adapter-overlap.ts";
import { clearAuth, resolveEndpoint, resolveToken, saveAuth } from "./core/auth-store.ts";
import { agentsSettingsUrl, mcpUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { DevspecAuthError, resetClientCache, verifyToken } from "./core/client.ts";
import { unwrapMcpResult } from "./core/result.ts";

const STATUS_KEY = "devspec";

/** Process-local verification state — verify at most once per process. */
let verifiedPrincipal: string | null = null;
let verifyAttempted = false;
let verifiedConnection = false;

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
}

function readablePrincipal(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.trim();
	// Identity is display data, not response syntax or terminal control output.
	// Do not impose a length cap or silently crop a person's name (6673868e).
	if (!name || /^[{\[]/.test(name) || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
	return name;
}

/** Only structured identity fields, never an arbitrary first response line. */
export function principalFrom(result: unknown): string | null {
	const { details, isError } = unwrapMcpResult(result);
	if (isError) return null;
	if (details && typeof details === "object") {
		const d = details as Record<string, unknown>;
		// connected_as is verify_agent_connection's current wire field. Keep the
		// explicit older identity shapes, but never fall back to its message text.
		for (const key of ["connected_as", "name", "user_name", "display_name", "email", "principal"]) {
			const name = readablePrincipal(d[key]);
			if (name) return name;
		}
		if (details && typeof (d.user as unknown) === "object" && d.user !== null) {
			const u = d.user as Record<string, unknown>;
			return readablePrincipal(u.name) ?? readablePrincipal(u.email);
		}
	}
	return null;
}

async function doLogin(token: string, ctx: ExtensionContext): Promise<boolean> {
	try {
		const result = await verifyToken(token);
		const { isError, text } = unwrapMcpResult(result);
		if (isError) {
			ctx.ui.notify(`DevSpec login failed: ${text}`, "error");
			return false;
		}
		const principal = principalFrom(result);
		verifiedPrincipal = principal;
		verifyAttempted = true;
		verifiedConnection = true;
		await saveAuth({ token, url: mcpUrl(), principal: principal ?? undefined, verifiedAt: new Date().toISOString() });
		setStatus(ctx, undefined); // Successful identity is available in /devspec.status, not the footer.
		const extra = getAdapterGuardState().suppressed.length > 0 ? ` ${SUPPRESSION_NOTICE}` : "";
		ctx.ui.notify(`Connected to DevSpec${principal ? ` as ${principal}` : ""}.${extra}`, "info");
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`DevSpec login failed: ${message}`, "error");
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("devspec.login", {
		description: `Connect to DevSpec. Paste an access token from ${agentsSettingsUrl()} (or set ${TOKEN_ENV_VAR}).`,
		handler: async (args, ctx) => {
			const envToken = process.env[TOKEN_ENV_VAR];
			let token = args.trim();

			if (!token && envToken) {
				token = envToken.trim();
				ctx.ui.notify(`Using token from ${TOKEN_ENV_VAR}.`, "info");
			}

			if (!token) {
				if (!ctx.hasUI) {
					// Headless: no prompt possible. Tell the operator the env path.
					ctx.ui.notify(
						`DevSpec login: set ${TOKEN_ENV_VAR} (mint one at ${agentsSettingsUrl()}) and re-run.`,
						"warning",
					);
					return;
				}
				const entered = await ctx.ui.input(
					"Connect to DevSpec",
					`Paste an access token from ${agentsSettingsUrl()}`,
				);
				token = (entered ?? "").trim();
				if (!token) {
					ctx.ui.notify("DevSpec login cancelled.", "info");
					return;
				}
			}

			await doLogin(token, ctx);
		},
	});

	pi.registerCommand("devspec.logout", {
		description: "Remove the stored DevSpec token from this machine.",
		handler: async (_args, ctx) => {
			await clearAuth();
			resetClientCache();
			verifiedPrincipal = null;
			verifyAttempted = false;
			verifiedConnection = false;
			setStatus(ctx, undefined);
			ctx.ui.notify(
				`DevSpec token removed.${process.env[TOKEN_ENV_VAR] ? ` Note: ${TOKEN_ENV_VAR} is still set in the environment.` : ""}`,
				"info",
			);
		},
	});

	pi.registerCommand("devspec.status", {
		description: "Show DevSpec connection state (token source, principal, endpoint).",
		handler: async (_args, ctx) => {
			const resolved = await resolveToken();
			if (!resolved) {
				ctx.ui.notify(
					`DevSpec: not connected. Run /devspec.login or set ${TOKEN_ENV_VAR}. Tokens: ${agentsSettingsUrl()}`,
					"warning",
				);
				return;
			}
			const who = verifiedPrincipal ?? (verifiedConnection ? "connected" : "not verified this session");
			const endpoint = await resolveEndpoint();
			ctx.ui.notify(
				`DevSpec: token from ${resolved.source === "env" ? TOKEN_ENV_VAR : "login store"} · ${who} · ${endpoint}`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const resolved = await resolveToken();
		if (!resolved) {
			setStatus(ctx, undefined);
			if (ctx.hasUI && ctx.mode === "tui") {
				ctx.ui.notify(`DevSpec: not connected — /devspec.login (tokens: ${agentsSettingsUrl()})`, "warning");
			}
			return;
		}

		setStatus(ctx, "DevSpec: …");

		// Verify once per process, in the background — never block startup,
		// never on a timer (the per-token rate budget is shared across plugins).
		if (!verifyAttempted) {
			verifyAttempted = true;
			void verifyToken(resolved.token)
				.then((result) => {
					const { isError } = unwrapMcpResult(result);
					if (isError) throw new DevspecAuthError("verify returned error");
					verifiedPrincipal = principalFrom(result);
					verifiedConnection = true;
					setStatus(ctx, undefined);
				})
				.catch(() => {
					setStatus(ctx, "DevSpec: offline?");
				});
		} else {
			setStatus(ctx, undefined);
		}
	});
}
