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

// There is deliberately no turn-post marker here. Delivery has exactly one
// writer — the extension's mechanical settle (item cc9e8c43) — so there is
// nothing to suppress. The marker that lived here (857d984c) guarded a
// dual-writer model that no longer exists.
