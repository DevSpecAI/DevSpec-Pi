export function nextDeliveryRetryDelayMs(
	failureCount: number,
	baseMs = 5_000,
	maxMs = 60_000,
): number {
	const exponent = Math.max(0, Math.floor(failureCount) - 1);
	return Math.min(baseMs * 2 ** exponent, maxMs);
}

/** Pump- and automation-run-scoped authority lease for one asynchronous delivery. */
export interface DeliveryLease {
	readonly generation: number;
	readonly keyGeneration: number;
	isCurrent(): boolean;
	assertCurrent(): void;
}

export class StaleDeliveryError extends Error {
	constructor() {
		super("delivery authority expired before preparation completed");
		this.name = "StaleDeliveryError";
	}
}

/** Ordered, non-blocking automation delivery outside the remote pump loop. */
export class DeliveryQueue {
	private tail: Promise<void> = Promise.resolve();
	private seen = new Set<string>();
	private generation = 1;
	private keyGenerations = new Map<string, number>();
	private active = true;

	private keyGeneration(key: string): number {
		return this.keyGenerations.get(key) ?? 1;
	}

	/** Returns immediately; tasks execute serially in delivery order. */
	enqueue(key: string, task: (lease: DeliveryLease) => Promise<void>, onError: (error: unknown) => void): boolean {
		if (!this.active || !key || this.seen.has(key)) return false;
		this.seen.add(key);
		const generation = this.generation;
		const keyGeneration = this.keyGeneration(key);
		const isCurrent = () =>
			this.active &&
			this.generation === generation &&
			this.keyGeneration(key) === keyGeneration;
		const lease: DeliveryLease = {
			generation,
			keyGeneration,
			isCurrent,
			assertCurrent: () => {
				if (!isCurrent()) throw new StaleDeliveryError();
			},
		};
		this.tail = this.tail
			.then(() => {
				lease.assertCurrent();
				return task(lease);
			})
			.catch((error) => {
				// A stopped/replaced bond owns neither warnings nor retries. The new
				// pump has a new queue and receives any still-live delivery itself.
				if (!lease.isCurrent() || error instanceof StaleDeliveryError) return;
				// A live inbox may offer the same automation run again after a transient
				// send failure. Task work never enters this queue.
				this.seen.delete(key);
				onError(error);
			});
		return true;
	}

	/** Revoke in-flight and queued delivery for one automation-run identity only. */
	invalidateKey(key: string): void {
		if (!this.active || !key) return;
		this.keyGenerations.set(key, this.keyGeneration(key) + 1);
		this.seen.delete(key);
	}

	/** Revoke every in-flight and queued delivery owned by this pump generation. */
	invalidate(): void {
		if (!this.active) return;
		this.active = false;
		this.generation += 1;
		this.seen.clear();
		this.keyGenerations.clear();
	}

	/** Test/shutdown observation only; the pump never awaits this queue. */
	idle(): Promise<void> {
		return this.tail;
	}
}
