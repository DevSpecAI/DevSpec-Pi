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
 * The server is stateless, so there is no session to manage. Transport
 * failure retires that lane's client and reconnects lazily; MCP `isError`
 * application results do not, because close() aborts every in-flight sibling
 * (item 8e1b3c05). In-flight waiters keep a retired client alive until drain.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveEndpoint } from "./auth-store.ts";
import { needsProjectScope, resolveGitRemote, resolveProjectPin } from "./project-scope.ts";

const CLIENT_NAME = "devspec-pi";
const CLIENT_VERSION = "0.2.0";
const DEFAULT_TIMEOUT_MS = 60_000;
/** Hard cap for model-facing verbs. The SDK timeout alone did not fire on the
 *  live Streamable-HTTP parse hang (~90s, session d8883a49). */
export const MODEL_TIMEOUT_MS = 25_000;

export type ClientLane = "pump" | "work";

/** Token rejected by the server (401). The user needs to re-login. */
export class DevspecAuthError extends Error {}

/** Anything else: network, server 5xx, MCP protocol errors. */
export class DevspecApiError extends Error {}

/** MCP tool result with `isError: true` — a verb refusal, not a dead socket. */
export class DevspecToolError extends DevspecApiError {}

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

/** Minimal MCP client surface the lane cache holds. Real SDK Client satisfies this. */
export type LaneClient = {
	callTool: (
		request: { name: string; arguments?: Record<string, unknown> },
		schema?: unknown,
		options?: { timeout?: number },
	) => Promise<unknown>;
	readResource: (request: { uri: string }, options?: { timeout?: number }) => Promise<unknown>;
	close: () => Promise<void>;
};

export type LaneClientFactory = (args: {
	token: string;
	lane: ClientLane;
	url: string;
	connectionCapability?: string;
}) => Promise<LaneClient>;

interface CacheEntry {
	token: string;
	url: string;
	/** Hidden connection capability bound into this transport's request headers. */
	connectionCapability?: string;
	client: LaneClient;
	inFlight: number;
	retired: boolean;
}

interface LaneSlot {
	entry: CacheEntry | null;
	connecting: Promise<CacheEntry> | null;
}

interface LaneCache {
	pump: LaneSlot;
	work: LaneSlot;
}

// Cross-extension-file singleton: pi isolates each extension file's module
// graph, so the cache lives on globalThis (one MCP client per lane).
// V2: inFlight/retired slots. Do not reuse the V1 `{ pump: CacheEntry | null }` shape.
const GLOBAL_KEY = "__devspecPiClientCacheByLaneV2";
const FACTORY_KEY = "__devspecPiLaneClientFactory";

function emptySlot(): LaneSlot {
	return { entry: null, connecting: null };
}

function cacheStore(): LaneCache {
	const g = globalThis as unknown as Record<string, LaneCache | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { pump: emptySlot(), work: emptySlot() };
	return g[GLOBAL_KEY] as LaneCache;
}

function laneClientFactory(): LaneClientFactory | null {
	const g = globalThis as unknown as Record<string, LaneClientFactory | null | undefined>;
	return g[FACTORY_KEY] ?? null;
}

/** Test-only: replace Streamable HTTP connect. `null` restores the real transport. */
export function setLaneClientFactoryForTests(factory: LaneClientFactory | null): void {
	const g = globalThis as unknown as Record<string, LaneClientFactory | null | undefined>;
	g[FACTORY_KEY] = factory;
}

function closeEntry(entry: CacheEntry | null): void {
	if (entry) void entry.client.close().catch(() => {});
}

function reusable(
	entry: CacheEntry | null,
	token: string,
	url: string,
	connectionCapability?: string,
): entry is CacheEntry {
	return !!entry && !entry.retired && entry.token === token && entry.url === url &&
		entry.connectionCapability === connectionCapability;
}

function retireEntry(lane: ClientLane, entry: CacheEntry): void {
	entry.retired = true;
	const slot = cacheStore()[lane];
	if (slot.entry === entry) slot.entry = null;
	if (entry.inFlight <= 0) closeEntry(entry);
}

