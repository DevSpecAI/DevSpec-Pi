/**
 * Mechanical binding between a poll-delivered owner command and the exact Pi
 * user message that starts its model turn.
 *
 * Pi's sendUserMessage API does not accept opaque metadata, so the adapter
 * retains immutable server identity out-of-band until Pi emits the exact user
 * message back through message_start. Matching the complete text (not a preview
 * or content hash) keeps repeated owner messages as separate segments.
 *
 * Lifetime (item 6f4136d8): a binding is valid from remember() until its
 * message_start take(). Anything still pending after its command closes is a
 * stray that a later terminal input with identical text must never inherit.
 * Callers drop those via forgetByCommand() on completion and clear() on every
 * authority rotation (stop, revive/replacement, attach change).
 */
export interface CanonicalQueueItem {
	hiddenContent: string;
	details: unknown;
}

export interface CommandTurnBinding {
	turnId: string;
	commandMessageId: string;
	canonicalQueueItem?: CanonicalQueueItem;
}

export class CommandTurnBindings {
	private pending: Array<{ message: string; binding: CommandTurnBinding }> = [];

	remember(
		message: string,
		turnId: string | undefined,
		commandMessageId: string | undefined,
		canonicalQueueItem?: CanonicalQueueItem,
	): void {
		if (!turnId || !commandMessageId) return;
		this.pending.push({ message, binding: { turnId, commandMessageId, ...(canonicalQueueItem ? { canonicalQueueItem } : {}) } });
		if (this.pending.length > 128) this.pending.shift();
	}

	peek(message: string): CommandTurnBinding | undefined {
		return this.pending.find((entry) => entry.message === message)?.binding;
	}

	take(message: string): CommandTurnBinding | undefined {
		const index = this.pending.findIndex((entry) => entry.message === message);
		if (index === -1) return undefined;
		const [entry] = this.pending.splice(index, 1);
		return entry?.binding;
	}

	forget(message: string, turnId: string | undefined, commandMessageId: string | undefined): void {
		if (!turnId || !commandMessageId) return;
		const index = this.pending.findIndex((entry) =>
			entry.message === message &&
			entry.binding.turnId === turnId &&
			entry.binding.commandMessageId === commandMessageId
		);
		if (index !== -1) this.pending.splice(index, 1);
	}

	forgetByCommand(turnId: string | undefined, commandMessageId: string | undefined): void {
		if (!turnId) return;
		this.pending = this.pending.filter((entry) =>
			entry.binding.turnId !== turnId ||
			(commandMessageId !== undefined && entry.binding.commandMessageId !== commandMessageId)
		);
	}

	clear(): void {
		this.pending = [];
	}
}
