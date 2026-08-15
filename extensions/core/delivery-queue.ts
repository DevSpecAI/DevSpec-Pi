/** Ordered, non-blocking dispatch preparation outside the remote pump loop. */
export class DeliveryQueue {
	private tail: Promise<void> = Promise.resolve();
	private seen = new Set<string>();

	/** Returns immediately; tasks execute serially in delivery order. */
	enqueue(key: string, task: () => Promise<void>, onError: (error: unknown) => void): boolean {
		if (!key || this.seen.has(key)) return false;
		this.seen.add(key);
		this.tail = this.tail
			.then(task)
			.catch((error) => {
				// Live assignment inboxes may offer the same work again after a
				// transient contract/hydration/send failure.
				this.seen.delete(key);
				onError(error);
			});
		return true;
	}

	/** Test/shutdown observation only; the pump never awaits contract work. */
	idle(): Promise<void> {
		return this.tail;
	}
}
