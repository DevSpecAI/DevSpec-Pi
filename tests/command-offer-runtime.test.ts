import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
import { join } from 'node:path';
import { CommandPreemptionBudget, commandOfferAction, parseCommandOfferPoll } from '../extensions/core/command-offer.ts';
import { exactInteractionContinuationArgs } from '../extensions/core/interaction-events.ts';
import { backgroundScopeKey } from '../extensions/core/background-journal.ts';
import { createAttachmentHydrationBudget, requireMaterialisedAttachments, formatAttachmentNotes } from '../extensions/core/attachments.ts';

const source = readFileSync(new URL('../extensions/devspec-remote.ts', import.meta.url), 'utf8');
const from = source.indexOf('\ttype PendingOffer =');
const to = source.indexOf('\tconst completeObservedIdle', from);
assert(from > 0 && to > from);
const code = stripTypeScriptTypes(`(() => { ${source.slice(from, to)} return { receive: pi_receiveCommandOffer, ready: pi_commandHandoffReady,
 take: pi_takePreparedOfferAttachments, received: pi_offerCanonicalReceived, clear: clearOffer, bind: (scope, entries) => offerBudget.bind(scope, entries) }; })()`, { mode: 'transform' });
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { nativeSessionId: id(1), connectionId: id(2), sessionId: id(3), attachmentId: id(4) };
const offer = { version: 1, connection_id: scope.connectionId, source_session_id: scope.sessionId, attachment_id: scope.attachmentId,
 source_message_id: id(5), blocking_attempt_id: id(6), attachments: [] as any[] };
