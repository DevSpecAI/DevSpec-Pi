import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTROL_RESULT_ENTRY, ControlResultOutbox, type ControlResultEntry } from '../extensions/core/control-result-outbox.ts';

const value = { connectionId: 'connection', controlId: 'control', result: { status: 'completed' as const },
  catalog: { v: 1 as const, current: null, models: [{ provider: 'p', id: 'model' }], at: '2026-10-08T12:00:00Z' } };
const entries = (journal: ControlResultEntry[]) => journal.map(data => ({ type: 'custom', customType: CONTROL_RESULT_ENTRY, data }));

test('failed storage delivery retains the produced result without executing again', async () => {
  const journal: ControlResultEntry[] = [];
  const outbox = new ControlResultOutbox();
  outbox.produce(value, entry => journal.push(entry));
  await assert.rejects(outbox.drain('connection', async () => { throw new Error('offline'); }, entry => journal.push(entry)));
  assert.equal(outbox.hasPending('connection'), true);
  assert.equal(outbox.has('connection', 'control'), true);
  outbox.produce(value, entry => journal.push(entry));
  assert.equal(journal.length, 1);
  const restored = ControlResultOutbox.reconstruct(entries(journal));
  let sent = 0;
  await restored.drain('connection', async result => { assert.deepEqual(result, value); sent++; return 'acknowledged'; }, entry => journal.push(entry));
  assert.equal(sent, 1);
  assert.equal(restored.hasPending('connection'), false);
  assert.equal(restored.has('connection', 'control'), true);
  assert.equal(ControlResultOutbox.reconstruct(entries(journal)).hasPending('connection'), false);
});

test('failed journal commit after server receipt retries acknowledgement only', async () => {
  const outbox = new ControlResultOutbox();
  outbox.produce(value, () => {});
  let sends = 0;
  await assert.rejects(outbox.drain('connection', async () => { sends++; return 'acknowledged'; }, () => { throw new Error('disk unavailable'); }));
  assert.equal(outbox.hasPending('connection'), true);
  await outbox.drain('connection', async () => { sends++; return 'acknowledged'; }, () => {});
  assert.equal(sends, 2);
  assert.equal(outbox.hasPending('connection'), false);
});

test('a result never travels to another connection or a replaced generation', async () => {
  const outbox = new ControlResultOutbox();
  outbox.produce(value, () => {});
  let sent = 0, persisted = 0;
  await outbox.drain('other', async () => { sent++; return 'acknowledged'; }, () => { persisted++; });
  await outbox.drain('connection', async () => { sent++; return 'acknowledged'; }, () => { persisted++; }, () => false);
  assert.equal(sent, 0);
  let current = true;
  await outbox.drain('connection', async () => { sent++; current = false; return 'acknowledged'; }, () => { persisted++; }, () => current);
  assert.equal(persisted, 0);
  assert.equal(outbox.hasPending('connection'), true);
});

test('overlapping drains do not send the same result concurrently', async () => {
  const outbox = new ControlResultOutbox();
  outbox.produce(value, () => {});
  let finish!: () => void;
  let sent = 0;
  const first = outbox.drain('connection', async () => { sent++; await new Promise<void>(resolve => { finish = resolve; }); return 'acknowledged'; }, () => {});
  await outbox.drain('connection', async () => { sent++; return 'acknowledged'; }, () => {});
  assert.equal(sent, 1);
  finish(); await first;
});

test('a superseded result is not journalled as successfully stored', async () => {
  const journal: ControlResultEntry[] = [];
  const outbox = new ControlResultOutbox();
  outbox.produce(value, entry => journal.push(entry));
  await outbox.drain('connection', async () => 'superseded', entry => journal.push(entry));
  assert.equal(journal.at(-1)?.phase, 'superseded');
  const restored = ControlResultOutbox.reconstruct(entries(journal));
  assert.equal(restored.hasPending('connection'), false);
  assert.equal(restored.has('connection', 'control'), true);
});

test('explicit failure results are journalled and delivered without a fake catalogue', async () => {
  const outbox = new ControlResultOutbox();
  const failed = { connectionId: 'connection', controlId: 'failed', result: { status: 'failed' as const, error: 'model_catalog_unavailable' as const } };
  outbox.produce(failed, () => {});
  await outbox.drain('connection', async result => { assert.deepEqual(result, failed); return 'acknowledged'; }, () => {});
  assert.equal(outbox.has('connection', 'failed'), true);
});
