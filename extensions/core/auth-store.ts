/**
 * DevSpec Pi — sign-in store.
 *
 * Pi's own login file, `<pi-agent-dir>/devspec/auth.json` (0600), holds one
 * browser sign-in per DevSpec server, keyed by the server's tool endpoint, so a
 * staging login and a production login sit side by side and switching servers
 * never needs a fresh login (decision 7f6b2262). No other plugin reads or
 * writes this file: sign-in is once per tool (decision 912b3b3e).
 *
 * Which server is used comes only from the environment (DEVSPEC_MCP_URL, then
 * DEVSPEC_ENV=staging) or production by default. A saved login never chooses
 * the server, and a login is saved only under the server it was approved for.
 *
 * Credential resolution:
 *   1. DEVSPEC_MCP_TOKEN — for runs with no browser (CI, cloud workers). It
 *      wins outright; interactive commands say so when it is set.
 *   2. the browser sign-in saved for the current server, renewed before it
 *      expires.
 *
 * Renewal: Clerk rotates the renewal key on every use and ends the whole grant
 * if one is used twice, so every renewal holds an exclusive lock on the file
 * across Pi processes and re-reads it after taking the lock — another process
 * may already have renewed.
 *
 * Pure node, no pi imports — unit-testable under `node --test`.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devspecDir, mcpUrl, TOKEN_ENV_VAR } from "./config.ts";
import { normalizeResource, refreshTokens, SignInEndedError, type TokenSet } from "./oauth.ts";

const STORE_VERSION = 2;

export interface BrowserLogin {
	accessToken: string;
	refreshToken: string;
	/** ISO timestamps: when the access token was issued and when it stops working. */
	issuedAt: string;
	expiresAt: string;
	issuer: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
	clientId: string;
	/** The tool endpoint this login was approved for, as the server named it. */
	resource: string;
	/** Random per sign-in: identifies this login across renewals, never a secret. */
	loginId: string;
	/** Who DevSpec says this login acts as, for display. */
	signedInAs?: string;
	savedAt: string;
	/** Set when DevSpec refused to renew it: the person must sign in again. */
	endedAt?: string;
}

interface StoreFile {
	version: typeof STORE_VERSION;
	logins: Record<string, BrowserLogin>;
}

export interface ResolvedToken {
	token: string;
	source: "env" | "login";
	/**
	 * Stable, non-secret identity of whoever this credential acts as: it stays the
	 * same across a browser login's renewals, so caches, local room copies and
	 * commit attribution keyed by it survive the daily token change. Read it with
	 * `principalOf`.
	 */
	principal?: string;
}

/** What the store holds for the current server, for status and startup messages. */
export type LoginState =
	| { kind: "none"; legacyToken: boolean }
	| { kind: "active"; login: BrowserLogin }
	| { kind: "ended"; login: BrowserLogin };

/**
 * Renew once an access token is past half its life, so any token Pi hands out
 * still has at least half its life left: long-running work (a remote-control
 * retry, an automation run) never holds one that is about to stop working.
 */
export function needsRenewal(login: Pick<BrowserLogin, "issuedAt" | "expiresAt">, now = Date.now()): boolean {
	const issued = Date.parse(login.issuedAt);
	const expires = Date.parse(login.expiresAt);
	if (!Number.isFinite(issued) || !Number.isFinite(expires)) return true;
	return now >= issued + (expires - issued) / 2;
}

/**
 * A lock older than this is abandoned. A holder only renews (one network round
 * trip, bounded by SIGN_IN_REQUEST_TIMEOUT_MS) or writes the file, so a live
 * holder always finishes well inside it.
 */
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 50;

export function authFilePath(): string {
	return join(devspecDir(), "auth.json");
}

function lockPath(): string {
	return `${authFilePath()}.lock`;
}

/** sha256 hex — the same fingerprint a pasted token always had. */
function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The stable identity of a resolved credential (64 hex characters). A token
 * from the environment is fingerprinted by its value, exactly as before; a
 * browser login by its server, sign-in app and login id, so renewals keep it.
 */
export function principalOf(auth: { token: string; principal?: string }): string {
	return auth.principal ?? sha256(auth.token);
}

