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

test("async subagents reconcile the fleet, and settle closes Working honestly (759f2818)", () => {
	assert.match(source, /snapshot = await subagentFleet\.refreshFresh\(\)/);
	assert.match(source, /snapshot\.totalActive > 0/);
	assert.match(source, /noteBackgroundTask\(SUBAGENT_FLEET_TASK_ID\)/);
	assert.match(source, /resolveBackgroundTask\(SUBAGENT_FLEET_TASK_ID\)/);
	assert.match(source, /turn !== trackedTurn \|\| trackedTurn\.revision !== expectedRevision/);
	const settled = source.slice(source.indexOf('pi.on("agent_settled"'), source.indexOf('// ---- Turn lifecycle events'));
	assert.match(settled, /reconciliation === "stale"\) return/);
	// Owner direction 2026-09-17: Working follows the model run. A settled run
	// clears presence even while owned background work pends — the completion
	// wake reopens it. The old shouldPauseSettle park spun Working for 70
	// minutes behind never-terminating tasks.
	assert.match(settled, /pump\.busy = false/);
	assert.match(settled, /beatBusy\(false, agentStats\)/);
	assert.doesNotMatch(settled, /shouldPauseSettle/);
	const messageStart = source.slice(source.indexOf('pi.on("message_start"'), source.indexOf('pi.on("message_update"'));
	assert.match(messageStart, /isSubagentAsyncNotification\(text, customType\)/);
	assert.match(messageStart, /await reconcileSubagentFleetOwnership\(turn\)/);
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

test("local turns are marked local_turn and bindings die with their command (6f4136d8)", () => {
	assert.match(source, /\.\.\.\(opts\.localTurn \? \{ local_turn: true \} : \{\}\)/);
	assert.match(source, /localTurn: isCommandTurnUnbound\(t\) && !t\.interaction/);
	assert.match(source, /localTurn: isCommandTurnUnbound\(postingTurn\) && !postingTurn\.interaction/);
	assert.match(source, /postToSession\(plan\.prompt, \{ turnKind: "local_prompt", localTurn: true \}\)/);
	assert.match(source, /commandTurnBindings\.forgetByCommand\(commandTurnId, commandMessageId\)/);
});
