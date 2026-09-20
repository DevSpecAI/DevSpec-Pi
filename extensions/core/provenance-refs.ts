/**
 * The provenance-ref guard (item a03ba7ab).
 *
 * Opaque 36-character UUIDs cross the model boundary by transcription, and
 * transcription corrupts them — watched live on 2026-09-20 (session 340ca456):
 * the server delivered `5733cc70-9ca8-4bb5-8261-…` and the model's writes came
 * back carrying `5733cc70-9ca8-4f6d-9f10-…` — same 64-bit prefix, fabricated
 * tail. The server refused correctly; the failure was invisible until it did.
 *
 * This module holds the one set the extension can know with certainty: the refs
 * this process has actually been DEALT (delivery refs from validated ingress
 * commands, work-claim refs observed in claim results). The guard refuses a
 * write whose ref was never dealt here — locally, before the network, naming
 * the current turn's refs and teaching omission, which is the safe default
 * (the server attributes to the connection's single open turn).
 *
 * Deliberate scope: the rule is NEVER-DEALT, never "not currently valid".
 * Whether a dealt ref is still inside the live turn is the server's call
 * (651's live-turn check) — this guard does not duplicate it. A dealt-but-old
 * ref passes here and the server decides; a fabricated one dies at the door.
 *
 * Never rewrite a ref: attribution is the point of the system.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DealtRef {
	turnId: string | null;
	seq: number;
}

interface RefStore {
	delivery: Map<string, DealtRef>;
	claim: Set<string>;
	seq: number;
}

// jiti duplicates modules; Symbol.for(globalThis) keeps one store per process
// (the established pattern from active-deliveries.ts).
const STORE_KEY = Symbol.for("devspec.pi.provenance-refs.v1");
const CAP = 512;

function store(): RefStore {
	const root = globalThis as typeof globalThis & { [STORE_KEY]?: RefStore };
	if (!root[STORE_KEY]) root[STORE_KEY] = { delivery: new Map(), claim: new Set(), seq: 0 };
	return root[STORE_KEY];
}

function cap(map: Map<string, DealtRef>): void {
	while (map.size > CAP) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}

function noteDeliveryRef(ref: unknown, turnId: string | null): void {
	if (typeof ref !== "string" || !UUID.test(ref)) return;
	const key = ref.trim().toLowerCase();
	const s = store();
	s.delivery.set(key, { turnId, seq: ++s.seq });
	cap(store().delivery);
}

/** The parsed, intake-validated commands of an accepted delivery. Idempotent. */
export function noteDeliveredCommandRefs(
	commands: readonly { delivery?: { provenance_ref?: unknown; primary_provenance_ref?: unknown; turn_id?: unknown } }[],
): void {
	for (const command of commands) {
		const delivery = command.delivery;
		if (!delivery) continue;
		const turnId = typeof delivery.turn_id === "string" ? delivery.turn_id : null;
		noteDeliveryRef(delivery.provenance_ref, turnId);
		noteDeliveryRef(delivery.primary_provenance_ref, turnId);
	}
}

/** work_claim_ref values observed in successful claim results this process. */
export function noteObservedClaimRef(value: unknown): void {
	if (typeof value !== "string" || !UUID.test(value)) return;
	const claims = store().claim;
	claims.add(value.trim().toLowerCase());
	while (claims.size > CAP) {
		const oldest = claims.values().next();
		if (oldest.done) break;
		claims.delete(oldest.value);
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

/** Claim refs ride claim results (details.work_claim_ref or top level). */
export function observeResultClaimRefs(result: unknown): void {
	const root = record(result);
	if (!root) return;
	const details = record(root.details) ?? root;
	noteObservedClaimRef(details.work_claim_ref);
}

/** Bond/connection resets clear the dealt set with the turn bindings (6f4136d8's lifecycle). */
export function clearDealtRefs(): void {
	store().delivery.clear();
	store().claim.clear();
}

export type RefGuardVerdict = { ok: true } | { ok: false; message: string };

function currentTurnRefs(): string[] {
	const entries = [...store().delivery.entries()];
	if (entries.length === 0) return [];
	const latest = entries.reduce((a, b) => (b[1].seq > a[1].seq ? b : a));
	const turn = latest[1].turnId;
	const refs = entries.filter(([, v]) => v.turnId === turn).map(([k]) => k);
	return refs.length > 0 ? refs : [latest[0]];
}

function refuse(kind: "provenance_ref" | "work_claim_ref", value: string): RefGuardVerdict {
	if (kind === "provenance_ref") {
		const known = currentTurnRefs();
		const hint = known.length > 0
			? `This session's current command refs are: ${known.join(", ")}. Unless you mean one of those exactly, omit the parameter: the server attributes the write to the active turn by default.`
			: "No command has been delivered to this process, so that value did not come from a delivery here. Omit the parameter: the server attributes the write to the active turn by default.";
		return {
			ok: false,
			message: `Unknown provenance_ref "${value}" — never delivered to this process (a mistyped ref fails closed; the server would reject it too). ${hint}`,
		};
	}
	return {
		ok: false,
		message: `Unknown work_claim_ref "${value}" — no claim result this process has seen carries it. Copy the work_claim_ref from the claim_work_item result verbatim, or omit it and let the server resolve the current claim.`,
	};
}

/**
 * Check the model-supplied provenance refs on a tool call before it costs a
 * server round-trip. Omission is always allowed — it is the default. Only a
 * present, non-empty value is checked, and only against what this process has
 * verifiably been dealt.
 */
export function guardWriteRefs(args: Record<string, unknown>): RefGuardVerdict {
	const provenance = args.provenance_ref;
	if (typeof provenance === "string" && provenance.trim()) {
		const key = provenance.trim().toLowerCase();
		if (!UUID.test(key) || !store().delivery.has(key)) return refuse("provenance_ref", provenance.trim());
	}
	const claim = args.work_claim_ref;
	if (typeof claim === "string" && claim.trim()) {
		const key = claim.trim().toLowerCase();
		if (!UUID.test(key) || !store().claim.has(key)) return refuse("work_claim_ref", claim.trim());
	}
	return { ok: true };
}
