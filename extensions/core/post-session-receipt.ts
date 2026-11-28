import { unwrapMcpResult } from "./result.ts";

/**
 * Complete structured refusal payload returned by DevSpec on a rejected or
 * skipped `post_session_message` call, preserved unmodified (requirement
 * 4e32d1a5 — no field subsetting and no silent slicing).
 */
export type PostSessionRefusal = Record<string, unknown>;

export type PostSessionReceipt =
	| { status: "stored" | "idempotently_stored"; messageId: string; diagnosticsOnly?: true }
	| { status: "skipped" | "rejected" | "malformed"; refusal?: PostSessionRefusal };

export interface ExpectedPostReceipt {
	connectionId: string;
	sessionId?: string | null;
	phase: string;
	turnKind?: string;
	/** Source-aware delivery must not accept a different row's legacy receipt. */
	assistantSourceId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : null;
}

/** Preserve the server's structured refusal object whole, never dropping fields or slicing text. */
export function extractPostSessionRefusal(details: unknown, text?: string): PostSessionRefusal | undefined {
	const data = record(details);
	if (data && Object.keys(data).length > 0) return { ...data };
	if (typeof text === "string" && text.trim()) return { error: text.trim() };
	if (typeof details === "string" && details.trim()) return { error: details.trim() };
	return undefined;
}

/** Accept deployed text-JSON and structured MCP envelopes, never transport success alone. */
export function parsePostSessionReceipt(raw: unknown, expected: ExpectedPostReceipt): PostSessionReceipt {
	const { details, text, isError } = unwrapMcpResult(raw);
	if (isError) {
		const refusal = extractPostSessionRefusal(details, text);
		return refusal ? { status: "rejected", refusal } : { status: "rejected" };
	}
	const data = record(details);
	if (!data) return { status: "malformed" };
	const receipt = record(data.delivery);
	if (receipt?.status === "rejected") {
		const refusal = extractPostSessionRefusal(data, text);
		return refusal ? { status: "rejected", refusal } : { status: "rejected" };
	}
	if (data.skipped === true || data.noop === true || receipt?.status === "skipped") {
		const refusal = extractPostSessionRefusal(data, text);
		return refusal ? { status: "skipped", refusal } : { status: "skipped" };
	}
	if (data.error !== undefined) {
		const refusal = extractPostSessionRefusal(data, text);
		return refusal ? { status: "rejected", refusal } : { status: "rejected" };
	}
	const expectedSessionId = expected.sessionId ?? null;
	if ((data.session_id ?? null) !== expectedSessionId || data.phase !== expected.phase ||
		data.connection_id !== expected.connectionId ||
		(expected.turnKind !== undefined && data.turn_kind !== expected.turnKind)) return { status: "malformed" };
	// Attempt-backed trail posts (DevSpecV2 PR #1708 / item 01932667) attach directly
	// to `agent_connection_activity` for BOTH ordinary room commands (`diagnostics_only: false`)
	// and non-command runs (`diagnostics_only: true`) with `attempt_id` and no top-level
	// `message_id`. Accept both so ordinary room activity never freezes after its first
	// stored update, and mark `diagnosticsOnly: true` so `noteOwnRoomMessage` never treats
	// an `attempt_id` as a chat row.
	if (expected.phase === "trail" && typeof data.attempt_id === "string" && data.attempt_id.trim()) {
		if (!receipt || (receipt.status !== "stored" && receipt.status !== "idempotently_stored") ||
			receipt.message_id !== data.attempt_id) return { status: "malformed" };
		return { status: receipt.status, messageId: data.attempt_id, diagnosticsOnly: true };
	}
	if (typeof data.message_id !== "string" || !data.message_id.trim()) return { status: "malformed" };
	if (expected.assistantSourceId !== undefined &&
		(data.assistant_source_id !== expected.assistantSourceId || !receipt)) return { status: "malformed" };
	if (data.delivery !== undefined) {
		if (!receipt || (receipt.status !== "stored" && receipt.status !== "idempotently_stored") ||
			receipt.message_id !== data.message_id) return { status: "malformed" };
		return { status: receipt.status, messageId: data.message_id };
	}
	// Legacy answer (including local_prompt) and trail successes all include the
	// persisted row id, session, connection and phase. Bare noop is NOT idempotence.
	return { status: "stored", messageId: data.message_id };
}

/** A cumulative snapshot stays dirty until acknowledged. Failure stops automatic
 * replay for this segment: stale authority and ambiguous response loss are not retry permission. */
export class TrailDeliveryState {
	private revision = 0;
	private acknowledged = 0;
	private pending: number | null = null;
	private failed = false;
	private lastRefusal: PostSessionRefusal | undefined = undefined;

	markDirty(): void { this.revision += 1; }
	get dirty(): boolean { return this.revision !== this.acknowledged; }
	get blocked(): boolean { return this.failed || this.pending !== null; }
	get refusal(): PostSessionRefusal | undefined { return this.lastRefusal; }
	begin(): number | null {
		if (!this.dirty || this.blocked) return null;
		this.pending = this.revision;
		return this.pending;
	}
	finish(snapshot: number, stored: boolean, refusal?: PostSessionRefusal): void {
		if (this.pending !== snapshot) return;
		this.pending = null;
		if (stored) {
			this.acknowledged = snapshot;
			this.lastRefusal = undefined;
		} else {
			this.failed = true;
			if (refusal) this.lastRefusal = refusal;
		}
	}
}