function releaseClient(entry: CacheEntry): void {
	entry.inFlight = Math.max(0, entry.inFlight - 1);
	if (entry.retired && entry.inFlight === 0) closeEntry(entry);
}

function forceCloseSlot(slot: LaneSlot): void {
	if (slot.entry) {
		closeEntry(slot.entry);
		slot.entry = null;
	}
	slot.connecting = null;
}

/** Drop a lane (or both). Logout / token change force-closes; in-flight RPCs abort. */
export function resetClientCache(lane?: ClientLane): void {
	const store = cacheStore();
	if (!lane) {
		forceCloseSlot(store.pump);
		forceCloseSlot(store.work);
		return;
	}
	forceCloseSlot(store[lane]);
}

async function openClient(
	token: string,
	lane: ClientLane,
	url: string,
	connectionCapability?: string,
): Promise<LaneClient> {
	const factory = laneClientFactory();
	if (factory) return factory({ token, lane, url, connectionCapability });
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: {
			headers: {
				authorization: `Bearer ${token}`,
				...(connectionCapability ? { "x-devspec-connection-capability": connectionCapability } : {}),
			},
		},
	});
	const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
	await client.connect(transport);
	return client as unknown as LaneClient;
}

async function acquireClient(token: string, lane: ClientLane, connectionCapability?: string): Promise<CacheEntry> {
	const url = laneClientFactory() ? "https://devspec.test/api/mcp" : await resolveEndpoint();
	const slot = cacheStore()[lane];
	for (;;) {
		if (reusable(slot.entry, token, url, connectionCapability)) {
			slot.entry.inFlight += 1;
			return slot.entry;
		}
		if (slot.connecting) {
			try {
				await slot.connecting;
			} catch {
				/* connect failed; loop and try again */
			}
			continue;
		}
		const previous = slot.entry;
		const connecting = (async () => {
			if (previous) retireEntry(lane, previous);
			const client = await openClient(token, lane, url, connectionCapability);
			const entry: CacheEntry = {
				token,
				url,
				...(connectionCapability ? { connectionCapability } : {}),
				client,
				inFlight: 0,
				retired: false,
			};
			slot.entry = entry;
			return entry;
		})();
		slot.connecting = connecting;
		try {
			const entry = await connecting;
			entry.inFlight += 1;
			return entry;
		} finally {
			if (slot.connecting === connecting) slot.connecting = null;
		}
	}
}

/**
 * Map SDK/transport errors to typed client errors. Exported for tests.
 * The server returns {"error":"Invalid or revoked API token"} with a 401;
 * the SDK surfaces that body text without the status code.
 */
export function mapClientError(err: unknown): Error {
	if (err instanceof DevspecAuthError || err instanceof DevspecToolError || err instanceof DevspecRateLimitError) {
		return err;
	}
	if (err instanceof DevspecApiError) return err;
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
	if (err instanceof DevspecAuthError || err instanceof DevspecToolError) return false;
	const message = err instanceof Error ? err.message : String(err);
	return /parse|streamable|timed? ?out|ETIMEDOUT|fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket|certificate|network|abort|Cannot reach DevSpec|Connection closed|-32000/i.test(
		message,
	);
}

