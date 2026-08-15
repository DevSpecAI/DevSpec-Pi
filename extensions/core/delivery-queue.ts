export function nextDeliveryRetryDelayMs(
	failureCount: number,
	baseMs = 5_000,
	maxMs = 60_000,
): number {
	const exponent = Math.max(0, Math.floor(failureCount) - 1);
	return Math.min(baseMs * 2 ** exponent, maxMs);
}

/** A pump-scoped authority lease for one asynchronously prepared delivery. */
export interface DeliveryLease {
	readonly generation: number;
	isCurrent(): boolean;
	assertCurrent(): void;
}

export class StaleDeliveryError extends Error {
	constructor() {
		super("delivery authority expired before preparation completed");
		this.name = "StaleDeliveryError";
	}
}

/** Ordered, non-blocking dispatch preparation outside the remote pump loop. */
export class DeliveryQueue {
	private tail: Promise<void> = Promise.resolve();
	private seen = new Set<string>();
	private generation = 1;
	private active = true;

	/** Returns immediately; tasks execute serially in delivery order. */
	enqueue(key: string, task: (lease: DeliveryLease) => Promise<void>, onError: (error: unknown) => void): boolean {
		if (!this.active || !key || this.seen.has(key)) return false;
		this.seen.add(key);
		const generation = this.generation;
		const lease: DeliveryLease = {
			generation,
			isCurrent: () => this.active && this.generation === generation,
			assertCurrent: () => {
				if (!this.active || this.generation !== generation) throw new StaleDeliveryError();
			},
		};
		this.tail = this.tail
			.then(() => {
				lease.assertCurrent();
				return task(lease);
			})
			.catch((error) => {
				// A stopped/replaced bond owns neither warnings nor retries. The new
				// pump has a new queue and receives any still-live assignment itself.
				if (!lease.isCurrent() || error instanceof StaleDeliveryError) return;
				// Live assignment inboxes may offer the same work again after a
				// transient contract/hydration/send failure.
				this.seen.delete(key);
				onError(error);
			});
		return true;
	}

	/** Revoke every in-flight and queued delivery owned by this pump generation. */
	invalidate(): void {
		if (!this.active) return;
		this.active = false;
		this.generation += 1;
		this.seen.clear();
	}

	/** Test/shutdown observation only; the pump never awaits contract work. */
	idle(): Promise<void> {
		return this.tail;
	}
}
