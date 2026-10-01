/**
 * DevSpec Pi — detect and persist-disable an adapter-mounted DevSpec MCP
 * server (item d2f4f25c).
 *
 * Native tools already speak /api/mcp. If pi-mcp-adapter also loads a
 * `devspec` entry from project `.mcp.json`, the model pays the catalog
 * twice and sees pump/delivery verbs we hid. Foreign servers (Supabase,
 * browsers) are left alone. The shared `.mcp.json` is never rewritten —
 * other hosts in the same checkout still need it.
 *
 * Pure helpers, unit-tested. Persistence writes only `{ disabled: true }`
 * into the Pi-local adapter overlay (`.pi/mcp-adapter.json`).
 */

import {
	DEFAULT_MCP_URL,
	STAGING_MCP_URL,
	mcpUrl,
} from "./config.ts";
import {
	MODEL_VERB_NAMES,
	NEVER_MODEL_VERBS,
	PUMP_VERBS,
} from "../generated/mcp-catalog.ts";

export const ALL_DEVSPEC_VERBS: readonly string[] = [
	...MODEL_VERB_NAMES,
	...PUMP_VERBS,
	...NEVER_MODEL_VERBS,
];

const VERB_SET = new Set<string>(ALL_DEVSPEC_VERBS);

/** Prefix modes pi-mcp-adapter uses when registering direct tools. */
export const ADAPTER_PREFIX_MODES = ["server", "none", "short", "mcp"] as const;
export type AdapterPrefixMode = (typeof ADAPTER_PREFIX_MODES)[number];

export interface McpServerEntry {
	url?: unknown;
	disabled?: unknown;
	[key: string]: unknown;
}

export interface McpConfigFile {
	mcpServers?: Record<string, McpServerEntry>;
	"mcp-servers"?: Record<string, McpServerEntry>;
}

export interface DevspecServerHit {
	name: string;
	/** Absolute path of the config file that declared it (not the overlay). */
	source: string;
	url: string;
	alreadyDisabled: boolean;
}

export interface AdapterGuardState {
	/** Servers we decided to hide this process. */
	suppressed: DevspecServerHit[];
	/** Whether the Pi-owned duplicate settings were prepared successfully. */
	persisted: boolean;
	/** Overlay path we wrote / would write. */
	overlayPath: string | null;
}

const GUARD_KEY = "__devspecPiAdapterGuard";

function guardStore(): AdapterGuardState {
	const g = globalThis as unknown as Record<string, AdapterGuardState | undefined>;
	if (!g[GUARD_KEY]) {
		g[GUARD_KEY] = { suppressed: [], persisted: false, overlayPath: null };
	}
	return g[GUARD_KEY] as AdapterGuardState;
}

export function getAdapterGuardState(): AdapterGuardState {
	return guardStore();
}

/** Test hook — do not call from production code. */
export function resetAdapterGuardState(): void {
	const g = globalThis as unknown as Record<string, AdapterGuardState | undefined>;
	g[GUARD_KEY] = { suppressed: [], persisted: false, overlayPath: null };
}

export function recordAdapterGuard(next: Partial<AdapterGuardState>): AdapterGuardState {
	const cur = guardStore();
	if (next.suppressed) cur.suppressed = next.suppressed;
	if (next.persisted !== undefined) cur.persisted = next.persisted;
	if (next.overlayPath !== undefined) cur.overlayPath = next.overlayPath;
	return cur;
}

/**
 * Apex domains DevSpec deploys under: production (`api.devspec.ai`) and
 * staging (`api.devspecstaging.com`). Matching the apex and any subdomain also
 * keeps recognising the retiring `staging.devspec.ai`, which a checkout's
 * `.mcp.json` may still name — that entry is exactly what this guard disables.
 */
const DEVSPEC_APEX_DOMAINS: readonly string[] = ["devspec.ai", "devspecstaging.com"];

/** Hostname is DevSpec's own MCP (prod, staging, or any deploy under either apex). */
export function isDevspecMcpHost(hostname: string): boolean {
	const host = hostname.trim().toLowerCase();
	return DEVSPEC_APEX_DOMAINS.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

/**
 * A configured MCP url is DevSpec's own verb surface — not a foreign server.
 * Matches prod/staging hostnames, or whatever endpoint THIS package is
 * currently speaking (DEVSPEC_MCP_URL / DEVSPEC_ENV).
 */
export function isDevspecMcpUrl(url: unknown, effectiveEndpoint: string = mcpUrl()): boolean {
	if (typeof url !== "string" || !url.trim()) return false;
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return false;
	}
	if (isDevspecMcpHost(parsed.hostname)) return true;
	return normalizeEndpoint(url) === normalizeEndpoint(effectiveEndpoint);
}