function loginPrincipal(login: BrowserLogin): string {
	return sha256(`devspec-pi-login\0${login.issuer}\0${login.clientId}\0${login.loginId}`);
}

function isLogin(value: unknown): value is BrowserLogin {
	const v = value as Partial<BrowserLogin> | null;
	return !!v && typeof v === "object" &&
		typeof v.accessToken === "string" && typeof v.refreshToken === "string" &&
		typeof v.issuedAt === "string" && typeof v.expiresAt === "string" && typeof v.issuer === "string" &&
		typeof v.tokenEndpoint === "string" && typeof v.clientId === "string" &&
		typeof v.resource === "string" && typeof v.loginId === "string";
}

interface ReadResult {
	store: StoreFile;
	/** The file holds a pasted token from a version of Pi before browser sign-in. */
	legacyToken: boolean;
}

async function readStore(): Promise<ReadResult> {
	let raw: string;
	try {
		raw = await readFile(authFilePath(), "utf8");
	} catch {
		return { store: { version: STORE_VERSION, logins: {} }, legacyToken: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { store: { version: STORE_VERSION, logins: {} }, legacyToken: false };
	}
	const p = parsed as { version?: unknown; logins?: unknown; token?: unknown } | null;
	if (p && p.version === STORE_VERSION && p.logins && typeof p.logins === "object") {
		const logins: Record<string, BrowserLogin> = {};
		for (const [key, value] of Object.entries(p.logins as Record<string, unknown>)) {
			if (isLogin(value)) logins[key] = value;
		}
		return { store: { version: STORE_VERSION, logins }, legacyToken: false };
	}
	return { store: { version: STORE_VERSION, logins: {} }, legacyToken: typeof p?.token === "string" };
}

/** Write aside and rename, so a reader never sees half a file. */
async function writeStore(store: StoreFile): Promise<void> {
	await mkdir(devspecDir(), { recursive: true, mode: 0o700 });
	const temp = `${authFilePath()}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
	await chmod(temp, 0o600).catch(() => {});
	await rename(temp, authFilePath());
}

/**
 * The lock's modification time when its holder is gone (crashed mid-renewal) or
 * it is older than any live holder could keep it; null while it is held.
 */
async function staleLockStamp(): Promise<number | null> {
	try {
		const info = await stat(lockPath());
		if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return info.mtimeMs;
		const holder = Number.parseInt(await readFile(lockPath(), "utf8"), 10);
		if (!Number.isInteger(holder) || holder <= 0) return null;
		try {
			process.kill(holder, 0);
			return null;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === "ESRCH" ? info.mtimeMs : null;
		}
	} catch {
		return null;
	}
}

/** Run `work` holding the store's exclusive lock across Pi processes. */
async function withStoreLock<T>(work: () => Promise<T>): Promise<T> {
	await mkdir(devspecDir(), { recursive: true, mode: 0o700 });
	for (;;) {
		try {
			const handle = await open(lockPath(), "wx", 0o600);
			try {
				await handle.writeFile(String(process.pid));
			} finally {
				await handle.close();
			}
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const stale = await staleLockStamp();
			if (stale !== null) {
				// Clear it only if it is still the lock judged stale, not one a
				// waiter beside us has just taken.
				const now = await stat(lockPath()).catch(() => null);
				if (now?.mtimeMs === stale) await rm(lockPath(), { force: true });
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	try {
		return await work();
	} finally {
		await rm(lockPath(), { force: true });
	}
}

export async function loginState(endpoint: string = mcpUrl()): Promise<LoginState> {
	const { store, legacyToken } = await readStore();
	const login = store.logins[normalizeResource(endpoint)];
	if (!login) return { kind: "none", legacyToken };
	return login.endedAt ? { kind: "ended", login } : { kind: "active", login };
}

/** Save a new sign-in under the server it was approved for, replacing only that server's. */
export async function saveLogin(input: {
	endpoint: string;
	tokens: TokenSet;
	issuer: string;
	tokenEndpoint: string;
	revocationEndpoint?: string;
	clientId: string;
	resource: string;
	signedInAs?: string;
}): Promise<BrowserLogin> {
	if (normalizeResource(input.resource) !== normalizeResource(input.endpoint)) {
		throw new Error("A sign-in can only be saved for the server it was approved for.");
	}
	const login: BrowserLogin = {
		accessToken: input.tokens.accessToken,
		refreshToken: input.tokens.refreshToken,
		issuedAt: new Date(input.tokens.issuedAt).toISOString(),
		expiresAt: new Date(input.tokens.expiresAt).toISOString(),
		issuer: input.issuer,
		tokenEndpoint: input.tokenEndpoint,
		...(input.revocationEndpoint ? { revocationEndpoint: input.revocationEndpoint } : {}),
		clientId: input.clientId,
		resource: input.resource,
		loginId: randomUUID(),
		...(input.signedInAs ? { signedInAs: input.signedInAs } : {}),
		savedAt: new Date().toISOString(),
	};
	await withStoreLock(async () => {
		const { store } = await readStore();
		store.logins[normalizeResource(input.endpoint)] = login;
		await writeStore(store);
	});
	return login;
}

/** Record who a saved login acts as, once DevSpec has said. */
export async function setSignedInAs(endpoint: string, loginId: string, signedInAs: string): Promise<void> {
	await withStoreLock(async () => {
		const { store } = await readStore();
		const login = store.logins[normalizeResource(endpoint)];
		if (!login || login.loginId !== loginId) return;
		login.signedInAs = signedInAs;
		await writeStore(store);
	});
}

/** Remove the sign-in for one server only. Returns what was removed, if anything. */
export async function removeLogin(endpoint: string = mcpUrl()): Promise<BrowserLogin | null> {
	return withStoreLock(async () => {
		const { store, legacyToken } = await readStore();
		const key = normalizeResource(endpoint);
		const login = store.logins[key] ?? null;
		if (login) delete store.logins[key];
		if (login || legacyToken) await writeStore(store);
		return login;
	});
}

type Refresh = typeof refreshTokens;

/**
 * The current server's access token, renewed first if it is close to expiry.
 * Returns null when there is no usable login. A renewal that fails for a
 * transient reason hands back the token it has: the next call either works or
 * reports the real problem (offline, or a plain sign-in-again message).
 */
async function activeLoginToken(endpoint: string, refresh: Refresh): Promise<{ token: string; login: BrowserLogin } | null> {
	const key = normalizeResource(endpoint);
	const { store } = await readStore();
	const current = store.logins[key];
	if (!current || current.endedAt) return null;
	if (!needsRenewal(current)) return { token: current.accessToken, login: current };
	return withStoreLock(async () => {
		// Another Pi may have renewed while we waited for the lock.
		const { store: latest } = await readStore();
		const login = latest.logins[key];
		if (!login || login.endedAt) return null;
		if (!needsRenewal(login)) return { token: login.accessToken, login };
		try {
			const tokens = await refresh({
				tokenEndpoint: login.tokenEndpoint,
				clientId: login.clientId,
				refreshToken: login.refreshToken,
				resource: login.resource,
			});
			login.accessToken = tokens.accessToken;
			login.refreshToken = tokens.refreshToken;
			login.issuedAt = new Date(tokens.issuedAt).toISOString();
			login.expiresAt = new Date(tokens.expiresAt).toISOString();
			await writeStore(latest);
			return { token: login.accessToken, login };
		} catch (err) {
			if (err instanceof SignInEndedError) {
				login.endedAt = new Date().toISOString();
				await writeStore(latest);
				return null;
			}
			return { token: login.accessToken, login };
		}
	});
}

/**
 * Resolve the effective credential. The environment token always wins, so
 * headless runs never depend on interactive login state.
 */
export async function resolveToken(deps: { refresh?: Refresh } = {}): Promise<ResolvedToken | null> {
	const env = process.env[TOKEN_ENV_VAR];
	if (env && env.trim()) return { token: env.trim(), source: "env" };
	const active = await activeLoginToken(mcpUrl(), deps.refresh ?? refreshTokens);
	if (!active) return null;
	return { token: active.token, source: "login", principal: loginPrincipal(active.login) };
}

/**
 * The DevSpec tool endpoint in use: DEVSPEC_MCP_URL, then DEVSPEC_ENV=staging,
 * then production. Async for its callers; it never reads the store.
 */
export async function resolveEndpoint(): Promise<string> {
	return mcpUrl();
}
