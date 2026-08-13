/**
 * DevSpec Pi — /devspec.work and /devspec.help (Phase 3).
 *
 * /devspec.work [id-or-prefix]
 *   No arg: pull the next staged item from the project queue.
 *   Arg:    resolve an explicit item (full UUID, id prefix, or unique title
 *           fragment against the local completion cache).
 *   The command validates/resolves only — the kickoff prompt it sends drives
 *   the claim (claim guards need the model's judgment, not command side
 *   effects). The turn is a REAL user message via pi.sendUserMessage().
 *
 *   Argument completion is served synchronously from a cache of open items;
 *   the cache refreshes in the background on session_start and whenever it is
 *   stale (pi's completion API is sync, so the first completion after a
 *   refresh trigger may be one refresh behind).
 *
 * /devspec.help
 *   What this package provides + connection state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAdapterGuardState, SUPPRESSION_NOTICE } from "./core/adapter-overlap.ts";
import { resolveToken } from "./core/auth-store.ts";
import { callDevspec } from "./core/client.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { buildWorkPrompt } from "./core/work-prompt.ts";
import type { WorkTarget } from "./core/work-prompt.ts";
import { noteWork, paintStatus } from "./core/status-line.ts";

const CACHE_TTL_MS = 60_000;

interface ItemSummary {
	id: string;
	title: string;
}

let itemCache: { at: number; items: ItemSummary[] } = { at: 0, items: [] };

async function refreshItemCache(): Promise<void> {
	const resolved = await resolveToken();
	if (!resolved) return;
	try {
		const raw = await callDevspec(resolved.token, "get_action_items", { fields: "compact", limit: 100 });
		const { details } = unwrapMcpResult(raw);
		const rows = (details as { items?: Array<{ id?: string; title?: string }> } | null)?.items;
		if (Array.isArray(rows)) {
			itemCache = {
				at: Date.now(),
				items: rows
					.filter((r) => typeof r?.id === "string")
					.map((r) => ({ id: r.id as string, title: typeof r.title === "string" ? r.title : "" })),
			};
		}
	} catch {
		// Keep serving the stale cache; completion is best-effort.
	}
}

function refreshIfStale(): void {
	if (Date.now() - itemCache.at > CACHE_TTL_MS) void refreshItemCache();
}

function completeItemArg(prefix: string): AutocompleteItem[] | null {
	refreshIfStale();
	const p = prefix.toLowerCase();
	const matches = itemCache.items
		.filter((i) => i.id.toLowerCase().startsWith(p) || i.title.toLowerCase().includes(p))
		.slice(0, 20)
		.map((i) => ({ value: i.id, label: `${i.id.slice(0, 8)}… ${i.title}`.trim() }));
	return matches.length > 0 ? matches : null;
}

/** Resolve the command argument to an item id, or return an error message. */
async function resolveItemArg(arg: string): Promise<{ id: string } | { error: string }> {
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
		return { id: arg };
	}
	await refreshItemCache();
	const p = arg.toLowerCase();
	const matches = itemCache.items.filter(
		(i) => i.id.toLowerCase().startsWith(p) || i.title.toLowerCase().includes(p),
	);
	if (matches.length === 1) return { id: matches[0].id };
	if (matches.length > 1) {
		const listing = matches.slice(0, 5).map((i) => `  ${i.id.slice(0, 8)}… ${i.title}`).join("\n");
		return { error: `Ambiguous item "${arg}" — matches:\n${listing}\nPass a fuller id.` };
	}
	return { error: `No open action item matches "${arg}". Try /devspec.work with no argument to pull the queue.` };
}

async function fetchItemById(id: string): Promise<WorkTarget> {
	const resolved = await resolveToken();
	if (!resolved) throw new Error("not connected");
	const raw = await callDevspec(resolved.token, "get_action_item", { action_item_id: id });
	const { details, text, isError } = unwrapMcpResult(raw);
	if (isError) throw new Error(text || "get_action_item failed");
	const d = details as { id?: string; title?: string; item?: { id?: string; title?: string } } | null;
	const item = (d?.item ?? d) as { id?: string; title?: string } | null;
	return { id: item?.id ?? id, title: item?.title, payload: details ?? text, fromQueue: false };
}

async function fetchNextFromQueue(): Promise<WorkTarget | null> {
	const resolved = await resolveToken();
	if (!resolved) throw new Error("not connected");
	const raw = await callDevspec(resolved.token, "get_next_work_item", {});
	const { details, text, isError } = unwrapMcpResult(raw);
	if (isError) throw new Error(text || "get_next_work_item failed");
	const d = details as Record<string, unknown> | null;
	// Empty queue comes back as an empty object / null-ish payload.
	const id = (d?.id ?? (d?.item as { id?: string } | undefined)?.id) as string | undefined;
	if (!d || !id) return null;
	const title = (d.title ?? (d.item as { title?: string } | undefined)?.title) as string | undefined;
	return { id, title, payload: d, fromQueue: true };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx) => {
		void refreshItemCache();
	});

	pi.registerCommand("devspec.work", {
		description: "Work a DevSpec action item — pick from the queue, or pass an id/title.",
		getArgumentCompletions: completeItemArg,
		handler: async (args, ctx: ExtensionContext) => {
			const resolved = await resolveToken();
			if (!resolved) {
				ctx.ui.notify("Not connected to DevSpec — run /devspec.login first.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy — /devspec.work when the current turn finishes.", "warning");
				return;
			}

			const arg = args.trim();
			let target: WorkTarget | null;
			try {
				if (arg) {
					const r = await resolveItemArg(arg);
					if ("error" in r) {
						ctx.ui.notify(r.error, "warning");
						return;
					}
					target = await fetchItemById(r.id);
				} else {
					target = await fetchNextFromQueue();
					if (!target) {
						ctx.ui.notify("DevSpec queue is empty — nothing staged to work.", "info");
						return;
					}
				}
			} catch (err) {
				ctx.ui.notify(`DevSpec: ${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}

			void refreshItemCache();
			noteWork({ id: target.id, title: target.title });
			paintStatus(ctx);
			pi.sendUserMessage(buildWorkPrompt(target));
		},
	});

	pi.registerCommand("devspec.help", {
		description: "What the DevSpec package provides, and connection state.",
		handler: async (_args, ctx) => {
			const resolved = await resolveToken();
			const lines = [
				"DevSpec commands:",
				"  /devspec.work [item]  — work an action item (queue pick, or id/title)",
				"  /devspec.remote       — bond as remote capacity (auto on launch; stop | auto on|off)",
				"  /devspec.login        — connect (token from the DevSpec Connections page)",
				"  /devspec.status       — connection state",
				"  /devspec.logout       — remove the stored token",
				"  /devspec.logo         — toggle the duck header",
				"",
				`DevSpec tools: native (this package). Foreign MCP servers you connected stay available.`,
				`Connection: ${resolved ? `token from ${resolved.source}` : "not connected — /devspec.login"}`,
			];
			const guard = getAdapterGuardState();
			if (guard.suppressed.length > 0) lines.push("", SUPPRESSION_NOTICE);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
