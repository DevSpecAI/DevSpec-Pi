import type { ModelCatalogSnapshot } from './model-catalog.ts';

export const CONTROL_RESULT_ENTRY = 'devspec-control-result-v1';
export type ControlResult = { status: 'completed' } | { status: 'failed'; error: 'model_catalog_unavailable' | 'control_failed' };
export interface ProducedControlResult {
  connectionId: string;
  controlId: string;
  result: ControlResult;
  catalog?: ModelCatalogSnapshot;
  collectionMs?: number;
}
export type ControlResultEntry =
  | { phase: 'produced'; value: ProducedControlResult }
  | { phase: 'acknowledged' | 'superseded'; connectionId: string; controlId: string };
export type ControlDeliveryOutcome = 'acknowledged' | 'superseded';
type Persist = (value: ControlResultEntry) => void;

/** Session-journal-backed results: retry delivery, not execution (33d1e0a1). */
export class ControlResultOutbox {
  private pending = new Map<string, ProducedControlResult>();
  private handled = new Set<string>();
  private sending = false;

  private key(connectionId: string, controlId: string): string { return JSON.stringify([connectionId, controlId]); }
  has(connectionId: string, controlId: string): boolean { return this.handled.has(this.key(connectionId, controlId)); }
  hasPending(connectionId: string): boolean { return [...this.pending.values()].some(value => value.connectionId === connectionId); }

  produce(value: ProducedControlResult, persist: Persist): void {
    const key = this.key(value.connectionId, value.controlId);
    if (this.handled.has(key)) return;
    // Retain in memory even when persistence throws; never execute twice in this runtime.
    this.pending.set(key, value);
    this.handled.add(key);
    persist({ phase: 'produced', value });
  }

  static reconstruct(entries: readonly unknown[]): ControlResultOutbox {
    const outbox = new ControlResultOutbox();
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry.type !== 'custom' || entry.customType !== CONTROL_RESULT_ENTRY) continue;
      const data = entry.data as ControlResultEntry | undefined;
      if (!data || typeof data !== 'object') throw new Error('Invalid persisted CONTROL result');
      if (data.phase === 'produced') {
        const value = data.value;
        if (!value || typeof value.connectionId !== 'string' || !value.connectionId || typeof value.controlId !== 'string' || !value.controlId ||
          !value.result || (value.result.status !== 'completed' && !(value.result.status === 'failed' &&
            (value.result.error === 'model_catalog_unavailable' || value.result.error === 'control_failed')))) {
          throw new Error('Invalid persisted CONTROL result');
        }
        const key = outbox.key(value.connectionId, value.controlId);
        if (!outbox.handled.has(key)) outbox.pending.set(key, value);
        outbox.handled.add(key);
      } else if ((data.phase === 'acknowledged' || data.phase === 'superseded') && typeof data.connectionId === 'string' && typeof data.controlId === 'string') {
        const key = outbox.key(data.connectionId, data.controlId);
        outbox.pending.delete(key);
        outbox.handled.add(key);
      } else throw new Error('Invalid persisted CONTROL result');
    }
    return outbox;
  }

  async drain(connectionId: string, send: (value: ProducedControlResult) => Promise<ControlDeliveryOutcome>, persist: Persist,
    current: () => boolean = () => true): Promise<void> {
    if (this.sending || !current()) return;
    this.sending = true;
    try {
      for (const [key, value] of this.pending) {
        if (value.connectionId !== connectionId || !current()) continue;
        const outcome = await send(value);
        if (!current()) return;
        // Persist first. A crash or append failure retries result delivery only.
        // A stale slot is superseded, not evidence this reply stored our result.
        persist({ phase: outcome, connectionId, controlId: value.controlId });
        this.pending.delete(key);
      }
    } finally { this.sending = false; }
  }
}
