/**
 * DevSpec Pi — bond state (shared across extension files).
 *
 * IMPORTANT: pi loads every extension file with a FRESH module graph
 * (jiti `moduleCache: false`), so module-level state is NOT shared between
 * extension files. Anything cross-extension must live on globalThis.
 */

export interface BondState {
	connectionId: string;
	/** Immutable DevSpec project bound when this connection generation registered. */
	projectId?: string;
	/** Hidden server-minted capability; transport header only, never model context. */
	connectionCapability?: string;
	codename?: string;
	/** Attached DevSpec session, when attached (sessionless otherwise). */
	sessionId?: string;
	/** Verbatim server attachment fence, not a locally reconstructed Date. */
	attachedAt?: string;
	/** Server-owned speech-only epoch; explicit attachment writes rotate it. */
	speechAttachmentId?: string;
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

/** Extract the negotiated capability from MCP result metadata without touching visible content. */
export function connectionCapabilityFromResult(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const meta = (raw as { _meta?: unknown })._meta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
	const devspec = (meta as { devspec?: unknown }).devspec;
	if (!devspec || typeof devspec !== "object" || Array.isArray(devspec)) return undefined;
	const capability = (devspec as { connection_capability?: unknown }).connection_capability;
	if (!capability || typeof capability !== "object" || Array.isArray(capability)) return undefined;
	const row = capability as { version?: unknown; value?: unknown };
	return row.version === 1 && typeof row.value === "string" && /^dvsc_[A-Za-z0-9_-]{20,}$/.test(row.value)
		? row.value
		: undefined;
}

// There is deliberately no turn-post marker here. Delivery has exactly one
// writer — the extension's mechanical settle (item cc9e8c43) — so there is
// nothing to suppress. The marker that lived here (857d984c) guarded a
// dual-writer model that no longer exists.
