/**
 * DevSpec Pi — per-turn telemetry collector (item 1906e21f, control plane).
 *
 * Mechanical, zero-token: sums pi's own per-message usage (every assistant
 * message_end carries a full Usage) into per-turn and per-session totals, and
 * renders the compact report the extension rides on the settle answer post +
 * the idle heartbeat. The server stores it on the connection row and the UI
 * shows it live — nobody can watch a terminal that lives in a container.
 *
 * Pure + unit-tested, matching the repo convention: the report SHAPE is the
 * contract, so it is built and sanitized here, never inline in the extension.
 */

import type { ContextBudgetReport } from "./context-budget.ts";

/** Subset of pi-ai's Usage the report reads (kept structural — no import). */
export interface MessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

/** The wire shape posted to DevSpec (agent_stats). Bump `v` on breaking edits. */
export interface AgentStatsReport {
	v: 1;
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	context: { tokens: number | null; window: number | null; percent: number | null } | null;
	/** Numeric-only DevSpec attribution; no prompt/tool payload content. */
	contextBudget?: ContextBudgetReport;
	turn: UsageTotals & { messages: number };
	session: UsageTotals & { turns: number };
	at: string;
}

function emptyTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

/** Finite non-negative number, else 0 — provider usage fields are best-effort. */
function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function addInto(totals: UsageTotals, usage: MessageUsage): void {
	totals.input += num(usage.input);
	totals.output += num(usage.output);
	totals.cacheRead += num(usage.cacheRead);
	totals.cacheWrite += num(usage.cacheWrite);
	totals.costUsd += num(usage.cost?.total);
}

function addTotals(into: UsageTotals, t: UsageTotals): void {
	into.input += t.input;
	into.output += t.output;
	into.cacheRead += t.cacheRead;
	into.cacheWrite += t.cacheWrite;
	into.costUsd += t.costUsd;
}

function round6(n: number): number {
	return Math.round(n * 1_000_000) / 1_000_000;
}

function rounded(t: UsageTotals): UsageTotals {
	return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, costUsd: round6(t.costUsd) };
}

export class TelemetryCollector {
	private turn = emptyTotals();
	private turnMessages = 0;
	private session = emptyTotals();
	private sessionTurns = 0;

	/** One assistant message_end's usage folded into the running turn. */
	addMessageUsage(usage: MessageUsage | null | undefined): void {
		if (!usage) return;
		addInto(this.turn, usage);
		this.turnMessages += 1;
	}

	/**
	 * Close the turn: fold its totals into the session accumulators and return
	 * the per-turn + per-session view. Resets the per-turn side. Idempotent
	 * turns with no messages still report (zeros), so the UI always has fresh
	 * context%/model even on a usage-free turn.
	 */
	settleTurn(): { turn: UsageTotals & { messages: number }; session: UsageTotals & { turns: number } } {
		const turn = { ...rounded(this.turn), messages: this.turnMessages };
		addTotals(this.session, this.turn);
		this.sessionTurns += 1;
		this.turn = emptyTotals();
		this.turnMessages = 0;
		return { turn, session: { ...rounded(this.session), turns: this.sessionTurns } };
	}
}

/**
 * Build the wire report. Context/model/thinking come from the extension
 * context at settle time (passed in, keeping this module pi-free).
 */
export function buildAgentStatsReport(input: {
	turn: UsageTotals & { messages: number };
	session: UsageTotals & { turns: number };
	model?: { provider?: string; id?: string } | null;
	thinkingLevel?: string | null;
	context?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	contextBudget?: ContextBudgetReport;
	now?: string;
}): AgentStatsReport {
	const ctx = input.context;
	return {
		v: 1,
		model:
			input.model && (input.model.provider || input.model.id)
				? { provider: input.model.provider ?? "", id: input.model.id ?? "" }
				: null,
		thinkingLevel: input.thinkingLevel ?? null,
		context: ctx
			? {
					tokens: typeof ctx.tokens === "number" && Number.isFinite(ctx.tokens) ? Math.round(ctx.tokens) : null,
					window: Number.isFinite(ctx.contextWindow) ? ctx.contextWindow : null,
					percent:
						typeof ctx.percent === "number" && Number.isFinite(ctx.percent)
							? Math.round(ctx.percent * 10) / 10
							: null,
				}
			: null,
		...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
		turn: input.turn,
		session: input.session,
		at: input.now ?? new Date().toISOString(),
	};
}

/**
 * Refresh only the runtime identity/context on the last report. Used by idle
 * heartbeats and model/thinking events so those settings update immediately
 * without pretending a new turn settled or discarding the last usage totals.
 */
export function refreshAgentStatsReport(input: {
	previous?: AgentStatsReport | null;
	model?: { provider?: string; id?: string } | null;
	thinkingLevel?: string | null;
	context?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
	contextBudget?: ContextBudgetReport;
	now?: string;
}): AgentStatsReport {
	const zeroTurn = { ...emptyTotals(), messages: 0 };
	const zeroSession = { ...emptyTotals(), turns: 0 };
	return buildAgentStatsReport({
		turn: input.previous?.turn ?? zeroTurn,
		session: input.previous?.session ?? zeroSession,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		context: input.context,
		contextBudget: input.contextBudget ?? input.previous?.contextBudget,
		now: input.now,
	});
}
