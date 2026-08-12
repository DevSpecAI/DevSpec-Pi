/**
 * DevSpec Pi — conflict watch (shared store + pure extractors, unit-tested).
 *
 * DevSpec payloads already carry the signals — unresolved_conflicts on items,
 * reconcile_required / potential_conflicts on memory writes, related_candidates
 * on item creates. They arrive as TEXT the model might read. The watch makes
 * them structural: a shared flag store, a per-turn system-prompt nudge while
 * anything is open, and a /devspec.conflicts listing. Surfacing, never silent
 * settling — verdicts belong to the model-with-facts or the human.
 */

export interface ConflictFlag {
	key: string;
	kind: "item_conflict" | "related_candidates" | "memory_reconcile" | "memory_conflict";
	/** Display line. */
	label: string;
}

// Cross-extension-file store (pi isolates module graphs per extension file).
const GLOBAL_KEY = "__devspecPiConflictFlags";

function store(): Map<string, ConflictFlag> {
	const g = globalThis as unknown as Record<string, Map<string, ConflictFlag> | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
	return g[GLOBAL_KEY] as Map<string, ConflictFlag>;
}

export function listFlags(): ConflictFlag[] {
	return [...store().values()];
}

export function addFlags(flags: ConflictFlag[]): ConflictFlag[] {
	const added: ConflictFlag[] = [];
	for (const f of flags) {
		if (!store().has(f.key)) {
			store().set(f.key, f);
			added.push(f);
		}
	}
	return added;
}

export function clearFlag(key: string): void {
	store().delete(key);
}

export function clearAllFlags(): void {
	store().clear();
}

/** Scan a DevSpec tool result for conflict-ish signals. Pure. */
export function extractFlags(toolName: string, details: unknown): ConflictFlag[] {
	const d = details as Record<string, unknown> | null;
	if (!d || typeof d !== "object") return [];
	const flags: ConflictFlag[] = [];

	const unresolved = d.unresolved_conflicts;
	if (Array.isArray(unresolved)) {
		for (const c of unresolved) {
			const row = c as Record<string, unknown>;
			const otherId = (row.conflicting_item_id ?? row.item_id ?? "unknown") as string;
			const reason = typeof row.reason === "string" ? row.reason : "possible conflict";
			flags.push({
				key: `item_conflict:${otherId}`,
				kind: "item_conflict",
				label: `item …${String(otherId).slice(-8)}: ${reason} (settle with resolve_action_item_conflict)`,
			});
		}
	}

	const related = d.related_candidates;
	if (Array.isArray(related) && related.length > 0 && toolName === "create_action_item") {
		const first = related[0] as Record<string, unknown>;
		const id = (first.id ?? first.action_item_id ?? "unknown") as string;
		flags.push({
			key: `related:${id}`,
			kind: "related_candidates",
			label: `create returned ${related.length} related candidate(s), first …${String(id).slice(-8)} — confirm no duplicate`,
		});
	}

	if (d.reconcile_required) {
		const match = d.closest_match as Record<string, unknown> | undefined;
		const id = (match?.id ?? "unknown") as string;
		flags.push({
			key: `memory_reconcile:${id}`,
			kind: "memory_reconcile",
			label: `memory write recall-gated — near-duplicate …${String(id).slice(-8)} (supersede it, or confirm_new with reason)`,
		});
	}

	const potential = d.potential_conflicts;
	if (Array.isArray(potential) && potential.length > 0) {
		const first = potential[0] as Record<string, unknown>;
		const id = (first.id ?? "unknown") as string;
		flags.push({
			key: `memory_conflict:${id}`,
			kind: "memory_conflict",
			label: `${potential.length} potential memory conflict(s), first …${String(id).slice(-8)} — review when convenient`,
		});
	}

	return flags;
}

/** The per-turn nudge while anything is open. Null when clear. */
export function formatConflictNudge(flags: ConflictFlag[]): string | null {
	if (flags.length === 0) return null;
	const lines = flags.slice(0, 3).map((f) => `- ${f.label}`);
	const more = flags.length > 3 ? `\n- …and ${flags.length - 3} more` : "";
	return [
		`### DevSpec — ${flags.length} open signal${flags.length === 1 ? "" : "s"} to settle`,
		"Surfaced mechanically. Settle what the facts plainly settle yourself (related / not_a_conflict never close anything); escalate supersedes when someone's work would be closed. /devspec.conflicts lists all.",
		...lines,
	].join("\n") + more;
}
