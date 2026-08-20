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

test("every Pi poll negotiates numeric canonical ingress v1 and uses cursor_v2", () => {
	const calls = [...source.matchAll(/callDevspec\([^]*?"poll_connection"[^]*?\{([^]*?)\}, \{/gu)];
	assert.equal(calls.length, 2, "expected control ack and pump poll only");
	for (const call of calls) assert.match(call[1], /ingress_version: 1/);
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /cursor_v2: active\.cursor/);
	assert.doesNotMatch(pump, /\bcursor: active\.cursor/);
});

test("canonical parser output is the only owner/control/context delivery source", () => {
	const pump = bodyBetween("async function pumpLoop", "interface BondOutcome");
	assert.match(pump, /parsePollPayload\(payload, active\.bond\.connectionId\)/);
	assert.match(pump, /pkg\.ownerCommands/);
	assert.match(pump, /pkg\.control/);
	assert.doesNotMatch(pump, /payload[^\n]*commands/);
	assert.doesNotMatch(pump, /buildRoomDigest|owner_ambient|room_context/);
});

test("attachment hydration fails before preemption/send and retry state stays transactional", () => {
	const delivery = bodyBetween("for (const cmd of active.seenOwnerCommands.takeUnseen(pkg.ownerCommands))", "const dispatches =");
	const hydrated = delivery.indexOf("await withMaterialisedAttachments");
	const decide = delivery.indexOf("decideOwnerDelivery");
	const abort = delivery.indexOf("pi_abort()");
	const send = delivery.indexOf("pi_send(");
	assert.ok(hydrated >= 0 && hydrated < decide && decide < abort && abort < send);
	assert.match(delivery, /active\.seenOwnerCommands\.commit\(cmd\)/);
	assert.match(delivery, /catch \(err\)[^]*active\.seenOwnerCommands\.release\(cmd\)/);
	assert.doesNotMatch(delivery, /reportComplete\("delivery_failed"/);
	const cursorCommit = source.indexOf("if (!commandDeliveryFailed)");
	assert.ok(cursorCommit > source.indexOf("active.seenOwnerCommands.release(cmd)"));
});

test("hidden canonical context is queued immediately before the exact user message in every mode", () => {
	const sender = bodyBetween("pi_send =", "pi_abort =");
	const hidden = sender.indexOf("pi.sendMessage(custom");
	const binding = sender.indexOf("commandTurnBindings.remember");
	const user = sender.indexOf("pi.sendUserMessage");
	assert.ok(hidden >= 0 && hidden < binding && binding < user);
	assert.match(sender, /customType: "devspec-remote-ingress-context"/);
	assert.match(sender, /display: false/);
	assert.match(sender, /deliverAs: "steer"/);
	assert.match(sender, /deliverAs: "followUp"/);
	assert.match(sender, /command_message_id: commandMessageId/);
	assert.match(sender, /command_turn_id: commandTurnId/);
});
