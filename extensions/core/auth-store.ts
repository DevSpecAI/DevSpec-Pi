/**
 * DevSpec Pi — token store.
 *
 * Tokens live at `<pi-agent-dir>/devspec/auth.json` with 0600 perms.
 * Resolution order (headless-friendly):
 *   1. DEVSPEC_MCP_TOKEN env var (CI, cloud workers, RPC hosts)
 *   2. the on-disk store written by /devspec.login
 *
 * Pure node, no pi imports — unit-testable under `node --test`.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devspecDir, DEFAULT_MCP_URL, ENV_ENV_VAR, STAGING_MCP_URL, TOKEN_ENV_VAR, URL_ENV_VAR } from "./config.ts";

export interface StoredAuth {
	token: string;
	/** Endpoint this token was verified against (staging vs prod) — tokens are per-environment. */
	url?: string;
	/** Token scope as reported by DevSpec ("read_only" | "read_write"), if known. */
	scope?: string;
	/** Display name of the principal the token acts as, from verify_agent_connection. */
	principal?: string;
	/** ISO timestamp of the last successful verification. */
	verifiedAt?: string;
}

export interface ResolvedToken {
	token: string;
	source: "env" | "store";
}

export function authFilePath(): string {
	return join(devspecDir(), "auth.json");
}

export async function loadStoredAuth(): Promise<StoredAuth | null> {
	try {
		const raw = await readFile(authFilePath(), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as { token?: unknown }).token === "string" &&
			(parsed as { token: string }).token.length > 0
		) {
			return parsed as StoredAuth;
		}
		return null;
	} catch {
		return null;
	}
}

export async function saveAuth(auth: StoredAuth): Promise<void> {
	await mkdir(devspecDir(), { recursive: true, mode: 0o700 });
	await writeFile(authFilePath(), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
	// Belt and braces: umask may widen perms on some platforms.
	await chmod(authFilePath(), 0o600).catch(() => {});
}

export async function clearAuth(): Promise<void> {
	await rm(authFilePath(), { force: true });
}

/**
 * Resolve the effective token. Env always wins so unattended/headless runs
 * never depend on interactive login state.
 */
export async function resolveToken(): Promise<ResolvedToken | null> {
	const env = process.env[TOKEN_ENV_VAR];
	if (env && env.trim()) return { token: env.trim(), source: "env" };
	const stored = await loadStoredAuth();
	if (stored) return { token: stored.token, source: "store" };
	return null;
}

/**
 * Resolve the effective endpoint: URL override → staging shorthand → the
 * endpoint captured at login (tokens are per-environment, so the store's URL
 * keeps a staging login working without env vars) → production default.
 */
export async function resolveEndpoint(): Promise<string> {
	const override = process.env[URL_ENV_VAR];
	if (override && override.trim()) return override.trim();
	const env = process.env[ENV_ENV_VAR];
	if (env && env.trim().toLowerCase() === "staging") return STAGING_MCP_URL;
	const stored = await loadStoredAuth();
	if (stored?.url) return stored.url;
	return DEFAULT_MCP_URL;
}
