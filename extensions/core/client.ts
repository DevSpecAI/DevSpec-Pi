/**
 * DevSpec Pi — embedded MCP client.
 *
 * Speaks to the DevSpec MCP endpoint (stateless Streamable HTTP, POST-only,
 * bearer auth — see devspecv2 apps/web/app/api/mcp/route.ts) using the
 * official SDK. The MCP tool surface is the interop contract across all
 * DevSpec plugins; this client lets us honor that contract while presenting
 * every verb as a NATIVE pi tool (VISION.md, "Transport").
 *
 * One client per (token, url) per process. The server is stateless, so there
 * is no session to manage; on failure we drop the cache and reconnect lazily
 * on the next call.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveEndpoint } from "./auth-store.ts";
import { needsProjectScope, resolveGitRemote } from "./project-scope.ts";

const CLIENT_NAME = "devspec-pi";
const CLIENT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Token rejected by the server (401). The user needs to re-login. */
export class DevspecAuthError extends Error {}

/** Anything else: network, server 5xx, MCP protocol errors. */
export class DevspecApiError extends Error {}

/** The per-token request budget is exhausted; carries the server's retry hint. */
export class DevspecRateLimitError extends DevspecApiError {
	retryAfterMs: number;
	constructor(message: string, retryAfterMs: number) {
		super(message);
		this.retryAfterMs = retryAfterMs;
	}
}

/** Parse "Rate limit exceeded. Retry after N seconds." → ms, or null. */
export function parseRateLimitRetryMs(message: string): number | null {
	if (!/rate limit/i.test(message)) return null;
	const m = message.match(/retry after (\d+)\s*seconds?/i);
	return m ? Number.parseInt(m[1], 10) * 1000 : 5_000;
}

// Cross-extension-file rate-limit cooldown (globalThis — pi isolates module
// graphs per extension file). While cooling down, calls WAIT rather than
// hammering the limiter (failed attempts likely count against the budget).
const RL_KEY = "__devspecPiRateLimit";

function rateLimitStore(): { until: number } {
	const g = globalThis as unknown as Record<string, { until: number } | undefined>;
	if (!g[RL_KEY]) g[RL_KEY] = { until: 0 };
	return g[RL_KEY] as { until: number };
}

const MAX_COOLDOWN_WAIT_MS = 30_000;

async function waitOutCooldown(): Promise<void> {
	const wait = rateLimitStore().until - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, MAX_COOLDOWN_WAIT_MS)));
}

interface CacheEntry {
	token: string;
	url: string;
	client: Client;
}

// Cross-extension-file singleton: pi isolates each extension file's module
// graph, so the cache lives on globalThis (one MCP client per process).
const GLOBAL_KEY = "__devspecPiClientCache";

function cacheStore(): { current: CacheEntry | null } {
	const g = globalThis as unknown as Record<string, { current: CacheEntry | null } | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { current: null };
	return g[GLOBAL_KEY] as { current: CacheEntry | null };
}

/** Drop the cached connection (logout, token change, after a transport error). */
export function resetClientCache(): void {
	const old = cacheStore().current;
	cacheStore().current = null;
	if (old) void old.client.close().catch(() => {});
}

async function connect(token: string): Promise<Client> {
	const url = await resolveEndpoint();
	const cached = cacheStore().current;
	if (cached && cached.token === token && cached.url === url) return cached.client;

	resetClientCache();
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
	await client.connect(transport);
	cacheStore().current = { token, url, client };
	return client;
}

/**
 * Map SDK/transport errors to typed client errors. Exported for tests.
 * The server returns {"error":"Invalid or revoked API token"} with a 401;
 * the SDK surfaces that body text without the status code.
 */
export function mapClientError(err: unknown): Error {
	const message = err instanceof Error ? err.message : String(err);
	if (/401|unauthori[sz]ed|invalid_token|invalid (or revoked )?(api )?token|invalid authorization/i.test(message)) {
		return new DevspecAuthError("DevSpec rejected the token (invalid or revoked). Run /devspec.login.");
	}
	if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|certificate/i.test(message)) {
		return new DevspecApiError(`Cannot reach DevSpec (${message}). Check your connection.`);
	}
	return new DevspecApiError(message);
}

export interface CallOptions {
	/** Request timeout (default 60s). Long-poll callers pass hold + margin. */
	timeoutMs?: number;
	/**
	 * Working directory for reactive project scoping: when the server can't
	 * resolve the project (multi-project token) and no git_remote was passed,
	 * retry once with this checkout's origin remote attached.
	 */
	cwd?: string;
}

/**
 * Call a DevSpec MCP tool. Throws DevspecAuthError / DevspecApiError.
 * One transparent reconnect-retry on transport failure (the cached client may
 * hold a dead socket after sleep/network change).
 */
export async function callDevspec(
	token: string,
	name: string,
	args: Record<string, unknown>,
	options: CallOptions = {},
): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let callArgs = args;
	let scopedRetryDone = false;
	let rateLimitRetries = 0;
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await waitOutCooldown();
			const client = await connect(token);
			const raw = await client.callTool({ name, arguments: callArgs }, undefined, { timeout: timeoutMs });
			// MCP-level errors arrive as results, not throws — surface them the
			// same way so the scoping retry below can see them too.
			const r = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
			if (r?.isError) {
				const text = (r.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join(" ");
				throw new DevspecApiError(text || `DevSpec tool ${name} failed.`);
			}
			return raw;
		} catch (err) {
			const mapped = mapClientError(err);
			// Rate limit: honor the server's hint, cool the whole process down,
			// and retry ONCE after waiting — never hammer the window.
			const retryMs = parseRateLimitRetryMs(mapped.message);
			if (retryMs !== null) {
				rateLimitStore().until = Date.now() + retryMs;
				rateLimitRetries += 1;
				if (rateLimitRetries > 1) throw new DevspecRateLimitError(mapped.message, retryMs);
				await new Promise((r) => setTimeout(r, Math.min(retryMs, MAX_COOLDOWN_WAIT_MS)));
				attempt--; // the rate-limit wait-retry doesn't consume a transport attempt
				continue;
			}
			// Reactive project scoping: one retry with the checkout's remote.
			if (
				!scopedRetryDone &&
				!(mapped instanceof DevspecAuthError) &&
				!callArgs.git_remote &&
				!callArgs.project_id &&
				needsProjectScope(mapped.message)
			) {
				const remote = await resolveGitRemote(options.cwd ?? process.cwd());
				if (remote) {
					scopedRetryDone = true;
					callArgs = { ...callArgs, git_remote: remote };
					attempt--; // the scoping retry doesn't consume a transport attempt
					continue;
				}
			}
			lastError = err;
			resetClientCache();
			// Auth errors are terminal — retrying cannot help.
			if (mapped instanceof DevspecAuthError) break;
		}
	}
	throw mapClientError(lastError);
}

/**
 * Verify a token and return the server's identity payload (unwrapMcpResult
 * shape). Used by /devspec.login and the session-start status check.
 */
export async function verifyToken(token: string): Promise<unknown> {
	return callDevspec(token, "verify_agent_connection", {});
}
