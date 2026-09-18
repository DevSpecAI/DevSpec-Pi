import { randomUUID } from "node:crypto";
import type { ExactInteractionContinuationIdentity } from "./interaction-events.ts";
import { extractAssistantParts } from "./trail.ts";

/** Source authority is supplied by the controller, never inferred from prose. */
export type SpeechSourceAuthority =
	| { kind: "command"; commandTurnId: string; commandMessageId: string }
	| { kind: "interaction"; identity: Readonly<ExactInteractionContinuationIdentity> }
	| { kind: "local" }
	| { kind: "unsupported"; reason: "notice_publication_unavailable" | "unknown_origin" };

export interface SpeechAuthoritySnapshot {
	readonly connectionId: string;
	readonly expectedSessionId: string;
	/** Local stale-callback check only; not a substitute for the server fence. */
	readonly pumpGeneration: number;
	readonly connectionCapability?: string;
	readonly source: Readonly<SpeechSourceAuthority>;
}

export interface CapturedAssistantSpeech {
	/** Extension-owned delivery identity, NOT a Pi session entry id. */
	readonly assistantSourceId: string;
	readonly text: string;
	readonly authority: Readonly<SpeechAuthoritySnapshot>;
	readonly model?: Readonly<{ providerID: string; modelID: string }>;
}

/** Only an emptiness test. Never use the normalized value as delivered text. */
export function hasAssistantSpeech(text: string): boolean {
	return text.replace(/[\s\p{Cf}]/gu, "").length > 0;
}

/**
 * Call synchronously for each finalized assistant message, before awaiting or
 * replacing turn state. Retries reuse the returned record; a new invocation is
 * a new source even for identical text. Host append happens after message_end,
 * so no current-leaf association or durable restart reconciliation is claimed.
 * Unsupported publication still captures speech; it does not invent authority.
 */
export function captureAssistantSpeech(
	message: unknown,
	authority: SpeechAuthoritySnapshot,
	model?: { providerID: string; modelID: string },
): CapturedAssistantSpeech | null {
	if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return null;
	const { text } = extractAssistantParts(message);
	if (!hasAssistantSpeech(text)) return null;
	const source = authority.source.kind === "interaction"
		? Object.freeze({ ...authority.source, identity: Object.freeze({ ...authority.source.identity }) })
		: Object.freeze({ ...authority.source });
	return Object.freeze({
		assistantSourceId: randomUUID(),
		text,
		authority: Object.freeze({ ...authority, source }),
		...(model ? { model: Object.freeze({ ...model }) } : {}),
	});
}

/**
 * One controller instance must enqueue both speech and trail-pointer writes.
 * Accept a thunk, not an already-started request. Errors reach the caller and
 * release the lane for later sources; neither failure nor drain replays a post.
 * Every thunk must recheck its captured authority immediately before transport.
 */
export class ProjectionPostQueue {
	private tail: Promise<void> = Promise.resolve();

	enqueue<T>(post: () => Promise<T>): Promise<T> {
		const result = this.tail.then(post);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	async drain(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.tail;
			await pending;
		} while (pending !== this.tail);
	}
}
