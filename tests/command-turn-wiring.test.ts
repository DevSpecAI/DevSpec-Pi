import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");

test("Pi carries immutable turn + command identity through every activity output path", () => {
	assert.match(source, /commandTurnBindings\.remember\(message, commandTurnId, commandMessageId, canonicalQueueItem\)/);
	assert.match(source, /turn\.commandTurnId = incomingCommand\?\.turnId/);
	assert.match(source, /turn\.commandMessageId = incomingCommand\?\.commandMessageId/);
	assert.match(source, /command_turn_id: opts\.commandTurnId/);
	assert.match(source, /command_message_id: opts\.commandMessageId/);
	assert.match(source, /command_turn_unbound: true/);
	assert.match(source, /commandTurnId: turn\.commandTurnId, commandMessageId: turn\.commandMessageId/);
	assert.match(source, /reportComplete\("turn_end", commandTurnId, commandMessageId, commandTurnUnbound\)/);
	assert.match(source, /reportComplete\("process_exit", openTurn\.commandTurnId, openTurn\.commandMessageId, isCommandTurnUnbound\(openTurn\)\)/);
});

test("delivery boundaries post the old exact command before rebinding the new segment", () => {
	const split = source.slice(source.indexOf("function splitTurnAtBoundary"), source.indexOf("async function beatBusy"));
	assert.match(split, /commandTurnId: t\.commandTurnId/);
	assert.match(split, /commandMessageId: t\.commandMessageId/);
	assert.match(source, /splitTurnAtBoundary\(\);[\s\S]{0,1400}turn\.commandTurnId = incomingCommand\?\.turnId;[\s\S]{0,200}turn\.commandMessageId = incomingCommand\?\.commandMessageId/);
	assert.doesNotMatch(source, /commandTurnBindings\.has\(/, "client queue guesses must not own server completion");
	assert.match(source, /pure tool-call\/no-text segment[\s\S]{0,500}trackTerminalPost\(reportComplete/);
	assert.match(source, /await Promise\.allSettled\(\[\.\.\.pendingTerminalPosts\]\)/);
	const shutdown = source.slice(source.indexOf('pi.on("session_shutdown"'));
	assert.ok(shutdown.indexOf("active.stop = true") < shutdown.indexOf("await Promise.allSettled"));
	assert.match(source, /active\.stop && !active\.closing/);
	assert.match(source, /pump !== active \|\| active\.stop/);
	assert.match(source, /pump !== active \|\| \(active\.stop && !active\.closing\)/);
});
