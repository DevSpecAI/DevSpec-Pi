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
import { mcpUrl } from "./config.ts";

const CLIENT_NAME = "devspec-pi";
const CLIENT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Token rejected by the server (401). The user needs to re-login. */
export class DevspecAuthError extends Error {}

/** Anything else: network, server 5xx, MCP protocol errors. */
export class DevspecApiError extends Error {}

interface CacheEntry {
	token: string;
	url: string;
	client: Client;
}

let cached: CacheEntry | null = null;

/** Drop the cached connection (logout, token change, after a transport error). */
export function resetClientCache(): void {
	const old = cached;
	cached = null;
	if (old) void old.client.close().catch(() => {});
}

async function connect(token: string): Promise<Client> {
	const url = mcpUrl();
	if (cached && cached.token === token && cached.url === url) return cached.client;

	resetClientCache();
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
	await client.connect(transport);
	cached = { token, url, client };
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

/**
 * Call a DevSpec MCP tool. Throws DevspecAuthError / DevspecApiError.
 * One transparent reconnect-retry on transport failure (the cached client may
 * hold a dead socket after sleep/network change).
 */
export async function callDevspec(
	token: string,
	name: string,
	args: Record<string, unknown>,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const client = await connect(token);
			return await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
		} catch (err) {
			lastError = err;
			resetClientCache();
			// Auth errors are terminal — retrying cannot help.
			if (mapClientError(err) instanceof DevspecAuthError) break;
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
