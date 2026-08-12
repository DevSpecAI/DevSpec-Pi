/**
 * DevSpec Pi — proactive memory & signals (Phase 5).
 *
 * Two mechanical behaviors, zero model compliance:
 *
 * 1. AUTO-RECALL — every substantive prompt is searched against project
 *    memory before the turn starts; new hits are injected.
 * 2. CONFLICT NUDGE — while conflict-ish signals are open, a settle nudge
 *    injects (only when the open-set CHANGES, so it doesn't spam).
 *
 * CACHE DISCIPLINE (learned from production stats): both inject as a TAIL
 * message via before_agent_start's message channel — NEVER as system-prompt
 * additions. Provider prompt caches are prefix-based; mutating the system
 * prompt per turn invalidates the entire conversation's cache (observed:
 * CH 0.1%). A message injected just before the new user turn preserves the
 * whole prefix. The static workflow block (devspec-context) stays in the
 * system prompt because it is byte-identical every turn.
 *
 * Cost discipline: one search_memories call per substantive turn, none for
 * short/command prompts; no calls at all when logged out; a recall failure
 * never blocks a turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { callDevspec } from "./core/client.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { debugRemote } from "./core/debug.ts";
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
	/** Last injected conflict-set signature — nudge re-injects only on change. */
	let lastNudgeSig = "";

	pi.on("before_agent_start", async (event, ctx) => {
		const resolved = await resolveToken();
		if (!resolved) return undefined;

		const parts: string[] = [];

		// 1. Auto-recall.
		if (shouldRecall(event.prompt)) {
			const query = recallQuery(event.prompt);
			try {
				const raw = await callDevspec(
					resolved.token,
					"search_memories",
					{ query, limit: 8 },
					{ cwd: ctx.cwd },
				);
				const { details, isError } = unwrapMcpResult(raw);
				if (!isError) {
					const fresh = unseenCards(extractCards(details), injected);
					for (const c of fresh) {
						const k = cardKey(c);
						if (k) injected.add(k);
					}
					if (fresh.length > 0) {
						debugRemote(`recall: "${query.slice(0, 80)}" → ${fresh.length} new: ${fresh.map((c) => c.title).join(" | ")}`);
						parts.push(formatRecallBlock(fresh));
					} else {
						debugRemote(`recall: "${query.slice(0, 80)}" → nothing new`);
					}
				}
			} catch (err) {
				debugRemote(`recall failed: ${err instanceof Error ? err.message : err}`);
			}
		}

		// 2. Conflict nudge — only when the open-set changed since last inject.
		const flags = listFlags();
		const sig = flags.map((f) => f.key).sort().join(",");
		if (flags.length > 0 && sig !== lastNudgeSig) {
			lastNudgeSig = sig;
			const nudge = formatConflictNudge(flags);
			if (nudge) parts.push(nudge);
		}

		if (parts.length === 0) return undefined;
		return {
			message: {
				customType: "devspec-proactive",
				content: parts.join("\n\n"),
				display: false,
			},
		};
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
