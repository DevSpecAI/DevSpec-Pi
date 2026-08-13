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
 * into the Pi-local overlay (`.pi/mcp.json`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	/** Whether `.pi/mcp.json` was written (or already had disabled: true). */
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

/** Hostname is DevSpec's own MCP (prod, staging, or a *.devspec.ai deploy). */
export function isDevspecMcpHost(hostname: string): boolean {
	const host = hostname.trim().toLowerCase();
	return host === "devspec.ai" || host.endsWith(".devspec.ai");
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

export function projectOverlayPath(cwd: string): string {
	return join(cwd, ".pi", "mcp.json");
}

/**
 * Merge `{ [name]: { disabled: true } }` into an existing overlay object
 * without copying credentials or other fields from the shared file.
 * Returns the next object and whether it changed.
 */
export function mergeDisabledOverlay(
	existing: unknown,
	names: string[],
): { next: Record<string, unknown>; changed: boolean } {
	const raw: Record<string, unknown> =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? { ...(existing as Record<string, unknown>) }
			: {};
	const key = raw.mcpServers !== undefined ? "mcpServers" : raw["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
	const prevBlock = raw[key];
	const servers: Record<string, unknown> =
		prevBlock && typeof prevBlock === "object" && !Array.isArray(prevBlock)
			? { ...(prevBlock as Record<string, unknown>) }
			: {};

	let changed = false;
	for (const name of names) {
		const prev = servers[name];
		if (prev !== undefined && (typeof prev !== "object" || prev === null || Array.isArray(prev))) {
			continue;
		}
		const entry = { ...((prev as Record<string, unknown> | undefined) ?? {}) };
		if (entry.disabled === true) continue;
		entry.disabled = true;
		servers[name] = entry;
		changed = true;
	}

	raw[key] = servers;
	return { next: raw, changed };
}

/**
 * Persist disabled:true for the named servers in `<cwd>/.pi/mcp.json`.
 * Never writes the shared `.mcp.json`. Creates the overlay if missing.
 */
export function persistDisabledOverlay(cwd: string, names: string[]): { path: string; changed: boolean } {
	const path = projectOverlayPath(cwd);
	let existing: unknown = {};
	try {
		existing = parseConfigJson(readFileSync(path, "utf8"));
	} catch {
		existing = {};
	}
	const { next, changed } = mergeDisabledOverlay(existing, names);
	if (changed) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	}
	return { path, changed };
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
		if (prefixed.has(tool.name) && !isDevspecVerb(tool.name)) {
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
	"DevSpec is already connected through this package. We turned off the extra DevSpec MCP server in this project so it isn't loaded twice. Your other MCP servers are unchanged.";
