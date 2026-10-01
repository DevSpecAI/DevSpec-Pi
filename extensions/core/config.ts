/**
 * DevSpec Pi — shared configuration.
 *
 * Endpoint, environment variables, and on-disk locations. Everything here is
 * pure and dependency-free so it loads in any mode (tui / rpc / json / print)
 * and under `node --test` (erasable TypeScript only).
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * DevSpec's hostnames are split by role: the machine API (MCP) lives on the
 * `api.` host, human-facing pages (settings, handoff) on the `app.` host, and
 * the marketing site stays on the bare `devspec.ai` apex. Staging mirrors the
 * same split on `devspecstaging.com`. Never derive one host from another.
 */

/** Prod MCP endpoint (stateless Streamable HTTP, POST-only, bearer auth). */
export const DEFAULT_MCP_URL = "https://api.devspec.ai/api/mcp";

/** Staging MCP endpoint — active development happens here (dev Clerk/Supabase). */
export const STAGING_MCP_URL = "https://api.devspecstaging.com/api/mcp";

/**
 * The Agents settings page (`/settings/agents`): where users create, reveal and
 * revoke their account-wide access token in the DevSpec web app (app host, not
 * the API). Customer copy links to it by URL rather than naming a menu path.
 */
export const AGENTS_SETTINGS_URL = "https://app.devspec.ai/settings/agents";
export const STAGING_AGENTS_SETTINGS_URL = "https://app.devspecstaging.com/settings/agents";

/** Env var that always wins over the on-disk token store (CI / cloud workers). */
export const TOKEN_ENV_VAR = "DEVSPEC_MCP_TOKEN";

/** Full endpoint override (any environment). Wins over DEVSPEC_ENV. */
export const URL_ENV_VAR = "DEVSPEC_MCP_URL";

/** Environment shorthand: "staging" selects the staging endpoint. */
export const ENV_ENV_VAR = "DEVSPEC_ENV";

/** Pi's config dir — honors PI_CODING_AGENT_DIR like pi itself does. */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Our private corner of the pi config dir. */
export function devspecDir(): string {
	return join(agentDir(), "devspec");
}

export function mcpUrl(): string {
	const override = process.env[URL_ENV_VAR];
	if (override && override.trim()) return override.trim();
	const env = process.env[ENV_ENV_VAR];
	if (env && env.trim().toLowerCase() === "staging") return STAGING_MCP_URL;
	return DEFAULT_MCP_URL;
}

/** The Agents settings page matching the effective endpoint (for login guidance). */
export function agentsSettingsUrl(): string {
	return mcpUrl() === STAGING_MCP_URL ? STAGING_AGENTS_SETTINGS_URL : AGENTS_SETTINGS_URL;
}
