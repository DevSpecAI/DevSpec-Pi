/**
 * DevSpec Pi — hide an adapter-mounted DevSpec MCP server (item d2f4f25c).
 *
 * Native tools already speak /api/mcp. If pi-mcp-adapter also loaded a
 * DevSpec server from project `.mcp.json`, we:
 *   1. persist `{ disabled: true }` in the Pi-local overlay (`.pi/mcp.json`)
 *      so the next launch never registers it;
 *   2. deactivate any already-registered adapter tools THIS session
 *      (prefixed names, plus bare catalog names only when sourceInfo says
 *      they came from the adapter).
 *
 * The shared `.mcp.json` is never rewritten. Foreign servers stay.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	findDevspecServers,
	getAdapterGuardState,
	parseConfigJson,
	persistDisabledOverlay,
	recordAdapterGuard,
	serversFromConfig,
	toolsToDeactivate,
	SUPPRESSION_NOTICE,
	SUPPRESSION_AGENT_GUIDANCE,
	type DevspecServerHit,
} from "./core/adapter-overlap.ts";
import { mcpUrl } from "./core/config.ts";
import { debugRemote } from "./core/debug.ts";

function readServers(path: string): { servers: Record<string, { url?: unknown; disabled?: unknown }>; ok: boolean } {
	try {
		return { servers: serversFromConfig(parseConfigJson(readFileSync(path, "utf8"))), ok: true };
	} catch {
		return { servers: {}, ok: false };
	}
}

function candidateConfigPaths(cwd: string): string[] {
	return [
		join(cwd, ".mcp.json"),
		join(homedir(), ".config", "mcp", "mcp.json"),
		join(homedir(), ".agents", "mcp.json"),
		join(homedir(), ".agents", "mcp", "mcp.json"),
	];
}

function overlayDisabledNames(cwd: string): Set<string> {
	const { servers, ok } = readServers(join(cwd, ".pi", "mcp.json"));
	if (!ok) return new Set();
	return new Set(Object.entries(servers).filter(([, e]) => e?.disabled === true).map(([n]) => n));
}

function discover(cwd: string): DevspecServerHit[] {
	const endpoint = mcpUrl();
	const overlayOff = overlayDisabledNames(cwd);
	const byName = new Map<string, DevspecServerHit>();
	for (const path of candidateConfigPaths(cwd)) {
		const { servers, ok } = readServers(path);
		if (!ok) continue;
		for (const hit of findDevspecServers(servers, path, endpoint)) {
			const already = hit.alreadyDisabled || overlayOff.has(hit.name);
			const next = { ...hit, alreadyDisabled: already };
			const prev = byName.get(hit.name);
			if (!prev) {
				byName.set(hit.name, next);
				continue;
			}
			if (prev.alreadyDisabled && !next.alreadyDisabled) byName.set(hit.name, next);
		}
	}
	return [...byName.values()];
}

function deactivate(pi: ExtensionAPI, serverNames: string[]): string[] {
	let registered: Array<{ name: string; sourceInfo?: { source?: string; path?: string } }> = [];
	try {
		registered = (pi.getAllTools?.() ?? []) as typeof registered;
	} catch (err) {
		debugRemote("adapter guard get tools failed", { errorPresent: Boolean(err) });
		return [];
	}
	const names = toolsToDeactivate(registered, serverNames);
	if (names.length === 0) return [];

	const unregister = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
	const leftover: string[] = [];
	for (const name of names) {
		if (unregister?.(name) === true) continue;
		leftover.push(name);
	}
	if (leftover.length === 0) return names;

	try {
		const active = pi.getActiveTools?.() ?? [];
		const drop = new Set(leftover);
		const next = active.filter((n) => !drop.has(n));
		if (next.length !== active.length) pi.setActiveTools(next);
	} catch (err) {
		debugRemote("adapter guard set active tools failed", { errorPresent: Boolean(err) });
	}
	return names;
}

function apply(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const cwd = ctx.cwd;
	if (!cwd) return;
	const hits = discover(cwd);
	if (hits.length === 0) {
		recordAdapterGuard({ suppressed: [], persisted: false, overlayPath: null });
		return;
	}

	const toPersist = hits.filter((h) => !h.alreadyDisabled).map((h) => h.name);
	let overlayPath: string | null = null;
	let wrote = false;
	if (toPersist.length > 0) {
		try {
			const result = persistDisabledOverlay(cwd, toPersist);
			overlayPath = result.path;
			wrote = result.changed;
		} catch (err) {
			debugRemote("adapter guard persist failed", { errorPresent: Boolean(err) });
		}
	}

	const deactivated = deactivate(pi, hits.map((h) => h.name));
	recordAdapterGuard({ suppressed: hits, persisted: wrote || hits.some((h) => h.alreadyDisabled), overlayPath });
	debugRemote("adapter guard applied", { serverCount: hits.length, deactivatedTools: deactivated.length });
	// Announce a configuration change, not routine startup state. Saved overrides
	// stay quiet; the agent's hidden context and on-demand help explain them.
	if (wrote && ctx.hasUI && ctx.mode === "tui") {
		ctx.ui.notify(SUPPRESSION_NOTICE, "info");
	}
}

export default function (pi: ExtensionAPI) {
	let explainedToAgent = false;
	pi.on("session_start", async (_event, ctx) => {
		explainedToAgent = false;
		try {
			apply(pi, ctx);
		} catch (err) {
			debugRemote("adapter guard failed", { errorPresent: Boolean(err) });
		}
	});

	// Adapter metadata can refresh after session_start and re-register
	// direct tools. Re-apply once the turn is about to start.
	pi.on("before_agent_start", async (_event, ctx) => {
		const state = getAdapterGuardState();
		if (state.suppressed.length === 0) return undefined;
		try {
			deactivate(pi, state.suppressed.map((h) => h.name));
		} catch (err) {
			debugRemote("adapter guard turn failed", { errorPresent: Boolean(err) });
		}
		// Tail context reaches the agent even before DevSpec sign-in. It never
		// rewrites a system prefix, claims native connection health, or includes
		// user-controlled server names. One note per session, not every turn.
		if (!explainedToAgent) {
			explainedToAgent = true;
			return {
				message: {
					customType: "devspec-mcp-guard",
					content: SUPPRESSION_AGENT_GUIDANCE,
					display: false,
				},
			};
		}
		return undefined;
	});
}
