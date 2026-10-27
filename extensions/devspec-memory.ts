/**
 * DevSpec Pi — proactive memory & signals (Phase 5).
 *
 * Two mechanical behaviors, zero model compliance:
 *
 * 1. AUTO-RECALL — every substantive prompt is searched against project
 *    memory before the turn starts; new hits are injected.
 * 2. REVIEW NUDGE — while review questions seen on records are open (possibly
 *    out of date, waiting for someone's OK), a nudge injects (only when the
 *    open set CHANGES, so it doesn't spam).
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
import { callDevspec, MODEL_TIMEOUT_MS } from "./core/client.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { debugRemote } from "./core/debug.ts";
import { noteInjectedContext } from "./core/context-budget.ts";
import {
	cardKey,
	extractCards,
	formatRecallBlock,
	isAgreed,
	recallQuery,
	shouldRecall,
	unseenCards,
} from "./core/recall.ts";
import { formatReviewNudge, listFlags, observeReviewResult } from "./core/review-watch.ts";
import { reviewScope, snapshotHash } from "./core/review-context.ts";
import { getBond } from "./core/bond-state.ts";

export default function (pi: ExtensionAPI, deps = { resolveToken, callDevspec, getBond }) {
	/** Immutable snapshots already injected, isolated by account/project/session. */
	const injectedByScope = new Map<string, Set<string>>();
	/** Last injected review-set signature — nudge re-injects only on change. */
	let lastNudgeSig = "";

	pi.on("before_agent_start", async (event, ctx) => {
		const resolved = await deps.resolveToken();
		if (!resolved) return undefined;

		const bond = deps.getBond();
		const scope = reviewScope(ctx.sessionManager.getSessionId(), bond?.projectId ?? ctx.cwd, resolved.token);
		const injected = injectedByScope.get(scope) ?? new Set<string>();
		injectedByScope.set(scope, injected);
		const parts: string[] = [];

		// 1. Auto-recall.
		if (shouldRecall(event.prompt)) {
			const query = recallQuery(event.prompt);
			try {
				const raw = await deps.callDevspec(
					resolved.token,
					"search_memories",
					{ query, limit: 8 },
					{ cwd: ctx.cwd, lane: "work", timeoutMs: MODEL_TIMEOUT_MS },
				);
				const { details, isError } = unwrapMcpResult(raw);
				// A late read cannot move private context into a new account/project.
				const currentToken = await deps.resolveToken();
				if (!currentToken || scope !== reviewScope(ctx.sessionManager.getSessionId(), deps.getBond()?.projectId ?? ctx.cwd, currentToken.token)) return undefined;
				if (!isError) {
					observeReviewResult("search_memories", details, { query }, scope);
					const cards = extractCards(details);
					const agreed = cards.filter(isAgreed);
					const fresh = unseenCards(agreed, injected);
					for (const c of fresh) {
						const k = cardKey(c);
						if (k) injected.add(k);
					}
					if (fresh.length > 0) {
						debugRemote("recall", { queryChars: query.length, newHits: fresh.length });
						const recall = formatRecallBlock(fresh, cards.length - agreed.length);
						noteInjectedContext("recall", recall.length);
						parts.push(recall);
					} else {
						debugRemote("recall", { queryChars: query.length, newHits: 0 });
					}
				}
			} catch (err) {
				debugRemote("recall failed", { errorPresent: Boolean(err) });
			}
		}

		// 2. Review nudge — only when the open set changed since last inject.
		const flags = listFlags(scope);
		const sig = snapshotHash([scope, flags]);
		if (!flags.length) lastNudgeSig = "";
		if (flags.length > 0 && sig !== lastNudgeSig) {
			lastNudgeSig = sig;
			const nudge = formatReviewNudge(flags);
			if (nudge) {
				noteInjectedContext("conflictNudge", nudge.length);
				parts.push(nudge);
			}
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

	pi.registerCommand("devspec.review", {
		description: "List the open review questions (possibly out of date, or waiting for someone's OK) seen on records in this session's project.",
		handler: async (_args, ctx) => {
			const token = await deps.resolveToken();
			if (!token) return;
			const flags = listFlags(reviewScope(ctx.sessionManager.getSessionId(), deps.getBond()?.projectId ?? ctx.cwd, token.token));
			if (flags.length === 0) {
				ctx.ui.notify("DevSpec: no open review questions seen this session.", "info");
				return;
			}
			ctx.ui.notify(
				formatReviewNudge(flags) ?? "No observed Review context.",
				"warning",
			);
		},
	});
}