function mcpToolErrorText(raw: unknown, name: string): string | null {
	const r = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | null;
	if (!r?.isError) return null;
	const text = (r.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join(" ");
	return text || `DevSpec tool ${name} failed.`;
}

/**
 * Only a rejected token ends the bond from the client. A poll that reports
 * `ended`/`not_found` is a *server* verdict — classified separately.
 */
export function shouldEndBondOnPollFailure(err: unknown): boolean {
	return err instanceof DevspecAuthError || mapClientError(err) instanceof DevspecAuthError;
}

/** Explicit human/host/auth teardown is sticky. Inferred idle/not_found is recoverable. */
export function isPermanentServerEnd(status?: string | null, endReason?: string | null): boolean {
	if (status !== "ended" && status !== "not_found") return false;
	return endReason === "ui" || endReason === "local_stop" || endReason === "owner_gone" || endReason === "auth";
}

export interface CallOptions {
	/** Request timeout (default 60s). Long-poll callers pass hold + margin. */
	timeoutMs?: number;
	/** Hidden host-held capability. It is stamped as a transport header, never an argument. */
	connectionCapability?: string;
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

async function invokeOnLane<T>(
	token: string,
	lane: ClientLane,
	connectionCapability: string | undefined,
	timeoutMs: number,
	label: string,
	run: (client: LaneClient) => Promise<T>,
): Promise<T> {
	await waitOutCooldown();
	const entry = await acquireClient(token, lane, connectionCapability);
	try {
		return await withHardTimeout(run(entry.client), timeoutMs, label);
	} catch (err) {
		const mapped = mapClientError(err);
		if (isRecoverableTransportError(mapped)) retireEntry(lane, entry);
		throw mapped;
	} finally {
		releaseClient(entry);
	}
}

/**
 * Call a DevSpec MCP tool. Throws DevspecAuthError / DevspecApiError / DevspecToolError.
 * One transparent reconnect-retry on transport failure (the cached client may
 * hold a dead socket after sleep/network change). MCP `isError` is a verb
 * refusal: one request, no close, no retry. A work-lane failure never drops
 * the pump client; retiring a lane never close()s while siblings are in flight.
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
			const raw = await invokeOnLane(
				token,
				lane,
				options.connectionCapability,
				timeoutMs,
				name,
				(client) => client.callTool({ name, arguments: callArgs }, undefined, { timeout: timeoutMs }),
			);
			const toolError = mcpToolErrorText(raw, name);
			if (toolError) throw new DevspecToolError(toolError);
			return raw;
		} catch (err) {
			const mapped = mapClientError(err);
			if (mapped instanceof DevspecToolError) throw mapped;
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
			lastError = mapped;
			if (mapped instanceof DevspecAuthError) {
				resetClientCache(lane);
				break;
			}
			if (!isRecoverableTransportError(mapped)) throw mapped;
		}
	}
	throw mapClientError(lastError);
}

/**
 * One isolated advisory call. It never touches the pump/work client caches,
 * never waits through a known cooldown, never retries, and closes its own client
 * at the end-to-end deadline. Used by edit-time nudges so discovery cannot delay
 * or abort foreground DevSpec tools.
 */
export async function callDevspecAdvisoryOnce(
	token: string,
	name: string,
	args: Record<string, unknown>,
	timeoutMs = 1500,
): Promise<unknown> {
	const cooldown = rateLimitStore().until - Date.now();
	if (cooldown > 0) throw new DevspecRateLimitError("DevSpec advisory skipped during rate-limit cooldown.", cooldown);
	const url = await resolveEndpoint();
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name: `${CLIENT_NAME}-advisory`, version: CLIENT_VERSION }, { capabilities: {} });
	try {
		const raw = await withHardTimeout((async () => {
			await client.connect(transport);
			return client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
		})(), timeoutMs, `${name} advisory`);
		const result = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
		if (result?.isError) {
			const text = (result.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join(" ");
			throw new DevspecApiError(text || `DevSpec tool ${name} failed.`);
		}
		return raw;
	} catch (error) {
		const mapped = mapClientError(error);
		const retryMs = parseRateLimitRetryMs(mapped.message);
		if (retryMs !== null) {
			rateLimitStore().until = Date.now() + retryMs;
			throw new DevspecRateLimitError(mapped.message, retryMs);
		}
		throw mapped;
	} finally {
		// Cleanup must never extend the advisory deadline; this client is isolated
		// from foreground lanes and close failure has no caller-visible consequence.
		void client.close().catch(() => {});
	}
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
			return await invokeOnLane(
				token,
				lane,
				undefined,
				timeoutMs,
				`resource ${uri}`,
				(client) => client.readResource({ uri }, { timeout: timeoutMs }),
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
			lastError = mapped;
			if (mapped instanceof DevspecAuthError) {
				resetClientCache(lane);
				break;
			}
			if (!isRecoverableTransportError(mapped)) throw mapped;
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