const wire = (value = offer) => ({ command_offer_version: 1, command_handoff_stale: false, command_offer: value });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness() {
 const active = { stop: false, runtimeOccupancy: { isBusy: () => !state.idle } };
 const run = { active, application: 'applied', identity: { attemptId: id(6), eventId: id(7), responseId: id(8), claimToken: id(9) }, authority: {} };
 const state = { idle: false, pending: false, abortSettles: true, aborts: 0, acks: 0, wakes: 0, downloads: 0, entries: [] as any[], cleanup: [] as any[], warnings: [] as string[] };
 const ctx = { isIdle: () => state.idle, hasPendingMessages: () => state.pending };
 const sandbox: any = { CommandPreemptionBudget, commandOfferAction, parseCommandOfferPoll, exactInteractionContinuationArgs,
   createAttachmentHydrationBudget, requireMaterialisedAttachments, formatAttachmentNotes, join,
   currentBackgroundScope: () => sandbox.scope, scope: { ...scope }, pump: active, foregroundEpoch: 1, preemptOwnerCached: true, pendingBackgroundTaskIds: new Set(),
   activeInteractionRun: () => sandbox.currentRun, currentRun: run, parkedBackground: null, settledInteractionForOffer: null, backgroundScopeKey,
   interactionAuthorityCurrent: () => true, resolveToken: async () => ({ token: 'test-only' }),
   materialiseAttachments: async () => { state.downloads++; return sandbox.materialised; }, materialised: [],
   cleanupMaterialisedAttachments: async (files: unknown) => { state.cleanup.push(files); },
   attachmentDirFor: () => '/test-private', randomUUID: () => id(50), defaultFetchUrl: async () => new Uint8Array(),
   callDevspec: async () => ({}), StaleCommandHandoffError: Error,
   acknowledgeInteractionApplication: async () => { state.acks++; return true; },
   pi: { appendEntry: (customType: string, data: unknown) => state.entries.push({ type: 'custom', customType, data }) },
   pi_abort: () => { state.aborts++; if (state.abortSettles) state.idle = true; },
   waitUntil: async (predicate: () => boolean) => predicate(), signalWake: () => { state.wakes++; },
   debug() {}, notify: (_ctx: unknown, message: string) => state.warnings.push(message),
   pi_offerAlreadyAborted: null, pi_offerCanonicalReceived: null, pi_commandHandoffReady: null, pi_takePreparedOfferAttachments: null, pi_receiveCommandOffer: null,
 };
 const api = vm.runInNewContext(code, sandbox); api.bind(sandbox.scope, []);
 return { api, sandbox, active, run, state, ctx };
}
test('production controller validates then aborts once, ACKs and prepares exact readiness without model input', async () => {
 const h = harness(); await h.api.receive(wire(), h.active, h.ctx, []);
 assert.equal(h.state.aborts, 1); assert.equal(h.state.acks, 1); assert.equal(h.state.wakes, 1);
 assert.deepEqual(JSON.parse(JSON.stringify(h.api.ready(h.active, h.ctx))), { source_message_id: id(5), attachment_id: id(4), ...exactInteractionContinuationArgs(h.run.identity) });
 await h.api.receive(wire(), h.active, h.ctx, []); assert.equal(h.state.aborts, 1);
 assert.equal(h.state.entries.length, 1);
 assert.equal(JSON.stringify(h.state.entries).includes('claimToken'), false);
});
test('canonical receipt bookkeeping failure cannot replay or reject an accepted send', async () => {
 const h = harness(); await h.api.receive(wire(), h.active, h.ctx, []);
 h.sandbox.pi.appendEntry = () => { throw new Error('disk unavailable'); };
 assert.doesNotThrow(() => h.api.received([{ id: id(5) }]));
 assert.equal(h.sandbox.pi_offerAlreadyAborted(id(5)), true, 'failed retirement stays conservatively fenced');
});
test('a stale handoff drops only readiness and immediately requests a fresh poll', async () => {
 const h = harness(); await h.api.receive(wire(), h.active, h.ctx, []);
 const before = h.state.wakes;
 await h.api.receive({ command_offer_version: 1, command_handoff_stale: true, command_offer: null }, h.active, h.ctx, []);
 assert.equal(h.api.ready(h.active, h.ctx), null); assert.equal(h.state.wakes, before + 1);
 assert.equal(h.state.aborts, 1); assert.equal(h.state.entries.length, 1);
});
test('preempt-off leaves healthy quiet work alone and becomes ready only at actual idle', async () => {
 const h = harness(); h.sandbox.preemptOwnerCached = false;
 for (let lap = 0; lap < 5; lap++) await h.api.receive(wire(), h.active, h.ctx, []);
 assert.equal(h.state.aborts, 0); assert.equal(h.state.acks, 0); assert.equal(h.api.ready(h.active, h.ctx), null);
 h.state.idle = true; await h.api.receive(wire(), h.active, h.ctx, []);
 assert(h.api.ready(h.active, h.ctx)); assert.equal(h.state.aborts, 0);
});
test('a nonsettling abort neither repeats nor reports readiness/recovery', async () => {
 const h = harness(); h.state.abortSettles = false;
 await h.api.receive(wire(), h.active, h.ctx, []); await h.api.receive(wire(), h.active, h.ctx, []);
 assert.equal(h.state.aborts, 1); assert.equal(h.state.acks, 0); assert.equal(h.api.ready(h.active, h.ctx), null);
 h.state.idle = true; await h.api.receive(wire(), h.active, h.ctx, []); assert(h.api.ready(h.active, h.ctx));
});
test('attachment failure happens before any interruption', async () => {
 const h = harness(); h.sandbox.materialised = [{ delivery: 'unavailable', filename: 'x', note: 'unavailable' }];
 const attached = { ...offer, attachments: [{ materialization: 'metadata', filename: 'x', mime_type: 'text/plain', type: 'document', size_bytes: 1, resource_id: id(10) }] };
 await h.api.receive(wire(attached), h.active, h.ctx, []);
 assert.equal(h.state.downloads, 1); assert.equal(h.state.aborts, 0); assert.equal(h.state.acks, 0);
 assert.equal(h.state.warnings.length, 1); assert.equal(h.api.ready(h.active, h.ctx), null);
});
test('newer native work arriving during ACK prevents the old ready request', async () => {
 const h = harness(); const gate = deferred<boolean>(); h.sandbox.acknowledgeInteractionApplication = () => gate.promise;
 const receiving = h.api.receive(wire(), h.active, h.ctx, []);
 await new Promise(resolve => setImmediate(resolve));
 h.sandbox.foregroundEpoch++; h.state.idle = false; h.sandbox.currentRun = null;
 gate.resolve(true); await receiving;
 assert.equal(h.api.ready(h.active, h.ctx), null); assert.equal(h.state.wakes, 0);
});
test('parked background ownership may hand off only at native foreground idle', async () => {
 const h = harness(); h.sandbox.currentRun = null; h.state.idle = true;
 h.sandbox.parkedBackground = { active: h.active, settled: { interaction: h.run } };
 await h.api.receive(wire(), h.active, h.ctx, []);
 assert.equal(h.state.aborts, 0); assert(h.api.ready(h.active, h.ctx));
 h.state.pending = true; assert.equal(h.api.ready(h.active, h.ctx), null);
});
test('a captured just-settled question remains a receipt, never a busy foreground owner', async () => {
 const h = harness(); h.sandbox.currentRun = null;
 h.sandbox.settledInteractionForOffer = { run: h.run, epoch: 1, scope: backgroundScopeKey(scope) };
 await h.api.receive(wire(), h.active, h.ctx, []); assert.equal(h.state.aborts, 0); assert.equal(h.api.ready(h.active, h.ctx), null);
 h.state.idle = true; await h.api.receive(wire(), h.active, h.ctx, []); assert(h.api.ready(h.active, h.ctx));
 h.sandbox.foregroundEpoch++; assert.equal(h.api.ready(h.active, h.ctx), null);
});
test('unknown or different question identity cannot interrupt genuine newer work', async () => {
 const h = harness(); h.run.identity.attemptId = id(30);
 await h.api.receive(wire(), h.active, h.ctx, []);
 assert.equal(h.state.aborts, 0); assert.equal(h.state.acks, 0); assert.equal(h.api.ready(h.active, h.ctx), null);
});
test('late preparation cleanup cannot erase a newer attachment handoff', async () => {
 const h = harness(); const gate = deferred<any[]>();
 h.sandbox.materialiseAttachments = () => gate.promise;
 const attached = { ...offer, attachments: [{ materialization: 'metadata', filename: 'old', mime_type: 'text/plain', type: 'document', size_bytes: 1, resource_id: id(10) }] };
 const old = h.api.receive(wire(attached), h.active, h.ctx, []);
 await new Promise(resolve => setImmediate(resolve));
 const cleaning = h.api.clear();
 h.sandbox.scope = { ...scope, attachmentId: id(20) }; h.sandbox.foregroundEpoch++; h.state.idle = true;
 h.sandbox.currentRun = { ...h.run, identity: { ...h.run.identity, attemptId: id(21) } };
 h.api.bind(h.sandbox.scope, []);
 const newer = { ...offer, attachment_id: id(20), source_message_id: id(25), blocking_attempt_id: id(21) };
 await h.api.receive(wire(newer), h.active, h.ctx, []);
 const files = [{ delivery: 'file', filename: 'old', mimeType: 'text/plain', type: 'document', sizeBytes: 1, path: '/test-private/offers/old', note: 'old file' }];
 gate.resolve(files); await old; await cleaning;
 assert.equal(h.api.ready(h.active, h.ctx).source_message_id, id(25));
 assert.equal(h.state.aborts, 0); assert.equal(h.state.cleanup.at(-1), files);
});
test('prepared files transfer to canonical hydration only on an identical manifest', async () => {
 const h = harness(); const files = [{ delivery: 'file', filename: 'x', mimeType: 'text/plain', type: 'document', sizeBytes: 1, path: '/test-private/offers/one', note: 'file' }];
 h.sandbox.materialised = files;
 const attached = { ...offer, attachments: [{ materialization: 'metadata', filename: 'x', mime_type: 'text/plain', type: 'document', size_bytes: 1, resource_id: id(10) }] };
 await h.api.receive(wire(attached), h.active, h.ctx, []);
 const prepared = await h.api.take([{ id: id(5), attachments: attached.attachments }]);
 assert.equal(prepared.materialised, files); assert.equal(h.state.downloads, 1); assert.equal(h.api.ready(h.active, h.ctx), null);
});
