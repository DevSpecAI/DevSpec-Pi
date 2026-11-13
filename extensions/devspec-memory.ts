/**
 * DevSpec Pi — automatic turn recall & review signals.
 *
 * Two mechanical behaviors, zero model compliance:
 *
 * 1. TURN RECALL — every substantive turn (a prompt typed here, or a command or
 *    automation run DevSpec delivered) asks DevSpec's turn recall which of the
 *    project's records bear on it, and the answer is added verbatim (task
 *    08f036e5, decision 3ea02bd2). DevSpec formats the cards; Pi never reads one
 *    by kind, so a record kind DevSpec adds later needs no plugin release.
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
 * ONE DELIVERY: this hook is the only place recall reaches a Pi conversation. A
 * DevSpec command arrives as a user message, so it starts a run here like a typed
 * prompt does; Pi's poller never asks poll_connection for recall
 * (`turn_recall_version`), so nothing arrives twice.
 *
 * SEEN CARDS: DevSpec names what it showed as `kind:id:vN` keys, kept on the
 * hidden message (`details.dedupeKeys`) and read back from the session branch, so
 * resume, /tree and /clear need no state of their own (core/recall.ts).
 *
 * FAILS OPEN: the whole recall (sign-in, scope, request, reply) has 2.8 s. Logged
 * out, no project evident, a refusal, an error or the deadline: nothing is added,
 * and the person's turn starts as it would have.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEndpoint, resolveToken } from "./core/auth-store.ts";
import { pluginHeaders } from "./core/client-versions.ts";
import { debugRemote } from "./core/debug.ts";
import { noteInjectedContext } from "./core/context-budget.ts";
import { conversationScope, hasConversationProjectScope } from "./core/project-choice.ts";
import { folderScopeArgs } from "./core/project-scope.ts";
import {
	PROACTIVE_CUSTOM_TYPE,
	RECALL_CLIENT_TIMEOUT_MS,
	isScopeMiss,
	readTurnRecall,
	recallTurn,
	scopeFingerprint,
	seenRecallKeys,
	turnRecallUrl,
	type BranchEntryLike,
	type TurnRecallAnswer,
} from "./core/recall.ts";
import { formatReviewNudge, listFlags } from "./core/review-watch.ts";
import { reviewScope, snapshotHash } from "./core/review-context.ts";
import { getBond, type BondState } from "./core/bond-state.ts";

export interface MemoryDeps {
	resolveToken: () => Promise<{ token: string } | null>;
	getBond: () => BondState | null;
	resolveEndpoint: () => Promise<string>;
	folderScope: (cwd: string) => Promise<{ git_remote?: string; pinned_project_id?: string }>;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	now: () => number;
	/** The whole recall's budget; the host contract's 2.8 s outside tests. */
	timeoutMs: number;
}

const DEFAULT_DEPS: MemoryDeps = {
	resolveToken,
	getBond,
	resolveEndpoint,
	folderScope: folderScopeArgs,
	fetch: (url, init) => fetch(url, init),
	now: () => Date.now(),
	timeoutMs: RECALL_CLIENT_TIMEOUT_MS,
};

interface RecallScope {
	body: Record<string, unknown>;
	headers: Record<string, string>;
	fingerprint: Record<string, unknown>;
}

interface ContextLike {
	cwd: string;
	sessionManager: { getSessionId: () => string; getBranch?: () => readonly BranchEntryLike[] };
}

