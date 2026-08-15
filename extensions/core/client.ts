/**
 * DevSpec Pi — embedded MCP client.
 *
 * Speaks to the DevSpec MCP endpoint (stateless Streamable HTTP, POST-only,
 * bearer auth — see devspecv2 apps/web/app/api/mcp/route.ts) using the
 * official SDK. The MCP tool surface is the interop contract across all
 * DevSpec plugins; this client lets us honor that contract while presenting
 * every verb as a NATIVE pi tool (VISION.md, "Transport").
 *
 * Two isolated clients per process (item 781886cf):
 *   - "pump"  — poll / heartbeat / trail / bond. Must not wait on a model verb.
 *   - "work"  — native tools and recall. A hang or parse error dies here.
 *
 * The server is stateless, so there is no session to manage; on failure we
 * drop that lane and reconnect lazily on the next call.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveEndpoint } from "./auth-store.ts";
import { needsProjectScope, resolveGitRemote, resolveProjectPin } from "./project-scope.ts";

const CLIENT_NAME = "devspec-pi";
const CLIENT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 60_000;
/** Hard cap for model-facing verbs. The SDK timeout alone did not fire on the
 *  live Streamable-HTTP parse hang (~90s, session d8883a49). */
export const MODEL_TIMEOUT_MS = 25_000;

export type ClientLane = "pump" | "work";

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

interface LaneCache {
	pump: CacheEntry | null;
	work: CacheEntry | null;
}

// Cross-extension-file singleton: pi isolates each extension file's module
// graph, so the cache lives on globalThis (one MCP client per lane).
const GLOBAL_KEY = "__devspecPiClientCacheByLane";

function cacheStore(): LaneCache {
	const g = globalThis as unknown as Record<string, LaneCache | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { pump: null, work: null };
	return g[GLOBAL_KEY] as LaneCache;
}

function closeEntry(entry: CacheEntry | null): void {
	if (entry) void entry.client.close().catch(() => {});
}

/** Drop a lane (or both). Logout / token change clears both. */
export function resetClientCache(lane?: ClientLane): void {
	const store = cacheStore();
	if (!lane) {
		closeEntry(store.pump);
		closeEntry(store.work);
		store.pump = null;
		store.work = null;
		return;
	}
	closeEntry(store[lane]);
	store[lane] = null;
}

async function connect(token: string, lane: ClientLane): Promise<Client> {
	const url = await resolveEndpoint();
	const store = cacheStore();
	const cached = store[lane];
	if (cached && cached.token === token && cached.url === url) return cached.client;

	resetClientCache(lane);
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
	await client.connect(transport);
	store[lane] = { token, url, client };
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

/** Transport / parse / timeout — recoverable. Never a human End. */
export function isRecoverableTransportError(err: unknown): boolean {
	if (err instanceof DevspecAuthError) return false;
	const message = err instanceof Error ? err.message : String(err);
	return /parse|streamable|timed? ?out|ETIMEDOUT|fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket|certificate|network|abort|Cannot reach DevSpec/i.test(
		message,
	);
}

/**
 * Only a rejected token ends the bond from the client. A poll that reports
 * `ended`/`not_found` is a *server* verdict — classified separately.
 */
export function shouldEndBondOnPollFailure(err: unknown): boolean {
	return err instanceof DevspecAuthError || mapClientError(err) instanceof DevspecAuthError;
}

/** Human End / local stop are sticky. Redeploy, parse, not_found are not. */
export function isPermanentServerEnd(status?: string | null, endReason?: string | null): boolean {
	if (status !== "ended" && status !== "not_found") return false;
	return endReason === "ui" || endReason === "local_stop";
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
	/**
	 * Isolated transport. Default "work" so a forgotten lane cannot stall
	 * the pump. Poll / heartbeat / trail / bond must pass "pump".
	 */
	lane?: ClientLane;
}

/** Race a promise against a wall-clock deadline. Exported for tests. */
export async function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new DevspecApiError(`DevSpec ${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Call a DevSpec MCP tool. Throws DevspecAuthError / DevspecApiError.
 * One transparent reconnect-retry on transport failure (the cached client may
 * hold a dead socket after sleep/network change). A work-lane failure never
 * drops the pump client.
 */
export async function callDevspec(
	token: string,
	name: string,
	args: Record<string, unknown>,
	options: CallOptions = {},
): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const lane: ClientLane = options.lane ?? "work";
	let callArgs = args;
	let scopedRetryDone = false;
	let rateLimitRetries = 0;
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await waitOutCooldown();
			const client = await connect(token, lane);
			const raw = await withHardTimeout(
				client.callTool({ name, arguments: callArgs }, undefined, { timeout: timeoutMs }),
				timeoutMs,
				name,
			);
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
			// Reactive project scoping: one retry with whatever anchors this folder has —
			// its git remote, its `.devspec/project.json` pin, or both. A folder with no
			// repo has no remote, so the pin is the only anchor it can offer; sending both
			// when both exist is deliberate, because the SERVER ranks them (a verified
			// remote wins) and precedence must never be decided here.
			if (
				!scopedRetryDone &&
				!(mapped instanceof DevspecAuthError) &&
				!callArgs.git_remote &&
				!callArgs.pinned_project_id &&
				!callArgs.project_id &&
				needsProjectScope(mapped.message)
			) {
				const cwd = options.cwd ?? process.cwd();
				const [remote, pin] = await Promise.all([
					resolveGitRemote(cwd),
					resolveProjectPin(cwd),
				]);
				if (remote || pin) {
					scopedRetryDone = true;
					callArgs = {
						...callArgs,
						...(remote ? { git_remote: remote } : {}),
						// NEVER `project_id` — that would outrank the remote and reverse the
						// decided precedence. See project-scope.ts.
						...(pin ? { pinned_project_id: pin } : {}),
					};
					attempt--; // the scoping retry doesn't consume a transport attempt
					continue;
				}
			}
			lastError = err;
			resetClientCache(lane);
			// Auth errors are terminal — retrying cannot help.
			if (mapped instanceof DevspecAuthError) break;
		}
	}
	throw mapClientError(lastError);
}

/**
 * Read one server-owned MCP resource without exposing a resource browser to
 * the model. Product contracts use this mechanical path at work entry.
 */
export async function readDevspecResource(
	token: string,
	uri: string,
	options: Pick<CallOptions, "timeoutMs" | "lane"> = {},
): Promise<unknown> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const lane = options.lane ?? "work";
	let lastError: unknown = null;
	let rateLimitRetries = 0;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await waitOutCooldown();
			const client = await connect(token, lane);
			return await withHardTimeout(
				client.readResource({ uri }, { timeout: timeoutMs }),
				timeoutMs,
				`resource ${uri}`,
			);
		} catch (error) {
			const mapped = mapClientError(error);
			const retryMs = parseRateLimitRetryMs(mapped.message);
			if (retryMs !== null) {
				rateLimitStore().until = Date.now() + retryMs;
				rateLimitRetries += 1;
				if (rateLimitRetries > 1) throw new DevspecRateLimitError(mapped.message, retryMs);
				await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, MAX_COOLDOWN_WAIT_MS)));
				attempt--;
				continue;
			}
			lastError = error;
			resetClientCache(lane);
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
	return callDevspec(token, "verify_agent_connection", {}, { lane: "work", timeoutMs: 15_000 });
}
