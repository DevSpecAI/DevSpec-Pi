import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandPreemptionBudget, COMMAND_PREEMPT_ENTRY, commandOfferAction, parseCommandOfferPoll } from '../extensions/core/command-offer.ts';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { nativeSessionId: id(1), connectionId: id(2), sessionId: id(3), attachmentId: id(4) };
const offer = { version: 1, connection_id: scope.connectionId, source_session_id: scope.sessionId, attachment_id: scope.attachmentId,
	source_message_id: id(5), blocking_attempt_id: id(6), attachments: [] };
const payload = { command_offer_version: 1, command_handoff_stale: false, command_offer: offer };

test('offers are exact-scoped availability, never text or executable provenance', () => {
	assert.deepEqual(parseCommandOfferPoll(payload, scope), { supported: true, stale: false, offer });
	for (const extra of [{ content: 'do this' }, { provenance_ref: id(8) }, { turn_id: id(9) }]) {
		assert.throws(() => parseCommandOfferPoll({ ...payload, command_offer: { ...offer, ...extra } }, scope));
	}
	assert.throws(() => parseCommandOfferPoll(payload, { ...scope, attachmentId: id(20) }));
	assert.throws(() => parseCommandOfferPoll(payload, { ...scope, connectionId: id(20) }));
	assert.throws(() => parseCommandOfferPoll({ ...payload, command_offer_version: 2 }, scope));
	assert.deepEqual(parseCommandOfferPoll({}, scope), { supported: false, stale: false, offer: null });
});
test('attachment limits and declared metadata are checked before preemption', () => {
	const attachment = { materialization: 'metadata', filename: 'example.txt', mime_type: 'text/plain', type: 'document', size_bytes: 1, resource_id: id(7) };
	assert.equal(parseCommandOfferPoll({ ...payload, command_offer: { ...offer, attachments: [attachment] } }, scope).offer?.attachments.length, 1);
	assert.throws(() => parseCommandOfferPoll({ ...payload, command_offer: { ...offer, attachments: [{ ...attachment, download_url: 'https://untrusted.invalid' }] } }, scope));
	assert.throws(() => parseCommandOfferPoll({ ...payload, command_offer: { ...offer, attachments: Array(100).fill(attachment) } }, scope));
});
const state = { current: true, exactInteractionApplied: true, foregroundIdle: false, hasPendingMessages: false, preemptEnabled: true, abortAlreadyRequested: false };
test('only current applied identity can preempt; quiet time is not a control input', () => {
	assert.equal(commandOfferAction(state), 'abort');
	assert.equal(commandOfferAction({ ...state, preemptEnabled: false }), 'wait');
	assert.equal(commandOfferAction({ ...state, abortAlreadyRequested: true }), 'wait');
	assert.equal(commandOfferAction({ ...state, current: false }), 'ignore');
	assert.equal(commandOfferAction({ ...state, exactInteractionApplied: false }), 'ignore');
	assert.equal(commandOfferAction({ ...state, foregroundIdle: true }), 'ready');
	assert.equal(commandOfferAction({ ...state, foregroundIdle: true, hasPendingMessages: true }), 'wait');
});
test('cancellation budget persists before abort and restores only the exact scope', () => {
	const budget = new CommandPreemptionBudget();
	budget.bind(scope, []);
	const entries: unknown[] = [];
	const append = (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data });
	assert.equal(budget.request(id(5), scope, append), true);
	assert.equal(budget.request(id(5), scope, append), false);
	assert.equal(entries.length, 1);
	assert.equal((entries[0] as any).customType, COMMAND_PREEMPT_ENTRY);
	const restored = new CommandPreemptionBudget(); restored.bind(scope, entries);
	assert.equal(restored.has(id(5)), true);
	restored.bind({ ...scope, attachmentId: id(20) }, entries);
	assert.equal(restored.has(id(5)), false);
});
test('canonical receipts retire budget entries and normal long sessions do not exhaust it', () => {
 const budget = new CommandPreemptionBudget(); budget.bind(scope, []);
 const entries: unknown[] = [];
 const append = (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data });
 for (let n = 100; n < 1200; n++) {
  assert.equal(budget.request(id(n), scope, append), true);
  assert.equal(budget.received(id(n), scope, append), true);
  assert.equal(budget.has(id(n)), false);
 }
 const restored = new CommandPreemptionBudget(); restored.bind(scope, entries);
 assert.equal(restored.has(id(100)), false);
 assert.equal(restored.request(id(1300), scope, append), true);
});
test('failed persistence grants no abort budget receipt', () => {
	const budget = new CommandPreemptionBudget(); budget.bind(scope, []);
	assert.throws(() => budget.request(id(5), scope, () => { throw new Error('disk unavailable'); }));
	assert.equal(budget.has(id(5)), false);
});
