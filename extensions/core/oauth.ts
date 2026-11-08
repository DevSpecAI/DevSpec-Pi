/**
 * DevSpec Pi — browser sign-in (OAuth 2.1 authorization code + PKCE).
 *
 * DevSpec's tool endpoint names its authorization server (Clerk) in its
 * protected-resource metadata (RFC 9728). Pi signs in through its own
 * pre-registered public client at that server, so the approval page shows Pi
 * and the Agents page lists Pi on its own line (decisions 7f6b2262, 912b3b3e).
 *
 * The approval always returns through the person's own browser (risk 65cc21b1):
 * - normally to a short-lived listener on 127.0.0.1 (RFC 8252 loopback);
 * - where the browser cannot reach this machine (SSH, a remote box), to
 *   DevSpec's own "copy this code" page, and the person pastes `code#state`
 *   back into Pi.
 * Nothing ever learns the result by polling a server, and the authorization
 * code is useless without the PKCE verifier that never leaves this process.
 *
 * Pure node, no pi imports, so it runs under `node --test`.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Scopes every DevSpec sign-in asks for: DevSpec access, plus renewal. */
export const SIGN_IN_SCOPE = "devspec offline_access";

/**
 * Pi's own sign-in app on each DevSpec Clerk instance, by issuer. A public
 * client id is an identifier, not a secret. Keyed by the authorization server
 * rather than the DevSpec address, so a local DevSpec on the Development
 * instance signs in exactly like staging does.
 */
export const PI_CLIENT_IDS: Readonly<Record<string, string>> = Object.freeze({
	"https://clerk.devspec.ai": "0WORfT6JYchcBDDq",
	"https://apt-hare-75.clerk.accounts.dev": "bWlWy3fvhxrNU2LT",
});

/**
 * How long an unanswered sign-in keeps its local listener open. The listener
 * is a port on this machine waiting for a browser, so it must close by itself;
 * ten minutes matches how long Clerk keeps an authorization request alive.
 */
export const SIGN_IN_WAIT_MS = 10 * 60 * 1000;

/** One network round trip to DevSpec or Clerk during sign-in or renewal. */
export const SIGN_IN_REQUEST_TIMEOUT_MS = 15_000;

export class SignInError extends Error {}

/** The server refused to renew: the sign-in is over until the person signs in again. */
export class SignInEndedError extends SignInError {}

export interface SignInDiscovery {
	/** The DevSpec tool endpoint, exactly as its metadata names it. */
	resource: string;
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
}

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds. */
	issuedAt: number;
	expiresAt: number;
}

type Fetch = typeof fetch;

/** Origin + path with no trailing slash, query or fragment: one key per DevSpec server. */
export function normalizeResource(url: string): string {
	const parsed = new URL(url);
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

async function getJson(url: string, fetchImpl: Fetch): Promise<unknown> {
	const response = await fetchImpl(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new SignInError(`${url} answered ${response.status}`);
	return response.json();
}

function stringField(value: unknown, key: string): string | undefined {
	const field = (value as Record<string, unknown> | null)?.[key];
	return typeof field === "string" && field ? field : undefined;
}

/**
 * Find where this DevSpec server sends people to sign in. Refuses a server that
 * does not offer browser sign-in, or metadata that names a different endpoint.
 */
export async function discoverSignIn(mcpUrl: string, fetchImpl: Fetch = fetch): Promise<SignInDiscovery> {
	const resource = normalizeResource(mcpUrl);
	const { origin, pathname } = new URL(resource);
	let metadata: unknown;
	try {
		metadata = await getJson(`${origin}/.well-known/oauth-protected-resource${pathname}`, fetchImpl);
	} catch {
		throw new SignInError(`This DevSpec server (${origin}) does not offer browser sign-in yet.`);
	}
	if (stringField(metadata, "resource") === undefined || normalizeResource(stringField(metadata, "resource")!) !== resource) {
		throw new SignInError(`This DevSpec server's sign-in details are for a different address than ${resource}.`);
	}
	const servers = (metadata as { authorization_servers?: unknown }).authorization_servers;
	const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0].replace(/\/+$/, "") : undefined;
	if (!issuer) throw new SignInError("This DevSpec server does not name where to sign in.");

	const server = await getJson(`${issuer}/.well-known/oauth-authorization-server`, fetchImpl);
	if (stringField(server, "issuer")?.replace(/\/+$/, "") !== issuer) {
		throw new SignInError("DevSpec's sign-in server described itself as a different server.");
	}
	const authorizationEndpoint = stringField(server, "authorization_endpoint");
	const tokenEndpoint = stringField(server, "token_endpoint");
	if (!authorizationEndpoint || !tokenEndpoint) throw new SignInError("DevSpec's sign-in server did not list its endpoints.");
	return {
		resource: stringField(metadata, "resource")!,
		issuer,
		authorizationEndpoint,
		tokenEndpoint,
		revocationEndpoint: stringField(server, "revocation_endpoint"),
	};
}

export function clientIdFor(issuer: string): string {
	const clientId = PI_CLIENT_IDS[issuer];
	if (!clientId) {
		throw new SignInError(
			`This version of DevSpec for Pi does not know how to sign in to ${issuer}. Update with \`pi update npm:@devspecai/pi-plugin\`.`,
		);
	}
	return clientId;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

export function createPkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizationUrl(input: {
	discovery: SignInDiscovery;
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
}): string {
	const url = new URL(input.discovery.authorizationEndpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: input.clientId,
		redirect_uri: input.redirectUri,
		scope: SIGN_IN_SCOPE,
		state: input.state,
		code_challenge: input.challenge,
		code_challenge_method: "S256",
		resource: input.discovery.resource,
	}).toString();
	return url.toString();
}

async function postToken(tokenEndpoint: string, body: Record<string, string>, fetchImpl: Fetch): Promise<TokenSet> {
	const response = await fetchImpl(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
	});
	const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (!response.ok) {
		const code = typeof payload?.error === "string" ? payload.error : `status ${response.status}`;
		// invalid_grant: the code or renewal key is spent, revoked or expired. The
		// grant is over; anything else may be transient and is worth retrying.
		if (code === "invalid_grant") throw new SignInEndedError("DevSpec ended this sign-in.");
		throw new SignInError(`DevSpec's sign-in server refused the request (${code}).`);
	}
	const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
	const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
	const expiresIn = typeof payload?.expires_in === "number" ? payload.expires_in : NaN;
	if (!accessToken || !refreshToken || !Number.isFinite(expiresIn)) {
		throw new SignInError("DevSpec's sign-in server answered without a complete sign-in.");
	}
	const issuedAt = Date.now();
	return { accessToken, refreshToken, issuedAt, expiresAt: issuedAt + expiresIn * 1000 };
}

