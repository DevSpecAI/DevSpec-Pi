/** Prevent a second DevSpec connection without touching another host's MCP configuration. */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getAdapterGuardState, recordAdapterGuard, toolsToDeactivate, isAdapterSource,
	SUPPRESSION_NOTICE, SUPPRESSION_AGENT_GUIDANCE, type DevspecServerHit,
} from "./core/adapter-overlap.ts";
import { configPaths, migrateLegacyOverlay, disableEffectiveNativeDuplicates, disableAdapterDuplicates, type AdapterConfigApi } from "./core/mcp-config-guard.ts";
import { mcpUrl } from "./core/config.ts";
import { debugRemote } from "./core/debug.ts";

export default function (pi: ExtensionAPI) {
	let explained = false;
	let changed = false;
	let failed = false;
	let hits: DevspecServerHit[] = [];
	let nativeHits: DevspecServerHit[] = [];
	let adapterHits: DevspecServerHit[] = [];
	function duplicateTools() {
		if (!nativeHits.length && !adapterHits.length) return [];
		const tools = pi.getAllTools();
		return [
			...toolsToDeactivate(tools.filter((tool) => tool.sourceInfo?.path === "builtin:mcp"), nativeHits.map((hit) => hit.name)),
			...toolsToDeactivate(tools.filter((tool) => isAdapterSource(tool.sourceInfo)), adapterHits.map((hit) => hit.name)),
		];
	}

	function deactivate(): void {
		const names = new Set(duplicateTools());
		// Config preflight prevents first registration. This also removes cached adapter
		// declarations on the migration run; never overwrite another extension's tools.
		const active = pi.getActiveTools();
		const next = active.filter((name) => !names.has(name));
		if (next.length !== active.length) pi.setActiveTools(next);
	}

	async function prepare(ctx: ExtensionContext): Promise<void> {
		changed = false; failed = false; hits = []; nativeHits = []; adapterHits = [];
		const trusted = ctx.isProjectTrusted();
		try {
			const paths = configPaths(getAgentDir(), ctx.cwd, trusted);
			for (const path of paths) changed = migrateLegacyOverlay(path.native, path.adapter) || changed;
			if (pi.getCommands().some((command) => command.name === "mcp" && command.sourceInfo?.path === "builtin:mcp")) {
				const native = disableEffectiveNativeDuplicates(paths.map((path) => path.native), mcpUrl());
				nativeHits = native.hits; hits.push(...native.hits); changed = native.changed || changed;
			}
			// Only consult shared/Claude configurations when the adapter is actually loaded.
			// Resolve its PUBLIC config export from the loaded extension's own location,
			// not our dependency graph and not a guessed global npm installation.
			const adapter = pi.getCommands().find((command) => command.name === "mcp-adapter" || (command.name === "mcp" && isAdapterSource(command.sourceInfo)));
			if (adapter && trusted) {
				const source = adapter.sourceInfo?.path;
				if (!source) throw new Error("Adapter source unavailable");
				const entry = createRequire(source).resolve("pi-mcp-adapter/config");
				const api = await import(pathToFileURL(entry).href) as AdapterConfigApi;
				const flag = pi.getFlag("mcp-config");
				const result = disableAdapterDuplicates(api, ctx.cwd, mcpUrl(), typeof flag === "string" ? flag : undefined);
				adapterHits = result.hits; hits.push(...result.hits); changed = result.changed || changed;
			}
		} catch (error) {
			failed = true;
			// Config/error text can contain credentials. Never log it.
			debugRemote("adapter guard failed", { errorPresent: Boolean(error) });
		}
		recordAdapterGuard({ suppressed: hits, persisted: !failed, overlayPath: null });
	}

	// Pi loads user extensions before its built-in MCP extension. Prepare only
	// after project trust; never inspect a project's configuration during factory load.
	pi.on("session_start", async (_event, ctx) => {
		explained = false;
		listenForAdapterCalls();
		await prepare(ctx);
		deactivate();
		if (failed) ctx.ui.notify("DevSpec could not check duplicate MCP settings. Review Pi’s /mcp settings and any conflicting or malformed MCP files. If you use pi-mcp-adapter, update it to 4.0 or later, then reload. No shared MCP configuration was changed.", "warning");
		else if (changed && ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.notify(hits.length ? SUPPRESSION_NOTICE : "Updated legacy Pi MCP settings. Shared MCP configuration and other agents are unchanged.", "info");
		}
		changed = false;
	});
	// An adapter loaded before us can already have cached registrations/connections.
	// Block its resolved calls (including proxy/script routes), not just declarations.
	let unsubscribe: (() => void) | undefined;
	function listenForAdapterCalls() {
		unsubscribe ??= pi.events.on("pi-mcp-adapter:tool-approval-request", (raw: unknown) => {
			const request = raw as { serverName?: string; claim?: (handler: () => string) => boolean };
			if (adapterHits.some((hit) => hit.name === request?.serverName) && typeof request.claim === "function") request.claim(() => "deny");
		});
	}
	pi.on("session_shutdown", async () => { unsubscribe?.(); unsubscribe = undefined; });
	pi.on("tool_call", async (event) => {
		const names = duplicateTools().filter((name) => name === event.toolName);
		const resource = ["read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"].includes(event.toolName);
		if (names.length || (resource && nativeHits.some((hit) => hit.name === (event.input as Record<string, unknown>).server))) {
			return { block: true, reason: "Use the native DevSpec tools instead of the duplicate MCP connection." };
		}
	});
	pi.on("tool_result", async () => { deactivate(); });
	pi.on("before_agent_start", async () => {
		deactivate();
		if (explained || getAdapterGuardState().suppressed.length === 0) return;
		explained = true;
		return { message: { customType: "devspec-mcp-guard", content: SUPPRESSION_AGENT_GUIDANCE, display: false } };
	});
}
