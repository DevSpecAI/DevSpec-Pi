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
	assert.match(source, /commandTurnId: postingTurn\.commandTurnId, commandMessageId: postingTurn\.commandMessageId/);
	assert.match(source, /reportComplete\("turn_end", commandTurnId, commandMessageId, commandTurnUnbound, interactionIdentity\(interactionRun\)\)/);
	assert.match(source, /reportComplete\("process_exit", openTurn\.commandTurnId, openTurn\.commandMessageId, isCommandTurnUnbound\(openTurn\), interactionIdentity\(openTurn\.interaction\)\)/);
});

test("async subagents retain parent Working until the authoritative fleet is empty", () => {
	assert.match(source, /snapshot = await subagentFleet\.refreshFresh\(\)/);
	assert.match(source, /snapshot\.totalActive > 0/);
	assert.match(source, /noteBackgroundTask\(SUBAGENT_FLEET_TASK_ID\)/);
	assert.match(source, /resolveBackgroundTask\(SUBAGENT_FLEET_TASK_ID\)/);
	assert.match(source, /turn !== trackedTurn \|\| trackedTurn\.revision !== expectedRevision/);
	const settled = source.slice(source.indexOf('pi.on("agent_settled"'), source.indexOf('// ---- Turn lifecycle events'));
	assert.match(settled, /reconciliation === "stale"\) return/);
	assert.match(settled, /const keepWorking = !completionNeutral && Boolean\(settlingTurn && shouldPauseSettle\(settlingTurn\.tracker\)\)/);
	assert.match(settled, /if \(pump && activityPolicy\.reportPresence\)/);
	assert.match(settled, /pump\.busy = keepWorking/);
	assert.match(settled, /beatBusy\(keepWorking, agentStats\)/);
	assert.doesNotMatch(settled, /pump\.busy = false|beatBusy\(false/);
	const messageStart = source.slice(source.indexOf('pi.on("message_start"'), source.indexOf('pi.on("message_update"'));
	assert.match(messageStart, /isSubagentAsyncNotification\(text, customType\)/);
	assert.match(messageStart, /await reconcileSubagentFleetOwnership\(notificationTurn\)/);
	assert.match(messageStart, /allowNextAnswerBeforeBackgroundContinuation\(\)/);
	const agentStart = source.slice(source.indexOf('pi.on("agent_start"'), source.indexOf('pi.on("agent_settled"'));
	assert.match(agentStart, /turn\.occupancy = occupancy \?\? undefined;[^]*turn\.revision = nextTurnRevision\+\+/);
});

test("delivery boundaries post the old exact command before rebinding the new segment", () => {
	const split = source.slice(source.indexOf("function splitTurnAtBoundary"), source.indexOf("async function beatBusy"));
	assert.match(split, /commandTurnId: t\.commandTurnId/);
	assert.match(split, /commandMessageId: t\.commandMessageId/);
	assert.match(source, /splitTurnAtBoundary\(\);[\s\S]{0,2400}turn\.commandTurnId = incomingCommand\?\.turnId;[\s\S]{0,200}turn\.commandMessageId = incomingCommand\?\.commandMessageId/);
	assert.doesNotMatch(source, /commandTurnBindings\.has\(/, "client queue guesses must not own server completion");
	assert.match(source, /pure tool-call\/no-text segment[\s\S]{0,500}trackTerminalPost\(reportComplete/);
	assert.match(source, /await Promise\.allSettled\(\[\.\.\.pendingTerminalPosts\]\)/);
	const shutdown = source.slice(source.indexOf('pi.on("session_shutdown"'));
	assert.ok(shutdown.indexOf("active.stop = true") < shutdown.indexOf("await Promise.allSettled"));
	assert.match(source, /active\.stop && !active\.closing/);
	assert.match(source, /pump !== active \|\| active\.stop/);
	assert.match(source, /pump !== active \|\| !isPumpAuthorityCurrent\(authority/);
});