export function exchangeCode(input: {
	discovery: SignInDiscovery;
	clientId: string;
	code: string;
	redirectUri: string;
	verifier: string;
}, fetchImpl: Fetch = fetch): Promise<TokenSet> {
	return postToken(input.discovery.tokenEndpoint, {
		grant_type: "authorization_code",
		code: input.code,
		redirect_uri: input.redirectUri,
		client_id: input.clientId,
		code_verifier: input.verifier,
		resource: input.discovery.resource,
	}, fetchImpl);
}

/**
 * Renew a sign-in. Clerk rotates the renewal key on every use and treats a
 * second use of the same key as theft, ending the grant, so callers must hold
 * the store lock (auth-store.ts) around this.
 */
export function refreshTokens(input: {
	tokenEndpoint: string;
	clientId: string;
	refreshToken: string;
	resource: string;
}, fetchImpl: Fetch = fetch): Promise<TokenSet> {
	return postToken(input.tokenEndpoint, {
		grant_type: "refresh_token",
		refresh_token: input.refreshToken,
		client_id: input.clientId,
		resource: input.resource,
	}, fetchImpl);
}

/** Best effort: cancel the grant at Clerk when the person signs out. */
export async function revokeRefreshToken(input: {
	revocationEndpoint?: string;
	clientId: string;
	refreshToken: string;
}, fetchImpl: Fetch = fetch): Promise<void> {
	if (!input.revocationEndpoint) return;
	await fetchImpl(input.revocationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ token: input.refreshToken, token_type_hint: "refresh_token", client_id: input.clientId }).toString(),
		signal: AbortSignal.timeout(SIGN_IN_REQUEST_TIMEOUT_MS),
	}).catch(() => {});
}

