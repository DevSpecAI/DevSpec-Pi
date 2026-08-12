/**
 * DevSpec Pi — proactive memory & signals (Phase 5).
 *
 * Two mechanical behaviors, zero model compliance:
 *
 * 1. AUTO-RECALL — every substantive prompt is searched against project
 *    memory before the turn starts; new hits inject into the system prompt.
 *    Session-level dedupe: a memory injects once, then it's in context.
 *    Recall happens before the model thinks, not when it remembers to search.
 *
 * 2. CONFLICT NUDGE — while any conflict-ish signal is open (fed by the tool
 *    wrapper scanning results), before_agent_start adds a settle nudge.
 *    /devspec.conflicts lists what's open.
 *
 * Cost discipline: one search_memories call per substantive turn, none for
 * short/command prompts; no calls at all when logged out.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { callDevspec } from "./core/client.ts";
import { unwrapMcpResult } from "./core/result.ts";
import {
	cardKey,
	extractCards,
	formatRecallBlock,
	recallQuery,
	shouldRecall,
	unseenCards,
} from "./core/recall.ts";
import { formatConflictNudge, listFlags } from "./core/conflict-watch.ts";

export default function (pi: ExtensionAPI) {
	/** Ids injected this session (module state = per extension instance). */
	const injected = new Set<string>();

	pi.on("before_agent_start", async (event, ctx) => {
		const resolved = await resolveToken();
		if (!resolved) return undefined;

		let addition = "";

		// 1. Auto-recall.
		if (shouldRecall(event.prompt)) {
			try {
				const raw = await callDevspec(
					resolved.token,
					"search_memories",
					{ query: recallQuery(event.prompt), limit: 8 },
					{ cwd: ctx.cwd },
				);
				const { details, isError } = unwrapMcpResult(raw);
				if (!isError) {
					const fresh = unseenCards(extractCards(details), injected);
					for (const c of fresh) {
						const k = cardKey(c);
						if (k) injected.add(k);
					}
					if (fresh.length > 0) addition += `\n\n${formatRecallBlock(fresh)}`;
				}
			} catch {
				// Recall is enhancement — never block a turn on it.
			}
		}

		// 2. Conflict nudge while anything is open.
		const nudge = formatConflictNudge(listFlags());
		if (nudge) addition += `\n\n${nudge}`;

		if (!addition) return undefined;
		return { systemPrompt: `${event.systemPrompt}${addition}` };
	});

	pi.registerCommand("devspec.conflicts", {
		description: "List open DevSpec signals (conflicts, reconcile gates, related candidates) seen this session.",
		handler: async (_args, ctx) => {
			const flags = listFlags();
			if (flags.length === 0) {
				ctx.ui.notify("DevSpec: no open signals this session.", "info");
				return;
			}
			ctx.ui.notify(
				`Open signals (${flags.length}):\n${flags.map((f) => `  • ${f.label}`).join("\n")}`,
				"warning",
			);
		},
	});
}
