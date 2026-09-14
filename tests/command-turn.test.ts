import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandTurnBindings } from "../extensions/core/command-turn.ts";
import { formatCanonicalDeliveryContext, formatInboundBundleMessage, parsePollPayload } from "../extensions/core/remote-payload.ts";
import { canonicalPoll, DELEGATED_PROJECT_INSTRUCTION, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";

test("retains immutable turn and command ids until the exact injected message starts", () => {
	const bindings = new CommandTurnBindings();
	bindings.remember("owner command one", "turn-1", "message-1");
	bindings.remember("owner command two", "turn-2", "message-2");

	assert.deepEqual(bindings.take("owner command two"), { turnId: "turn-2", commandMessageId: "message-2" });
	assert.deepEqual(bindings.take("owner command one"), { turnId: "turn-1", commandMessageId: "message-1" });
	assert.equal(bindings.take("owner command one"), undefined, "a binding is consumed once");
});

test("identical command text remains FIFO and incomplete identity is never retained", () => {
	const bindings = new CommandTurnBindings();
	bindings.remember("same text", "turn-1", "message-old");
	bindings.remember("same text", "turn-1", "message-new");
	bindings.remember("local text", undefined, undefined);

	assert.deepEqual(bindings.take("same text"), { turnId: "turn-1", commandMessageId: "message-old" });
	assert.deepEqual(bindings.take("same text"), { turnId: "turn-1", commandMessageId: "message-new" });
	assert.equal(bindings.take("local text"), undefined);
});

test("hidden canonical data peeks for the same turn without consuming identity", () => {
	const bindings = new CommandTurnBindings();
	const canonicalQueueItem = { hiddenContent: "typed context + exact commands", details: { envelope: "e1" } };
	bindings.remember("atomic bundle", "turn-1", "message-primary", canonicalQueueItem);
	assert.deepEqual(bindings.peek("atomic bundle")?.canonicalQueueItem, canonicalQueueItem);
	assert.deepEqual(bindings.take("atomic bundle"), {
		turnId: "turn-1",
		commandMessageId: "message-primary",
		canonicalQueueItem,
	});
	assert.equal(bindings.peek("atomic bundle"), undefined);
});

test("idle, steer, and followUp retain delegated scope without crossing into an owner bundle", () => {
	const bindings = new CommandTurnBindings();
	const delegatedBundle = parsePollPayload(canonicalPoll({ delegated: true, body: "same exact body" }), TEST_CONNECTION).ownerBundle!;
	const ownerBundle = parsePollPayload(canonicalPoll({ body: "same exact body" }), TEST_CONNECTION).ownerBundle!;
	const delegatedMessage = formatInboundBundleMessage(delegatedBundle);
	const ownerMessage = formatInboundBundleMessage(ownerBundle);
	assert.ok(delegatedMessage.includes(DELEGATED_PROJECT_INSTRUCTION));
	assert.ok(!ownerMessage.includes(DELEGATED_PROJECT_INSTRUCTION));
	assert.notEqual(delegatedMessage, ownerMessage, "visible scope framing prevents delegated and owner turns with the same body from aliasing");

	for (const [index, mode] of ["now", "steer", "followUp"].entries()) {
		bindings.remember(delegatedMessage, `turn-${mode}`, `message-${index}`, {
			hiddenContent: formatCanonicalDeliveryContext(delegatedBundle, []),
			details: { mode },
		});
	}
	bindings.remember(ownerMessage, "turn-owner", "message-owner", {
		hiddenContent: formatCanonicalDeliveryContext(ownerBundle, []),
		details: { mode: "owner" },
	});

	const owner = bindings.take(ownerMessage)?.canonicalQueueItem;
	assert.deepEqual(owner?.details, { mode: "owner" });
	assert.ok(!owner?.hiddenContent.includes(DELEGATED_PROJECT_INSTRUCTION));
	for (const mode of ["now", "steer", "followUp"]) {
		const delegated = bindings.take(delegatedMessage)?.canonicalQueueItem;
		assert.deepEqual(delegated?.details, { mode });
		assert.ok(delegated?.hiddenContent.includes(DELEGATED_PROJECT_INSTRUCTION));
	}
});

test("a rejected send can forget only its exact queued command", () => {
	const bindings = new CommandTurnBindings();
	bindings.remember("same", "turn-1", "message-1");
	bindings.remember("same", "turn-1", "message-2");
	bindings.forget("same", "turn-1", "message-2");
	assert.deepEqual(bindings.take("same"), { turnId: "turn-1", commandMessageId: "message-1" });
	assert.equal(bindings.take("same"), undefined);
});

test("clear removes queued identities on detach or shutdown", () => {
	const bindings = new CommandTurnBindings();
	bindings.remember("queued", "turn-1", "message-1");
	bindings.clear();
	assert.equal(bindings.take("queued"), undefined);
});

test("forgetByCommand drops only the closed command's strays, never a queued sibling", () => {
	const bindings = new CommandTurnBindings();
	bindings.remember("first command", "turn-1", "message-1");
	bindings.remember("second command", "turn-1", "message-2");
	bindings.remember("other turn", "turn-2", "message-3");
	assert.deepEqual(bindings.take("first command"), { turnId: "turn-1", commandMessageId: "message-1" });
	// A never-delivered stray for the closed command must not survive it...
	bindings.remember("first command", "turn-1", "message-1");
	bindings.forgetByCommand("turn-1", "message-1");
	assert.equal(bindings.take("first command"), undefined);
	// ...while the queued sibling in the same turn and other turns survive.
	assert.deepEqual(bindings.take("second command"), { turnId: "turn-1", commandMessageId: "message-2" });
	assert.deepEqual(bindings.take("other turn"), { turnId: "turn-2", commandMessageId: "message-3" });
});

test("forgetByCommand without a message id drops the whole closed turn", () => {
	const bindings = new CommandTurnBindings();
	bindings.remember("a", "turn-1", "message-1");
	bindings.remember("b", "turn-1", "message-2");
	bindings.forgetByCommand("turn-1", undefined);
	assert.equal(bindings.take("a"), undefined);
	assert.equal(bindings.take("b"), undefined);
});