/** Open a URL in the default browser without a shell (no metacharacter re-parsing). */
export function openInBrowser(url: string): void {
	const [cmd, args]: [string, string[]] = process.platform === "darwin"
		? ["open", [url]]
		: process.platform === "win32"
			? ["rundll32", ["url.dll,FileProtocolHandler", url]]
			: ["xdg-open", [url]];
	spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/**
 * Whether a browser opened here can reach a listener on this machine. Over SSH
 * the browser runs on the person's own computer, where 127.0.0.1 is not us.
 */
export function browserCanReachThisMachine(env: NodeJS.ProcessEnv = process.env): boolean {
	return !env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT;
}

const PAGE_STYLE = "font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#1f2933";

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body style="${PAGE_STYLE}"><h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body></html>`;
}

function reply(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(html);
}

export interface PendingSignIn {
	/** The page to open; also shown so the person can click it themselves. */
	url: string;
	/** Settles with the new sign-in, or rejects when cancelled, refused or timed out. */
	done: Promise<TokenSet>;
	cancel(): void;
}

/**
 * Sign in through a loopback listener: open `url`, and the browser brings the
 * approval back to this process. `state` and the issuer echo (RFC 9207) are
 * checked before the code is exchanged.
 */
export async function startLoopbackSignIn(input: {
	discovery: SignInDiscovery;
	clientId: string;
	waitMs?: number;
}, fetchImpl: Fetch = fetch): Promise<PendingSignIn> {
	const { verifier, challenge } = createPkce();
	const state = base64url(randomBytes(24));
	let settle!: { resolve(tokens: TokenSet): void; reject(error: Error): void };
	const done = new Promise<TokenSet>((resolve, reject) => { settle = { resolve, reject }; });
	// A replaced or cancelled sign-in may have no listener left; never crash Pi over it.
	done.catch(() => {});
	let finished = false;
	let redirectUri = "";
	let timer: NodeJS.Timeout | undefined;

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		if (requestUrl.pathname !== "/callback" || finished) {
			reply(res, 404, page("Not found", "This address is only used to finish signing in to DevSpec."));
			return;
		}
		const params = requestUrl.searchParams;
		if (params.get("state") !== state) {
			// Not our request (or a replay): never exchange a code we did not ask for.
			reply(res, 400, page("Sign-in not recognised", "This sign-in was not started by this Pi. Start again with /devspec.login."));
			return;
		}
		const iss = params.get("iss");
		if (iss !== null && iss.replace(/\/+$/, "") !== input.discovery.issuer) {
			reply(res, 400, page("Sign-in not recognised", "This sign-in came back from a different server. Start again with /devspec.login."));
			finish(new SignInError("The sign-in came back from a different server."));
			return;
		}
		const error = params.get("error");
		if (error) {
			reply(res, 200, page("Sign-in cancelled", "Nothing was connected. You can close this tab."));
			finish(new SignInError(error === "access_denied" ? "Sign-in was cancelled in the browser." : `Sign-in failed (${error}).`));
			return;
		}
		const code = params.get("code");
		if (!code) {
			reply(res, 400, page("Sign-in incomplete", "The browser did not bring back a sign-in. Start again with /devspec.login."));
			return;
		}
		finished = true;
		exchangeCode({ discovery: input.discovery, clientId: input.clientId, code, redirectUri, verifier }, fetchImpl).then(
			(tokens) => {
				reply(res, 200, page("Signed in to DevSpec", "You can close this tab and go back to Pi."));
				finish(tokens);
			},
			(err: unknown) => {
				reply(res, 500, page("Sign-in failed", "Pi could not finish signing in. Go back to Pi for details."));
				finish(err instanceof Error ? err : new SignInError(String(err)));
			},
		);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	redirectUri = `http://127.0.0.1:${port}/callback`;
	timer = setTimeout(
		() => finish(new SignInError("Sign-in timed out waiting for the browser. Run /devspec.login to try again.")),
		input.waitMs ?? SIGN_IN_WAIT_MS,
	);
	timer.unref();

	function finish(result: TokenSet | Error): void {
		finished = true;
		clearTimeout(timer);
		server.close();
		server.closeAllConnections?.();
		if (result instanceof Error) settle.reject(result);
		else settle.resolve(result);
	}

	return {
		url: authorizationUrl({ discovery: input.discovery, clientId: input.clientId, redirectUri, state, challenge }),
		done,
		cancel: () => finish(new SignInError("Sign-in cancelled.")),
	};
}

/**
 * Sign in where the browser cannot reach this machine: the approval returns to
 * DevSpec's own page (`codePageUrl`), which shows `code#state` for the person to
 * paste back. The pasted state must match the one this process generated.
 */
export function startCopyCodeSignIn(input: {
	discovery: SignInDiscovery;
	clientId: string;
	codePageUrl: string;
}, fetchImpl: Fetch = fetch): { url: string; complete(pasted: string): Promise<TokenSet> } {
	const { verifier, challenge } = createPkce();
	const state = base64url(randomBytes(24));
	return {
		url: authorizationUrl({ discovery: input.discovery, clientId: input.clientId, redirectUri: input.codePageUrl, state, challenge }),
		complete: async (pasted: string) => {
			const value = pasted.trim();
			const hash = value.lastIndexOf("#");
			const code = hash > 0 ? value.slice(0, hash) : "";
			if (!code || value.slice(hash + 1) !== state) {
				throw new SignInError("That code is not from this sign-in. Copy the whole code from the page, or run /devspec.login again.");
			}
			return exchangeCode({ discovery: input.discovery, clientId: input.clientId, code, redirectUri: input.codePageUrl, verifier }, fetchImpl);
		},
	};
}