export function normalizeEndpoint(url: string): string {
	try {
		const u = new URL(url.trim());
		u.hash = "";
		u.search = "";
		let path = u.pathname.replace(/\/+$/, "");
		if (!path) path = "";
		return `${u.protocol}//${u.host.toLowerCase()}${path}`;
	} catch {
		return url.trim().replace(/\/+$/, "").toLowerCase();
	}
}

export function serversFromConfig(raw: unknown): Record<string, McpServerEntry> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const obj = raw as McpConfigFile;
	const block = obj.mcpServers ?? obj["mcp-servers"];
	if (!block || typeof block !== "object" || Array.isArray(block)) return {};
	return block;
}

export function parseConfigJson(text: string): unknown {
	return JSON.parse(text) as unknown;
}

/** Known DevSpec endpoints this package might be talking to. */
export function knownDevspecEndpoints(): string[] {
	return [mcpUrl(), DEFAULT_MCP_URL, STAGING_MCP_URL];
}

export function findDevspecServers(
	servers: Record<string, McpServerEntry>,
	source: string,
	effectiveEndpoint: string = mcpUrl(),
): DevspecServerHit[] {
	const hits: DevspecServerHit[] = [];
	for (const [name, entry] of Object.entries(servers)) {
		if (!entry || typeof entry !== "object") continue;
		if (typeof entry.url !== "string") continue;
		if (!isDevspecMcpUrl(entry.url, effectiveEndpoint)) continue;
		hits.push({
			name,
			source,
			url: entry.url,
			alreadyDisabled: entry.disabled === true,
		});
	}
	return hits;
}

export function adapterPrefix(serverName: string, mode: AdapterPrefixMode): string {
	if (mode === "none") return "";
	if (mode === "short") {
		const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		return short || "mcp";
	}
	if (mode === "mcp") return `mcp__${serverName.replace(/-/g, "_")}`;
	return serverName.replace(/-/g, "_");
}

export function adapterToolName(verb: string, serverName: string, mode: AdapterPrefixMode): string {
	const p = adapterPrefix(serverName, mode);
	const sanitized = verb.replace(/\./g, "_");
	return p ? `${p}_${sanitized}` : sanitized;
}

/** Every name the adapter might have registered for this server. */
export function adapterToolNamesFor(serverName: string): string[] {
	const names = new Set<string>();
	for (const mode of ADAPTER_PREFIX_MODES) {
		for (const verb of ALL_DEVSPEC_VERBS) {
			names.add(adapterToolName(verb, serverName, mode));
		}
	}
	return [...names];
}

export function isDevspecVerb(name: string): boolean {
	return VERB_SET.has(name);
}

/**
 * Tools we may deactivate THIS session. Prefixed adapter names are always
 * safe. Bare catalog names are only safe when `sourceInfo` says they came
 * from the adapter — otherwise they are our native registrations.
 */
export function toolsToDeactivate(
	registered: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }>,
	serverNames: string[],
): string[] {
	const prefixed = new Set<string>();
	for (const server of serverNames) {
		for (const n of adapterToolNamesFor(server)) prefixed.add(n);
	}
	const out: string[] = [];
	for (const tool of registered) {
		const namespaceMatch = serverNames.some((server) => {
			const namespace = `mcp__${server.replace(/[^a-zA-Z0-9_]/g, "_")}`;
			return tool.name === namespace || tool.name.startsWith(`${namespace}__`);
		});
		if ((namespaceMatch || prefixed.has(tool.name)) && !isDevspecVerb(tool.name)) {
			out.push(tool.name);
			continue;
		}
		if (isDevspecVerb(tool.name) && isAdapterSource(tool.sourceInfo)) {
			out.push(tool.name);
		}
	}
	return out;
}

export function isAdapterSource(sourceInfo: { source?: string; path?: string } | undefined): boolean {
	if (!sourceInfo) return false;
	const blob = `${sourceInfo.source ?? ""} ${sourceInfo.path ?? ""}`.toLowerCase();
	return blob.includes("pi-mcp-adapter") || blob.includes("mcp-adapter");
}

export const SUPPRESSION_NOTICE =
	"DevSpec MCP is disabled in Pi to avoid duplicate tools. This plugin provides DevSpec instead. Other agents’ settings and your other MCP servers are unchanged.";

/** Authored guidance, never interpolated config names, paths or credentials. */
export const SUPPRESSION_AGENT_GUIDANCE =
	"The DevSpec Pi plugin replaces a separately configured DevSpec MCP server. Its duplicate protection can mark that server disabled in Pi; this is expected, not a sign-in or connection failure. Explain this only if asked, and do not re-enable the duplicate or delete shared MCP configuration to fix it. Do not announce this proactively. The plugin's override is Pi-only: it does not change shared configuration, Claude Code settings or foreign MCP servers. Use the native DevSpec tools. Suppression does not prove that those tools are signed in or healthy: if they fail, diagnose the plugin connection with /devspec.status and /devspec.login separately.";
