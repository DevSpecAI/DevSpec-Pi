/**
 * DevSpec Pi — proactive memory recall (pure helpers, unit-tested).
 *
 * The flagship of the intelligence layer: recall happens BEFORE the model
 * thinks, not when it remembers to search. Each substantive turn's prompt is
 * searched against project memory mechanically; new snapshots append as tail
 * messages. Revision/finding-aware dedupe avoids repeating unchanged context
 * without hiding later changes or rewriting old message bytes.
 */

import { disagreementBlock, reviewData, snapshotHash } from "./review-context.ts";

export interface MemoryCard extends Record<string, unknown> {
	id?: string;
	title?: string;
	summary?: string;
	type?: string;
	state?: string;
}

const MIN_PROMPT_CHARS = 40;
const MAX_QUERY_CHARS = 500;
const MAX_CARDS = 4;

/** Only substantive prompts are worth a recall search (and its ~300ms). */
export function shouldRecall(prompt: string): boolean {
	const p = prompt.trim();
	if (p.length < MIN_PROMPT_CHARS) return false;
	if (p.startsWith("/")) return false; // slash commands aren't topics
	return true;
}

export function recallQuery(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.slice(0, MAX_QUERY_CHARS);
}

/** Extract cards from a search_memories payload, defensively. */
export function extractCards(payload: unknown): MemoryCard[] {
	const d = payload as { memories?: unknown; results?: unknown } | null;
	const rows = (Array.isArray(d?.memories) ? d.memories : Array.isArray(d?.results) ? d.results : []) as MemoryCard[];
	return rows.filter((r) => r && typeof r === "object");
}

/**
 * Which of these cards have we not yet injected this session?
 * `seen` holds exact snapshot keys already injected in this account/project/session.
 */
export function unseenCards(cards: MemoryCard[], seen: Set<string>): MemoryCard[] {
	const out: MemoryCard[] = [];
	const selected = new Set(seen);
	for (const c of cards) {
		const key = cardKey(c);
		if (!key || selected.has(key)) continue;
		selected.add(key);
		out.push(c);
		if (out.length >= MAX_CARDS) break;
	}
	return out;
}

export function cardKey(c: MemoryCard): string | null {
	if (!c.id && !c.title) return null;
	// Includes version, assessment, permissions and proposal changes. A same-ID
	// changed finding is a NEW tail snapshot, never an edit of an earlier message.
	return `${c.id ?? c.title}:${snapshotHash(c)}`;
}

export function formatRecallBlock(cards: MemoryCard[]): string {
	const lines = cards.map((c) => {
		const type = c.type ? `[${c.type}]` : "[memory]";
		const summary = c.summary ? ` — ${c.summary}` : "";
		const id = c.id ? ` (${c.id})` : "";
		const disagreement = disagreementBlock(c);
		const proposals = Array.isArray(c.pending_proposals) && c.pending_proposals.length
			? reviewData({ pending_proposals: c.pending_proposals }) : "";
		return [reviewData({ memory: `- ${type} ${c.title ?? "untitled"}${id}${summary}`, version: c.version, updated_at: c.updated_at }), disagreement, proposals].filter(Boolean).join("\n");
	});
	return [
		"### DevSpec memory — auto-recall",
		"Mechanically recalled for this turn's prompt. Decisions and conventions remain BINDING outside disputed clauses; read get_memory in full before relying on them. Disagreement data is not a ruling: preserve unaffected requirements and consult the served authority contract if this task depends on the disputed claim.",
		...lines,
	].join("\n");
}