/** Resolve to the promise's value, or null once `ms` has passed or it failed. Never rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	if (ms <= 0) return Promise.resolve(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
	return Promise.race([promise.catch(() => null), deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

export default function (pi: ExtensionAPI, overrides: Partial<MemoryDeps> = {}) {
	const deps: MemoryDeps = { ...DEFAULT_DEPS, ...overrides };
	/** Last injected review-set signature — nudge re-injects only on change. */
	let lastNudgeSig = "";
	/**
	 * Scopes DevSpec said it could not place in a project, per conversation. The same
	 * facts get the same answer, so they are not asked again in this conversation; a
	 * new pin, remote or bond is a new scope and is asked. Only those refusals are
	 * remembered — never a sign-in refusal, a server error or a timeout.
	 */
	const scopeMisses = new Map<string, Set<string>>();

	/** Which project this turn is for, from what is evident locally; null when nothing is. */
	async function turnScope(ctx: ContextLike, bond: BondState | null, endpoint: string): Promise<RecallScope | null> {
		if (bond?.connectionId && (bond.connectionCapability || bond.projectId)) {
			const body: Record<string, unknown> = {
				...(bond.connectionCapability ? {} : { connection_id: bond.connectionId }),
				...(bond.projectId ? { project_id: bond.projectId } : {}),
				...(bond.sessionId ? { session_id: bond.sessionId } : {}),
			};
			return {
				body,
				// The hidden capability is a transport header, never a body field or model text.
				headers: bond.connectionCapability ? { "x-devspec-connection-capability": bond.connectionCapability } : {},
				fingerprint: { ...body, connection: bond.connectionId },
			};
		}
		if (hasConversationProjectScope()) {
			let scoped: Record<string, unknown>;
			try {
				scoped = conversationScope({}, endpoint);
			} catch {
				return null; // this conversation's project choice is blocked: no recall until it is chosen
			}
			if (typeof scoped.project_id === "string") return { body: { project_id: scoped.project_id }, headers: {}, fingerprint: { project_id: scoped.project_id } };
		}
		const folder = await deps.folderScope(ctx.cwd);
		if (!folder.git_remote && !folder.pinned_project_id) return null;
		return { body: { ...folder }, headers: {}, fingerprint: { ...folder } };
	}

	async function recall(query: string, ctx: ContextLike, token: string, bond: BondState | null, deadlineAt: number): Promise<TurnRecallAnswer | null> {
		const endpoint = await deps.resolveEndpoint();
		const scope = await within(turnScope(ctx, bond, endpoint), deadlineAt - deps.now());
		if (!scope) return null;
		const conversationId = ctx.sessionManager.getSessionId();
		const fingerprint = scopeFingerprint(endpoint, scope.fingerprint);
		if (scopeMisses.get(conversationId)?.has(fingerprint)) return null;
		const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
		const seen = seenRecallKeys(branch);
		const remaining = deadlineAt - deps.now();
		if (remaining <= 0) return null;
		const startedAt = deps.now();
		const response = await deps.fetch(turnRecallUrl(endpoint), {
			method: "POST",
			signal: AbortSignal.timeout(remaining),
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...pluginHeaders(),
				...scope.headers,
			},
			body: JSON.stringify({
				query,
				host: "pi",
				conversation_id: conversationId,
				...scope.body,
				seen_versions: seen,
			}),
		});
		if (!response.ok) {
			const payload = await response.json().catch(() => null) as { code?: unknown } | null;
			const miss = isScopeMiss(response.status, payload?.code);
			if (miss) {
				const misses = scopeMisses.get(conversationId) ?? new Set<string>();
				misses.add(fingerprint);
				scopeMisses.set(conversationId, misses);
			}
			debugRemote("recall failed", { errorPresent: false, status: response.status, scopeMiss: miss });
			return null;
		}
		const answer = readTurnRecall(await response.json());
		debugRemote("recall", { queryChars: query.length, newHits: answer?.cards ?? 0, seenKeys: seen.length, ms: deps.now() - startedAt });
		return answer;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		const deadlineAt = deps.now() + deps.timeoutMs;
		const context = ctx as unknown as ContextLike;
		const resolved = await within(deps.resolveToken(), deadlineAt - deps.now());
		if (!resolved) return undefined;

		const bond = deps.getBond();
		const scope = reviewScope(context.sessionManager.getSessionId(), bond?.projectId ?? context.cwd, resolved.token);
		const parts: string[] = [];
		let dedupeKeys: string[] = [];

		// 1. Turn recall.
		const turn = recallTurn(event as unknown as { messageType?: unknown; prompt?: unknown });
		if (turn.recall) {
			const answer = await within(
				recall(turn.query, context, resolved.token, bond, deadlineAt).catch((err) => {
					debugRemote("recall failed", { errorPresent: Boolean(err), timedOut: deps.now() >= deadlineAt });
					return null;
				}),
				deadlineAt - deps.now(),
			);
			if (answer) {
				// A late answer cannot move private context into a new account, project or conversation.
				const current = await within(deps.resolveToken(), Math.max(100, deadlineAt - deps.now()));
				const now = deps.getBond();
				if (!current || scope !== reviewScope(context.sessionManager.getSessionId(), now?.projectId ?? context.cwd, current.token)) return undefined;
				noteInjectedContext("recall", answer.block.length);
				parts.push(answer.block);
				dedupeKeys = answer.keys;
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
				customType: PROACTIVE_CUSTOM_TYPE,
				content: parts.join("\n\n"),
				display: false,
				details: { dedupeKeys },
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
