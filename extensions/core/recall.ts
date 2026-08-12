/**
 * DevSpec Pi — proactive memory recall (pure helpers, unit-tested).
 *
 * The flagship of the intelligence layer: recall happens BEFORE the model
 * thinks, not when it remembers to search. Each substantive turn's prompt is
 * searched against project memory mechanically; new hits are injected into
 * the system prompt. Session-level dedupe keeps the prompt bounded — a
 * memory is injected once, then it's already in context.
 */

export interface MemoryCard {
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
 * `seen` holds ids (or title fallbacks) already injected.
 */
export function unseenCards(cards: MemoryCard[], seen: Set<string>): MemoryCard[] {
	const out: MemoryCard[] = [];
	for (const c of cards) {
		const key = c.id ?? c.title;
		if (!key || seen.has(key)) continue;
		out.push(c);
		if (out.length >= MAX_CARDS) break;
	}
	return out;
}

export function cardKey(c: MemoryCard): string | null {
	return c.id ?? c.title ?? null;
}

export function formatRecallBlock(cards: MemoryCard[]): string {
	const lines = cards.map((c) => {
		const type = c.type ? `[${c.type}]` : "[memory]";
		const summary = c.summary ? ` — ${c.summary}` : "";
		const id = c.id ? ` (${c.id})` : "";
		return `- ${type} ${c.title ?? "untitled"}${id}${summary}`;
	});
	return [
		"### DevSpec memory — auto-recall",
		"Mechanically recalled for this turn's prompt. Decisions and conventions are BINDING — call get_memory for the full body before relying on or contradicting one.",
		...lines,
	].join("\n");
}
