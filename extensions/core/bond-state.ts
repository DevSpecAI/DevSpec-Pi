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
