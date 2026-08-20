import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandTurnBindings } from "../extensions/core/command-turn.ts";

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
