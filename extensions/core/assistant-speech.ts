import { randomUUID } from "node:crypto";
import { extractAssistantParts } from "./trail.ts";

/** Nonsecret correlation only; the caller keeps the exact claim token private. */
type SpeechInteractionIdentity = { attemptId: string; eventId: string } &
	({ responseId: string; questionId?: never } | { questionId: string; responseId?: never });

/** Source authority is supplied by the controller, never inferred from prose. */
export type SpeechSourceAuthority =
	| { kind: "command"; commandTurnId: string; commandMessageId: string }
	| { kind: "interaction"; identity: Readonly<SpeechInteractionIdentity> }
	| { kind: "local" }
	| { kind: "unsupported"; reason: "notice_publication_unavailable" | "unknown_origin" | "missing_scope" | "invalid_scope" };

/** Credential-free source metadata. Transport secrets belong outside this DTO. */
export interface SpeechAuthoritySnapshot {
	readonly connectionId: string;
	readonly expectedSessionId?: string;
	/** Protected server authority epoch (UUID), not a counter or local generation. */
	readonly expectedRuntimeGeneration?: string;
	/** Preserve server timestamp precision verbatim; never round through Date. */
	readonly expectedAttachedAt?: string;
	/** Local stale-callback check only; not a substitute for the server fence. */
	readonly pumpGeneration: number;
	readonly source: Readonly<SpeechSourceAuthority>;
}

type SpeechModel = Readonly<{ providerID: string; modelID: string }>;

export interface CapturedAssistantSpeech {
	/** Extension-owned delivery identity, NOT a Pi session entry id. */
	readonly assistantSourceId: string;
	readonly text: string;
	readonly authority: Readonly<SpeechAuthoritySnapshot>;
	readonly model?: SpeechModel;
}

export interface AssistantSpeechSource {
	readonly assistantSourceId: string;
	readonly authority: Readonly<SpeechAuthoritySnapshot>;
	readonly model?: SpeechModel;
	/** First assistant finalization seals raw text, including empty text. */
	finalize(message: unknown): CapturedAssistantSpeech | null;
}

/** Only an emptiness test. Never use the normalized value as delivered text. */
export function hasAssistantSpeech(text: string): boolean {
	return text.replace(/[\s\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Begin before asynchronous provider work, not at message_start/message_end.
 * Carry this token through streaming; never relabel it with the current bond or
 * queued-but-not-consumed owner input. It supplies early diagnostic correlation,
 * not a Pi entry association. No credential is copied into the source record.
 */
export function beginAssistantSpeechSource(
	authority: SpeechAuthoritySnapshot,
	model?: SpeechModel,
): AssistantSpeechSource {
	let source: SpeechSourceAuthority = authority.source;
	if (source.kind !== "unsupported") {
		if (!authority.connectionId?.trim() || !authority.expectedSessionId?.trim() ||
			!authority.expectedRuntimeGeneration?.trim() || !authority.expectedAttachedAt?.trim()) {
			source = { kind: "unsupported", reason: "missing_scope" };
		} else if (!UUID.test(authority.expectedRuntimeGeneration)) {
			source = { kind: "unsupported", reason: "invalid_scope" };
		}
	}
	// Explicit projection also excludes unexpected transport credentials supplied
	// by structurally wider controller objects. Do not spread the input authority.
	const frozenAuthority: SpeechAuthoritySnapshot = Object.freeze({
		connectionId: authority.connectionId,
		expectedSessionId: authority.expectedSessionId,
		expectedRuntimeGeneration: authority.expectedRuntimeGeneration,
		expectedAttachedAt: authority.expectedAttachedAt,
		pumpGeneration: authority.pumpGeneration,
		source: source.kind === "interaction"
			? Object.freeze({ kind: source.kind, identity: Object.freeze({
				attemptId: source.identity.attemptId,
				eventId: source.identity.eventId,
				...(source.identity.responseId !== undefined
					? { responseId: source.identity.responseId }
					: { questionId: source.identity.questionId }),
			}) })
			: source.kind === "command"
				? Object.freeze({ kind: source.kind, commandTurnId: source.commandTurnId, commandMessageId: source.commandMessageId })
				: source.kind === "unsupported"
					? Object.freeze({ kind: source.kind, reason: source.reason })
					: Object.freeze({ kind: source.kind }),
	});
	const identity = {
		assistantSourceId: randomUUID(),
		authority: frozenAuthority,
		...(model ? { model: Object.freeze({ providerID: model.providerID, modelID: model.modelID }) } : {}),
	};
	let finalizedText: string | undefined;
	let captured: CapturedAssistantSpeech | null = null;
	return Object.freeze({
		...identity,
		finalize(message: unknown): CapturedAssistantSpeech | null {
			if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return null;
			const { text } = extractAssistantParts(message);
			if (finalizedText !== undefined) {
				if (text !== finalizedText) throw new Error("Assistant speech source text conflict.");
				return captured;
			}
			finalizedText = text;
			if (hasAssistantSpeech(text)) captured = Object.freeze({ ...identity, text });
			return captured;
		},
	});
}

/**
 * One-shot convenience for already-stable inputs/tests only. Cannot reconstruct
 * pre-provider authority from a mutable bond at message_end. Future production
 * hooks must use beginAssistantSpeechSource early and finalize that same token.
 * Each invocation is a new source; retry must retain the token or captured record.
 */
export function captureAssistantSpeech(
	message: unknown,
	authority: SpeechAuthoritySnapshot,
	model?: SpeechModel,
): CapturedAssistantSpeech | null {
	return beginAssistantSpeechSource(authority, model).finalize(message);
}

/** Proposed source-aware limits only; not activation of a deployed transport. */
export const ASSISTANT_SPEECH_MAX_CODE_POINTS = 100_000;
export const ASSISTANT_SPEECH_MAX_JSON_TEXT_BYTES = 512_000;

/** Counts JSON.stringify(text)'s UTF-8 bytes including quotes and escaping.
 * This checks text only, NOT the whole SQL JSONB input or Broadcast envelope.
 * Neither result is a send/storage receipt; the full source remains unchanged.
 */
export function preflightAssistantSpeech(text: string): {
	status: "within_budget" | "over_budget";
	codePoints: number;
	jsonTextBytes: number;
} {
	let codePoints = 0;
	for (const _ of text) codePoints++;
	const jsonTextBytes = Buffer.byteLength(JSON.stringify(text), "utf8");
	return {
		status: codePoints <= ASSISTANT_SPEECH_MAX_CODE_POINTS && jsonTextBytes <= ASSISTANT_SPEECH_MAX_JSON_TEXT_BYTES
			? "within_budget" : "over_budget",
		codePoints,
		jsonTextBytes,
	};
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
