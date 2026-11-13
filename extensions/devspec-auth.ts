/**
 * DevSpec Pi — sign-in extension.
 *
 * Commands:
 *   /devspec.login [--code]  — sign in through the browser. `--code` (and any
 *                              SSH session) uses the copy-a-code page instead
 *                              of a local listener.
 *   /devspec.logout          — sign out of the current DevSpec server only
 *   /devspec.status          — show which server, who, and where the credential
 *                              comes from
 *
 * On session start: resolves the credential, says plainly when a sign-in is
 * missing, has ended, or is overridden by DEVSPEC_MCP_TOKEN, and verifies once
 * per process (never on a timer — rate budget matters).
 *
 * Headless (print/json modes): no prompts; login explains the env-var path.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAdapterGuardState, SUPPRESSION_NOTICE } from "./core/adapter-overlap.ts";
import { loginState, removeLogin, resolveToken, saveLogin, setSignedInAs } from "./core/auth-store.ts";
import { agentsSettingsUrl, environmentLabel, mcpUrl, signInCodePageUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { DevspecAuthError, resetClientCache, verifyToken } from "./core/client.ts";
import {
	browserCanReachThisMachine,
	clientIdFor,
	discoverSignIn,
	openInBrowser,
	revokeRefreshToken,
	startCopyCodeSignIn,
	startLoopbackSignIn,
	type PendingSignIn,
	type SignInDiscovery,
	type TokenSet,
} from "./core/oauth.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { withLiveUi } from "./core/ctx-guard.ts";
import { DEVSPEC_REACHABLE_EVENT } from "./core/startup-connect.ts";

const STATUS_KEY = "devspec";

/** Process-local verification state — verify at most once per process. */
let verifiedPrincipal: string | null = null;
let verifyAttempted = false;
let verifiedConnection = false;

/** Where "DevSpec: offline?" is showing, so it can be cleared once DevSpec answers again. */
let offlineCtx: ExtensionContext | null = null;

/** At most one browser sign-in waits at a time; a new /devspec.login replaces it. */
let pendingSignIn: PendingSignIn | null = null;

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

/** Plain words for a token set in the environment, which always wins over a browser sign-in. */
export function envTokenNotice(): string {
	const where = process.platform === "win32"
		? "System Properties → Environment Variables, and any terminal profile that sets it"
		: "your shell profile (for example ~/.zshrc or ~/.bashrc) and this terminal (`unset " + TOKEN_ENV_VAR + "`)";
	return `${TOKEN_ENV_VAR} is set in this environment, so Pi uses that token and ignores a browser sign-in. ` +
		`To use your browser sign-in, remove ${TOKEN_ENV_VAR} from ${where}, then restart Pi.`;
}

function signInEndedNotice(): string {
	return `Your DevSpec sign-in has ended, for example because Pi was disconnected on ${agentsSettingsUrl()}. ` +
		"Run /devspec.login to sign in again.";
}

async function finishSignIn(
	ctx: ExtensionContext,
	endpoint: string,
	discovery: SignInDiscovery,
	clientId: string,
	tokens: TokenSet,
): Promise<void> {
	// Confirm DevSpec accepts the new sign-in at the very server it was approved
	// for before saving it, so a saved login is always one that worked.
	const result = await verifyToken(tokens.accessToken, endpoint);
	const { isError, text } = unwrapMcpResult(result);
	if (isError) throw new Error(text || "DevSpec did not accept the sign-in.");
	const principal = principalFrom(result);
	await saveLogin({
		endpoint,
		tokens,
		issuer: discovery.issuer,
		tokenEndpoint: discovery.tokenEndpoint,
		revocationEndpoint: discovery.revocationEndpoint,
		clientId,
		resource: discovery.resource,
		signedInAs: principal ?? undefined,
	});
	resetClientCache();
	verifiedPrincipal = principal;
	verifyAttempted = true;
	verifiedConnection = true;
	offlineCtx = null;
	setStatus(ctx, undefined);
	const extra = getAdapterGuardState().suppressed.length > 0 ? ` ${SUPPRESSION_NOTICE}` : "";
	ctx.ui.notify(
		`Signed in to DevSpec (${environmentLabel(endpoint)})${principal ? ` as ${principal}` : ""}. Restart Pi to finish connecting.${extra}`,
		"info",
	);
}

