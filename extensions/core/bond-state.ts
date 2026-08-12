/**
 * DevSpec Pi — bond state (shared across extension files).
 *
 * IMPORTANT: pi loads every extension file with a FRESH module graph
 * (jiti `moduleCache: false`), so module-level state is NOT shared between
 * extension files. Anything cross-extension must live on globalThis.
 */

export interface BondState {
	connectionId: string;
	codename?: string;
	/** Attached DevSpec session, when attached (sessionless otherwise). */
	sessionId?: string;
	/** The attached session's title, learned by the attach-time context fetch. */
	sessionTitle?: string;
	/** The bond owner's display name (e.g. "Ali Price") — envelopes say names, not roles. */
	ownerName?: string;
	/** One-shot room orientation digest, captured at cold-start sync. */
	roomDigest?: string;
	/** One-shot attach-time context block (identity + recent tail), set when the
	 *  adopted session changes — injected once per attach, never replayed. */
	attachContext?: string;
	/** Instruction tiers returned by register/attach — applied while bonded. */
	instructions?: {
		owner_custom_instructions?: string;
		owner_agent_rules?: string;
		project_custom_instructions?: string;
		project_agent_rules?: string;
	};
}

const GLOBAL_KEY = "__devspecPiBond";

interface BondStore {
	current: BondState | null;
}

function store(): BondStore {
	const g = globalThis as unknown as Record<string, BondStore | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { current: null };
	return g[GLOBAL_KEY] as BondStore;
}

export function getBond(): BondState | null {
	return store().current;
}

export function setBond(bond: BondState | null): void {
	store().current = bond;
}

// ---- Complete-turn post marker -------------------------------------------
// The settle path must never mirror a turn whose answer already posted via
// the post_session_message tool (one turn = one answer; item 857d984c).
// The event-stream signal (tool_execution_end) proved lossy in production —
// trailing text after a complete_turn post leaked as a second bubble three
// times in one evening — so the post itself now leaves a mark HERE, at the
// source of truth, and the settle consults it. No event-ordering assumptions.
// Like the bond, this lives on globalThis so every extension file shares it.

const GLOBAL_POST_KEY = "__devspecPiTurnPosts";

interface TurnPostStore {
	completeTurnPostedAt: number | null;
}

function postStore(): TurnPostStore {
	const g = globalThis as unknown as Record<string, TurnPostStore | undefined>;
	if (!g[GLOBAL_POST_KEY]) g[GLOBAL_POST_KEY] = { completeTurnPostedAt: null };
	return g[GLOBAL_POST_KEY] as TurnPostStore;
}

/** Mark that a complete_turn answer posted successfully just now. */
export function noteCompleteTurnPost(at: number = Date.now()): void {
	postStore().completeTurnPostedAt = at;
}

/** True when a complete_turn post landed at or after `sinceMs`. */
export function completeTurnPostedSince(sinceMs: number): boolean {
	const at = postStore().completeTurnPostedAt;
	return at !== null && at >= sinceMs;
}
