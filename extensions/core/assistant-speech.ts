import { randomUUID } from "node:crypto";
import { extractAssistantParts } from "./trail.ts";

/** Emptiness predicate only; the delivered string is never normalized. */
export function hasAssistantSpeech(text: string): boolean {
	return text.replace(/[\s\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").length > 0;
}

export interface AssistantSpeechRecord {
	readonly assistantSourceId: string;
	readonly text: string;
}

/** Created before provider work; one finalization, one stable retry identity. */
export class AssistantSpeechSource {
	readonly assistantSourceId = randomUUID();
	private text: string | undefined;
	private record: AssistantSpeechRecord | null = null;
	finalize(message: unknown): AssistantSpeechRecord | null {
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return null;
		const { text } = extractAssistantParts(message);
		if (this.text !== undefined) {
			if (this.text !== text) throw new Error("Assistant speech source text conflict.");
			return this.record;
		}
		this.text = text;
		if (hasAssistantSpeech(text)) this.record = Object.freeze({ assistantSourceId: this.assistantSourceId, text });
		return this.record;
	}
}

export function assistantSpeechWithinBudget(text: string): boolean {
	return [...text].length <= 100_000 && Buffer.byteLength(JSON.stringify(text), "utf8") <= 512_000;
}

/** Serial source delivery only; errors do not poison later independent speech. */
export class AssistantSpeechQueue {
	private tail: Promise<void> = Promise.resolve();
	enqueue(post: () => Promise<void>): Promise<void> {
		const next = this.tail.then(post);
		this.tail = next.catch(() => undefined);
		return next;
	}
}
