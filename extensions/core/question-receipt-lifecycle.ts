/**
 * Runtime-mechanical lifecycle for a tool batch whose durable customer-visible
 * output is owned by canonical directed-question transcript receipts.
 *
 * The server receipt owns only the otherwise-empty transcript/trail bubble. Pi
 * still executes every tool and always completes the exact activity attempt.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

/** Host-only receipt identity. It is control metadata and must never enter prose. */
export function directedQuestionTranscriptReceiptId(result: unknown): string | null {
	const outer = record(result);
	const details = record(outer?.details) ?? outer;
	const question = record(details?.question);
	const id = question?.transcriptMessageId;
	return typeof id === "string" && UUID.test(id) ? id : null;
}

export interface ReceiptToolResult {
	success: boolean;
	terminatingReceipt: boolean;
}

export function isPotentialDirectedQuestionCreate(
	toolName: string,
	args: unknown,
): boolean {
	return toolName === "manage_directed_question" && record(args)?.action === "create";
}

export function isReceiptOwningDirectedQuestionCreate(
	toolName: string,
	result: unknown,
	isError: boolean,
): boolean {
	return toolName === "manage_directed_question" && !isError &&
		(record(result)?.terminate === true) && directedQuestionTranscriptReceiptId(result) !== null;
}

/**
 * One LLM tool batch at a time. A receipt may temporarily defer the 1s trail
 * timer while sibling results are outstanding. Any non-receipt/failed sibling
 * immediately resumes ordinary projection with the accumulated trail intact.
 */
export class TrailPostFence {
	private pending = new Set<Promise<void>>();
	private valid = true;

	private adopt(observed: Promise<void>): void {
		if (!this.valid || this.pending.has(observed)) return;
		this.pending.add(observed);
		void observed.then(() => this.pending.delete(observed));
	}

	track<T>(post: Promise<T>): Promise<T> {
		// The observer handles rejection even when the caller intentionally fires
		// and forgets. `drain` therefore never creates an unhandled rejection.
		const observed = Promise.resolve(post).then(
			() => undefined,
			() => undefined,
		);
		this.adopt(observed);
		return post;
	}

	async drain(): Promise<void> {
		// Candidate marking stops future timer posts first. Looping also covers a
		// projection synchronously tracked by the same turn just before the mark.
		while (this.pending.size > 0) {
			await Promise.all([...this.pending]);
		}
	}

	invalidate(): void {
		this.valid = false;
	}

	/**
	 * Hand authority to a fresh fence without abandoning predecessor posts.
	 * Directly adopting the normalized in-flight promises is the flattened form
	 * of tracking `oldFence.drain()`: repeated rollovers remain O(in-flight), not
	 * an ever-growing promise chain, and each settled promise removes itself.
	 */
	rollover(): TrailPostFence {
		this.invalidate();
		const replacement = new TrailPostFence();
		for (const observed of this.pending) replacement.adopt(observed);
		return replacement;
	}

	get size(): number {
		return this.pending.size;
	}
}

export class DirectedQuestionReceiptBatch {
	private revision = 0;
	private pending = new Set<string>();
	private receiptCandidates = new Set<string>();
	private nonReceiptStarted = false;
	private resultCount = 0;
	private receiptSeen = false;
	private allResultsAreReceipts = true;
	private substantiveAfterReceipt = false;

	reset(revision: number): void {
		this.revision = revision;
		this.pending.clear();
		this.receiptCandidates.clear();
		this.nonReceiptStarted = false;
		this.resultCount = 0;
		this.receiptSeen = false;
		this.allResultsAreReceipts = true;
		this.substantiveAfterReceipt = false;
	}

	start(toolCallId: string, revision: number, potentialReceipt = false): void {
		if (revision !== this.revision) this.reset(revision);
		this.pending.add(toolCallId);
		if (potentialReceipt) this.receiptCandidates.add(toolCallId);
		else this.nonReceiptStarted = true;
	}

	finish(toolCallId: string, outcome: ReceiptToolResult, revision: number): void {
		if (revision !== this.revision || !this.pending.has(toolCallId)) return;
		this.pending.delete(toolCallId);
		this.receiptCandidates.delete(toolCallId);
		this.resultCount += 1;
		this.receiptSeen ||= outcome.success && outcome.terminatingReceipt;
		this.allResultsAreReceipts &&= outcome.success && outcome.terminatingReceipt;
	}

	noteAssistantText(text: string, revision: number): void {
		if (revision !== this.revision || !this.receiptSeen) return;
		if (text.trim().length > 0) this.substantiveAfterReceipt = true;
	}

	/** Stop the timer from opening a second bubble during a receipt-owned batch. */
	deferTrail(revision: number): boolean {
		if (revision !== this.revision || this.substantiveAfterReceipt) return false;
		// Potential create is marked synchronously at tool_execution_start, before
		// its awaited pre-invocation fence. No timer post may overtake takeover.
		if (this.receiptCandidates.size > 0) return true;
		return this.receiptSeen && this.allResultsAreReceipts && !this.nonReceiptStarted;
	}

	/** Suppress only the empty fallback after every sibling result is known. */
	suppressEmptyFallback(revision: number): boolean {
		return this.deferTrail(revision) && this.pending.size === 0 && this.resultCount > 0;
	}
}
