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

/** A prompt shorter than this ("ok", "yes do it") is not worth the search a recall costs. */
const MIN_PROMPT_CHARS = 40;
/**
 * Automatic recall rides every substantive turn, so it injects only the few
 * highest-ranked agreed memories and says the rest of the ranking is one
 * search_memories call away. A bound on per-turn cost; the model's own searches
 * are not affected by it.
 */
const MAX_CARDS = 4;

/** Only substantive prompts are worth a recall search (and its ~300ms). */
export function shouldRecall(prompt: string): boolean {
	const p = prompt.trim();
	if (p.length < MIN_PROMPT_CHARS) return false;
	if (p.startsWith("/")) return false; // slash commands aren't topics
	return true;
}

/** The whole prompt, on one line: what the person asked is the query, not its first few hundred characters. */
export function recallQuery(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim();
}

/**
 * Automatic context is agreed-only (DevSpec decision a9e001e7e): a memory still
 * in discussion is not recalled unasked. It stays one search_memories call away.
 */
export function isAgreed(card: MemoryCard): boolean {
	return card.state === "decided";
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
	// updated_at is a row-maintenance clock (indexing, review stamps, flags),
	// not a knowledge revision. Keep all other context, including nested finding
	// evidence, so genuine changes still reinject. Follow-up 8effd88f.
	const { updated_at: _maintenanceClock, ...snapshot } = c;
	return `${c.id ?? c.title}:${snapshotHash(snapshot)}`;
}

/** Card fields rendered by their own blocks, or a row-maintenance clock that is not knowledge. */
const CARD_KEYS_RENDERED_APART = new Set(["id", "title", "summary", "type", "unresolved_disagreements", "disagreements_not_shown", "pending_proposals", "updated_at"]);

function cardDetails(c: MemoryCard): Record<string, unknown> {
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(c)) {
		if (CARD_KEYS_RENDERED_APART.has(key) || value === null || value === undefined) continue;
		if ((Array.isArray(value) && value.length === 0) || (typeof value === "string" && value.trim() === "")) continue;
		rest[key] = value;
	}
	return rest;
}

/**
 * Each card as DevSpec sent it — its state, delivery label, companions, pending
 * versions — with only the row-maintenance clock left out. `notAgreed` counts the
 * ranked memories still in discussion that were left out of automatic recall.
 */
export function formatRecallBlock(cards: MemoryCard[], notAgreed = 0): string {
	const lines = cards.map((c) => {
		const type = c.type ? `[${c.type}]` : "[memory]";
		const summary = c.summary ? ` — ${c.summary}` : "";
		const id = c.id ? ` (${c.id})` : "";
		const disagreement = disagreementBlock(c);
		const proposals = Array.isArray(c.pending_proposals) && c.pending_proposals.length
			? reviewData({ pending_proposals: c.pending_proposals }) : "";
		return [reviewData({ memory: `- ${type} ${c.title ?? "untitled"}${id}${summary}`, ...cardDetails(c) }), disagreement, proposals].filter(Boolean).join("\n");
	});
	return [
		"### DevSpec memory — auto-recall",
		"The project's agreed memories that rank highest against this turn's prompt. The ranking orders every memory by words and meaning; it does not judge that these apply, so decide which do. One that applies binds the work outside any disputed clause: read it in full with get_memory before relying on it. Disagreement data is not a ruling: preserve unaffected requirements and consult the served authority contract if this task depends on the disputed claim.",
		...lines,
		`${notAgreed > 0 ? `${notAgreed} more ranked memor${notAgreed === 1 ? "y is" : "ies are"} still in discussion and not recalled automatically. ` : ""}search_memories with your own query shows the rest of the ranking.`,
	].join("\n");
}