function failureText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function login(args: string, ctx: ExtensionContext): Promise<void> {
	// One server for the whole sign-in: discovered, approved, verified and saved
	// under the same address, so a login can never land under another server.
	const endpoint = mcpUrl();
	const label = environmentLabel(endpoint);

	if (process.env[TOKEN_ENV_VAR]?.trim()) {
		ctx.ui.notify(envTokenNotice(), "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(
			`DevSpec sign-in needs a browser. For a run without one, set ${TOKEN_ENV_VAR} to an access token from ${agentsSettingsUrl()}.`,
			"warning",
		);
		return;
	}

	pendingSignIn?.cancel();
	pendingSignIn = null;

	let discovery: SignInDiscovery;
	let clientId: string;
	try {
		discovery = await discoverSignIn(endpoint);
		clientId = clientIdFor(discovery.issuer);
	} catch (err) {
		ctx.ui.notify(`DevSpec sign-in unavailable: ${failureText(err)}`, "error");
		return;
	}

	const copyCode = args.trim() === "--code" || !browserCanReachThisMachine();
	if (copyCode) {
		const flow = startCopyCodeSignIn({ discovery, clientId, codePageUrl: signInCodePageUrl(endpoint) });
		if (browserCanReachThisMachine()) openInBrowser(flow.url);
		ctx.ui.notify(
			`Sign in to DevSpec (${label}): open this link in a browser, approve, then copy the code it shows:\n\n${flow.url}`,
			"info",
		);
		const pasted = (await ctx.ui.input("Paste the code from the DevSpec page", "code"))?.trim();
		if (!pasted) {
			ctx.ui.notify("DevSpec sign-in canceled.", "info");
			return;
		}
		try {
			await finishSignIn(ctx, endpoint, discovery, clientId, await flow.complete(pasted));
		} catch (err) {
			ctx.ui.notify(`DevSpec sign-in failed: ${failureText(err)}`, "error");
		}
		return;
	}

	let pending: PendingSignIn;
	try {
		pending = await startLoopbackSignIn({ discovery, clientId });
	} catch (err) {
		ctx.ui.notify(`DevSpec sign-in failed: ${failureText(err)}`, "error");
		return;
	}
	pendingSignIn = pending;
	openInBrowser(pending.url);
	ctx.ui.notify(
		`Approve DevSpec (${label}) in your browser. If it did not open, open this link:\n\n${pending.url}\n\n` +
			"Running Pi on a remote machine where a browser cannot open locally? Run /devspec.login --code instead.",
		"info",
	);
	// Wait in the background so Pi stays usable; the result arrives through the browser.
	void pending.done.then(
		(tokens) => {
			if (pendingSignIn !== pending) return;
			pendingSignIn = null;
			return finishSignIn(ctx, endpoint, discovery, clientId, tokens);
		},
		(err: unknown) => {
			if (pendingSignIn !== pending) return;
			pendingSignIn = null;
			ctx.ui.notify(`DevSpec sign-in did not finish: ${failureText(err)}`, "warning");
		},
	).catch((err: unknown) => ctx.ui.notify(`DevSpec sign-in failed: ${failureText(err)}`, "error"));
}

