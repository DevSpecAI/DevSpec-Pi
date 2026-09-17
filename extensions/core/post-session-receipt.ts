import { unwrapMcpResult } from "./result.ts";

export type PostSessionReceipt =
	| { status: "stored" | "idempotently_stored"; messageId: string }
	| { status: "skipped" | "rejected" | "malformed" };

export interface ExpectedPostReceipt {
	connectionId: string;
	sessionId: string;
	phase: string;
	turnKind?: string;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : null;
}

/** Accept deployed text-JSON and structured MCP envelopes, never transport success alone. */
export function parsePostSessionReceipt(raw: unknown, expected: ExpectedPostReceipt): PostSessionReceipt {
	const { details, isError } = unwrapMcpResult(raw);
	if (isError) return { status: "rejected" };
	const data = record(details);
	if (!data) return { status: "malformed" };
	const receipt = record(data.delivery);
	if (receipt?.status === "rejected") return { status: "rejected" };
	if (data.skipped === true || data.noop === true || receipt?.status === "skipped") return { status: "skipped" };
	if (data.error !== undefined) return { status: "rejected" };
	if (data.session_id !== expected.sessionId || data.phase !== expected.phase ||
		data.connection_id !== expected.connectionId ||
		(expected.turnKind !== undefined && data.turn_kind !== expected.turnKind) ||
		typeof data.message_id !== "string" || !data.message_id.trim()) return { status: "malformed" };
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

	markDirty(): void { this.revision += 1; }
	get dirty(): boolean { return this.revision !== this.acknowledged; }
	get blocked(): boolean { return this.failed || this.pending !== null; }
	begin(): number | null {
		if (!this.dirty || this.blocked) return null;
		this.pending = this.revision;
		return this.pending;
	}
	finish(snapshot: number, stored: boolean): void {
		if (this.pending !== snapshot) return;
		this.pending = null;
		if (stored) this.acknowledged = snapshot;
		else this.failed = true;
	}
}
