/**
 * DevSpec Pi — explicit work selection and package help.
 *
 * /devspec.work [id-or-prefix]
 *   Arg: resolve one explicit item.
 *   No arg: present an item selector when UI is available. It never drains a
 *   queue; other work arrives through remote dispatch.
 *
 * The command mechanically loads/caches the product implementation contract,
 * records the delivery for the selected item, and sends one real user kickoff
 * message. Claim guards remain server-authoritative. There is no execution mode
 * to select — DevSpec item 6d085535 deleted the concept.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { getAdapterGuardState, SUPPRESSION_NOTICE } from "./core/adapter-overlap.ts";
import { resolveToken } from "./core/auth-store.ts";
import { callDevspec, MODEL_TIMEOUT_MS } from "./core/client.ts";
import {
	buildImplementationKickoff,
	createImplementationContractLoader,
	loadImplementationContext,
} from "./core/implementation-contract.ts";
import { recordActiveDelivery, rollbackActiveDelivery } from "./core/active-deliveries.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { noteWork, paintStatus } from "./core/status-line.ts";
import { buildWorkPrompt, type WorkTarget } from "./core/work-prompt.ts";

const CACHE_TTL_MS = 60_000;

interface ItemSummary {
	id: string;
	title: string;
}

let cacheCwd = process.cwd();
let itemCache: { at: number; scope: string; items: ItemSummary[] } = { at: 0, scope: "", items: [] };

function itemCacheScope(token: string, cwd: string): string {
	return `${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 24)}:${cwd}`;
}

async function refreshItemCache(cwd = cacheCwd): Promise<boolean> {
	const resolved = await resolveToken();
	if (!resolved) {
		itemCache = { at: 0, scope: "", items: [] };
		return false;
	}
	const scope = itemCacheScope(resolved.token, cwd);
	try {
		const raw = await callDevspec(
			resolved.token,
			"get_action_items",
			{ fields: "compact", limit: 100 },
			{ lane: "work", timeoutMs: MODEL_TIMEOUT_MS },
		);
		const { details } = unwrapMcpResult(raw);
		const rows = (details as { items?: Array<{ id?: string; title?: string }> } | null)?.items;
		if (Array.isArray(rows)) {
			itemCache = {
				at: Date.now(),
				scope,
				items: rows
					.filter((row) => typeof row?.id === "string")
					.map((row) => ({ id: row.id as string, title: typeof row.title === "string" ? row.title : "" })),
			};
			return true;
		}
		return false;
	} catch {
		// Stale autocomplete is acceptable only within the same authority/cwd.
		if (itemCache.scope !== scope) itemCache = { at: 0, scope, items: [] };
		return false;
	}
}

function refreshIfStale(): void {
	if (Date.now() - itemCache.at > CACHE_TTL_MS) void refreshItemCache();
}

function completeItemArg(prefix: string): AutocompleteItem[] | null {
	refreshIfStale();
	const normalized = prefix.toLowerCase();
	const matches = itemCache.items
		.filter((item) => item.id.toLowerCase().startsWith(normalized) || item.title.toLowerCase().includes(normalized))
		.slice(0, 20)
		.map((item) => ({ value: item.id, label: `${item.id.slice(0, 8)}… ${item.title}`.trim() }));
	return matches.length > 0 ? matches : null;
}

async function resolveItemArg(arg: string): Promise<{ id: string } | { error: string }> {
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
		return { id: arg };
	}
	if (!await refreshItemCache()) {
		return { error: "Could not refresh DevSpec action items. No work was started." };
	}
	const normalized = arg.toLowerCase();
	const matches = itemCache.items.filter(
		(item) => item.id.toLowerCase().startsWith(normalized) || item.title.toLowerCase().includes(normalized),
	);
	if (matches.length === 1) return { id: matches[0]!.id };
	if (matches.length > 1) {
		const listing = matches.slice(0, 5).map((item) => `  ${item.id.slice(0, 8)}… ${item.title}`).join("\n");
		return { error: `Ambiguous item “${arg}” — matches:\n${listing}\nPass a fuller id.` };
	}
	return { error: `No open action item matches “${arg}”. Pass an id/title or run /devspec.work to choose explicitly.` };
}

async function selectExplicitItem(ctx: ExtensionContext): Promise<string | null> {
	if (!await refreshItemCache(ctx.cwd)) {
		ctx.ui.notify("Could not refresh DevSpec action items — no work was started.", "warning");
		return null;
	}
	if (itemCache.items.length === 0) {
		ctx.ui.notify("No open DevSpec action items are available to select.", "info");
		return null;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Pass an explicit action-item id to /devspec.work in this mode.", "warning");
		return null;
	}
	const labels = itemCache.items.map((item) => `${item.id.slice(0, 8)}… ${item.title}`.trim());
	const chosen = await ctx.ui.select("Choose one action item to work on:", labels);
	if (!chosen) return null;
	const index = labels.indexOf(chosen);
	return index >= 0 ? itemCache.items[index]!.id : null;
}

async function fetchItemById(id: string): Promise<WorkTarget> {
	const resolved = await resolveToken();
	if (!resolved) throw new Error("not connected");
	const raw = await callDevspec(
		resolved.token,
		"get_action_item",
		{ action_item_id: id },
		{ lane: "work", timeoutMs: MODEL_TIMEOUT_MS },
	);
	const { details, text, isError } = unwrapMcpResult(raw);
	if (isError) throw new Error(text || "get_action_item failed");
	const root = details as { id?: string; title?: string; item?: { id?: string; title?: string } } | null;
	const item = (root?.item ?? root) as { id?: string; title?: string } | null;
	return { id: item?.id ?? id, title: item?.title, payload: details ?? text };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		cacheCwd = ctx.cwd;
		itemCache = { at: 0, scope: "", items: [] };
		void refreshItemCache(ctx.cwd);
	});

	pi.registerCommand("devspec.work", {
		description: "Select one explicit DevSpec action item to work on.",
		getArgumentCompletions: completeItemArg,
		handler: async (args, ctx: ExtensionContext) => {
			const resolved = await resolveToken();
			if (!resolved) {
				ctx.ui.notify("Not connected to DevSpec — run /devspec.login first.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy — use /devspec.work when the current turn finishes.", "warning");
				return;
			}

			const arg = args.trim();
			let id: string | null = null;
			if (arg) {
				const match = await resolveItemArg(arg);
				if ("error" in match) {
					ctx.ui.notify(match.error, "warning");
					return;
				}
				id = match.id;
			} else {
				id = await selectExplicitItem(ctx);
			}
			if (!id) return;

			try {
				const [target, implementationContext] = await Promise.all([
					fetchItemById(id),
					loadImplementationContext({
						loader: createImplementationContractLoader(resolved.token),
					}),
				]);
				const kickoff = buildImplementationKickoff({
					actionItemIds: [target.id],
					context: implementationContext,
				});
				const delivery = recordActiveDelivery(kickoff, implementationContext);
				try {
					pi.sendUserMessage(buildWorkPrompt(target, implementationContext));
				} catch (error) {
					rollbackActiveDelivery(delivery);
					throw error;
				}
				if (implementationContext.warning) ctx.ui.notify(implementationContext.warning, "warning");
				void refreshItemCache(ctx.cwd);
				noteWork({ id: target.id, title: target.title });
				paintStatus(ctx);
			} catch (error) {
				ctx.ui.notify(`DevSpec: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("devspec.help", {
		description: "What the DevSpec package provides, and connection state.",
		handler: async (_args, ctx) => {
			const resolved = await resolveToken();
			const lines = [
				"DevSpec commands:",
				"  /devspec.work [item]  — select one action item to work (id/title, or picker)",
				"  /devspec.remote       — bond as remote capacity (auto on launch; stop | auto on|off)",
				"  /devspec.reload       — reload this extension (same as /reload)",
				"  /devspec.login        — connect (token from the DevSpec Connections page)",
				"  /devspec.pin <id>     — explicitly associate this folder with a DevSpec project",
				"  /devspec.status       — connection state",
				"  /devspec.logout       — remove the stored token",
				"  /devspec.logo         — toggle the duck header",
				"",
				"Your owner can also send you work through DevSpec remote control; you reserve it yourself. Nothing is ever pushed to you, and this command never drains a queue.",
				"DevSpec tools are native to this package. Foreign MCP servers remain available.",
				`Connection: ${resolved ? `token from ${resolved.source}` : "not connected — /devspec.login"}`,
			];
			const guard = getAdapterGuardState();
			if (guard.suppressed.length > 0) lines.push("", SUPPRESSION_NOTICE);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