export default function (pi: ExtensionAPI) {
	// The one start-up check found DevSpec offline, and a later background
	// connection proved it answers with this credential (item dffdc30a).
	pi.events?.on(DEVSPEC_REACHABLE_EVENT, () => {
		const ctx = offlineCtx;
		offlineCtx = null;
		if (!ctx) return;
		verifiedConnection = true;
		withLiveUi(ctx, () => setStatus(ctx, undefined));
	});

	pi.registerCommand("devspec.login", {
		description: "Sign in to DevSpec through your browser (add --code on a machine your browser cannot reach).",
		handler: async (args, ctx) => {
			await login(args, ctx);
		},
	});

	pi.registerCommand("devspec.logout", {
		description: "Sign out of the current DevSpec server (staging and production are separate).",
		handler: async (_args, ctx) => {
			const endpoint = mcpUrl();
			pendingSignIn?.cancel();
			pendingSignIn = null;
			const removed = await removeLogin(endpoint);
			if (removed) {
				await revokeRefreshToken({
					revocationEndpoint: removed.revocationEndpoint,
					clientId: removed.clientId,
					refreshToken: removed.refreshToken,
				});
			}
			resetClientCache();
			verifiedPrincipal = null;
			verifyAttempted = false;
			verifiedConnection = false;
			offlineCtx = null;
			setStatus(ctx, undefined);
			const label = environmentLabel(endpoint);
			const envNote = process.env[TOKEN_ENV_VAR]?.trim() ? ` ${envTokenNotice()}` : "";
			ctx.ui.notify(
				`${removed ? `Signed out of DevSpec (${label}).` : `Pi was not signed in to DevSpec (${label}).`}${envNote}`,
				"info",
			);
		},
	});

	pi.registerCommand("devspec.status", {
		description: "Show which DevSpec server Pi uses, who it is signed in as, and where its credential comes from.",
		handler: async (_args, ctx) => {
			const endpoint = mcpUrl();
			const label = environmentLabel(endpoint);
			if (process.env[TOKEN_ENV_VAR]?.trim()) {
				const who = verifiedPrincipal ?? (verifiedConnection ? "connected" : "not verified this session");
				ctx.ui.notify(`DevSpec (${label}): using the token in ${TOKEN_ENV_VAR} · ${who} · ${endpoint}\n${envTokenNotice()}`, "info");
				return;
			}
			const state = await loginState(endpoint);
			if (state.kind === "ended") {
				ctx.ui.notify(`DevSpec (${label}): ${signInEndedNotice()}`, "warning");
				return;
			}
			if (state.kind === "none") {
				ctx.ui.notify(`DevSpec (${label}): not signed in. Run /devspec.login to sign in through your browser.`, "warning");
				return;
			}
			const who = verifiedPrincipal ?? state.login.signedInAs ?? "signed in";
			ctx.ui.notify(`DevSpec (${label}): signed in through the browser as ${who} · ${endpoint}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const interactive = ctx.hasUI && ctx.mode === "tui";
		const endpoint = mcpUrl();
		const resolved = await resolveToken();
		if (!resolved) {
			setStatus(ctx, undefined);
			if (interactive) {
				const state = await loginState(endpoint);
				ctx.ui.notify(
					state.kind === "ended"
						? `DevSpec: ${signInEndedNotice()}`
						: `Welcome to DevSpec (${environmentLabel(endpoint)})! Run /devspec.login to sign in through your browser.`,
					"warning",
				);
			}
			return;
		}
		if (resolved.source === "env" && interactive && (await loginState(endpoint)).kind !== "none") {
			ctx.ui.notify(`DevSpec: ${envTokenNotice()}`, "warning");
		}

		setStatus(ctx, "DevSpec: …");

		// Verify once per process, in the background — never block startup,
		// never on a timer (the per-token rate budget is shared across plugins).
		if (!verifyAttempted) {
			verifyAttempted = true;
			void verifyToken(resolved.token)
				.then(async (result) => {
					const { isError, text } = unwrapMcpResult(result);
					if (isError) throw new DevspecAuthError(text || "DevSpec did not accept the credential.");
					verifiedPrincipal = principalFrom(result);
					verifiedConnection = true;
					setStatus(ctx, undefined);
					const state = resolved.source === "login" ? await loginState(endpoint) : null;
					if (verifiedPrincipal && state?.kind === "active" && state.login.signedInAs !== verifiedPrincipal) {
						await setSignedInAs(endpoint, state.login.loginId, verifiedPrincipal).catch(() => {});
					}
				})
				.catch((err: unknown) => {
					if (err instanceof DevspecAuthError) {
						// A refused credential is said plainly, with what to do next.
						setStatus(ctx, "DevSpec: sign in again");
						if (interactive) ctx.ui.notify(`DevSpec: ${err.message}`, "warning");
						return;
					}
					setStatus(ctx, "DevSpec: offline?");
					offlineCtx = ctx;
				});
		} else {
			setStatus(ctx, undefined);
		}
	});
}
