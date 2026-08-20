import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");

function bodyBetween(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing source range ${start}..${end}`);
	return source.slice(from, to);
}

test("every Pi poll negotiates v1 and only top-level cursor_v2 drives live progress", () => {
	const calls = [...source.matchAll(/callDevspec\([^]*?"poll_connection"[^]*?\{([^]*?)\}, \{/gu)];
	assert.equal(calls.length, 2, "expected control ack and pump poll only");
	for (const call of calls) assert.match(call[1], /ingress_version: 1/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /cursor_v2: active\.cursor/);
	assert.match(pump, /if \(!commandDeliveryFailed\)[^]*active\.cursor = pkg\.cursorV2/);
	assert.doesNotMatch(pump, /active\.cursor\s*=\s*[^;]*next_cursor|\bcursor: active\.cursor/);
});

test("canonical parser output stays independent from playbook dispatch and control paths", () => {
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /parsePollPayload\(payload, active\.bond\.connectionId\)/);
	assert.match(pump, /pkg\.ownerBundle/);
	assert.match(pump, /pkg\.control/);
	assert.match(pump, /for \(const dispatch of dispatches\) enqueuePlaybookRun/);
	assert.doesNotMatch(pump, /payload[^\n]*commands|buildRoomDigest|owner_ambient|room_context/);
});

test("multi-command hydration, send, seen state, and rollback are envelope-atomic", () => {
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	assert.match(delivery, /reserveBundle\(pkg\.ownerBundle\.commands\)/);
	assert.match(delivery, /await hydrateOwnerBundle\(pkg\.ownerBundle/);
	assert.equal((delivery.match(/\bpi_send\(/g) ?? []).length, 1, "one send site for the whole envelope");
	assert.doesNotMatch(delivery, /for \(const cmd|takeUnseen/);
	assert.match(delivery, /pi_send\([^;]+;\s*attachmentLease\.accept\(\);[^]*commitBundle\(hydrated\.commands\)/);
	assert.match(delivery, /catch \(err\)[^]*attachmentLease\?\.cleanupIfPending\(\)[^]*releaseBundle\(pkg\.ownerBundle\.commands\)/);
	assert.match(delivery, /attachmentRetryAttempts[^]*nextDeliveryRetryDelayMs[^]*commandRetryDelayMs/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /if \(commandRetryDelayMs > 0[^]*await new Promise[^]*setTimeout\(resolve, commandRetryDelayMs\)[^]*signalWake\(active\)/);
	assert.doesNotMatch(delivery, /reportComplete\("delivery_failed"/);
});

test("attachment failure precedes preemption and no host prose mutates the canonical prompt", () => {
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	const hydrated = delivery.indexOf("await hydrateOwnerBundle");
	const decide = delivery.indexOf("decideOwnerDelivery");
	const abort = delivery.indexOf("pi_abort()");
	const send = delivery.indexOf("pi_send(");
	assert.ok(hydrated >= 0 && hydrated < decide && decide < abort && abort < send);
	assert.doesNotMatch(delivery, /PREEMPT_TAIL|deliveryMessage\s*=|formatted\s*\+=/);
});

test("hydrated file ownership survives formatting and preemption but is cleaned on every pre-send failure", () => {
	const delivery = bodyBetween("if (pkg.ownerBundle)", "const dispatches =");
	const lease = delivery.indexOf("new AttachmentDeliveryLease");
	const formatted = delivery.indexOf("formatInboundBundleMessage");
	const abort = delivery.indexOf("pi_abort()");
	const send = delivery.indexOf("pi_send(");
	const accept = delivery.indexOf("attachmentLease.accept()");
	const cleanup = delivery.indexOf("attachmentLease?.cleanupIfPending()");
	assert.ok(lease >= 0 && lease < formatted && formatted < abort && abort < send && send < accept);
	assert.ok(cleanup > accept, "the catch owns cleanup for any throw before synchronous send acceptance");
});

test("hidden typed context is injected by before_agent_start into the accepted user queue item", () => {
	const sender = bodyBetween("pi_send =", "pi_abort =");
	assert.match(sender, /commandTurnBindings\.remember\(message, commandTurnId, commandMessageId, canonicalQueueItem\)/);
	assert.match(sender, /pi\.sendUserMessage/);
	assert.doesNotMatch(sender, /pi\.sendMessage/);
	assert.match(sender, /catch \(error\)[^]*commandTurnBindings\.forget/);

	const beforeStart = bodyBetween('pi.on("before_agent_start"', 'pi.on("message_start"');
	assert.match(beforeStart, /commandTurnBindings\.peek\(event\.prompt\)/);
	assert.match(beforeStart, /customType: "devspec-remote-ingress-context"/);
	assert.match(beforeStart, /content: canonicalQueueItem\.hiddenContent/);
	assert.match(beforeStart, /display: false/);
});
