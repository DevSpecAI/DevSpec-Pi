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
	// Owner direction 2026-09-17 PM: presence follows the connection-scoped
	// pending-bg set — Working persists while owned background work is
	// outstanding and clears when the last task resolves. Speech/turn-closing
	// never consult it (the 759f2818 fix), so this park cannot hold speech
	// hostage the way the deleted shouldPauseSettle did.
	assert.match(settled, /const keepWorking = !completionNeutral && pendingBackgroundTaskIds\.size > 0/);
	assert.match(settled, /pump\.busy = keepWorking/);
	assert.match(settled, /beatBusy\(keepWorking, agentStats\)/);
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
	assert.match(source, /postToSession\(plan\.prompt, \{ turnKind: "local_prompt", localTurn: true, isCurrent: t\.canPost \}\)/);
	assert.match(source, /commandTurnBindings\.forgetByCommand\(commandTurnId, commandMessageId\)/);
});

test("completion wakes adopt the parked command identity; drops are reported without identity stripping (759f2818)", () => {
	// Live repro 2026-09-17 20:04–20:08: a settle with complete_turn:false
	// parks the command turn open server-side; a fresh wake turn's unbound post
	// is then fenced as stale_generation and silently dropped. Wake turns adopt
	// the parked identity instead; stale adoption must fail without shedding it.
	assert.match(source, /let activeCommandTurnIdentity/);
	assert.match(source, /function adoptParkedCommandIdentity/);
	assert.match(source, /if \(incomingCommand\?\.turnId && incomingCommand\?\.commandMessageId\)[^]*activeCommandTurnIdentity = \{ turnId: incomingCommand\.turnId/);
	const messageStart = source.slice(source.indexOf('pi.on("message_start"'), source.indexOf('pi.on("message_update"'));
	assert.match(messageStart, /if \(harness\) adoptParkedCommandIdentity\(turn, turn\.tracker\.userKind\)/);
	const beforeStart = source.slice(source.indexOf('pi.on("before_agent_start"'), source.indexOf('pi.on("message_start"'));
	assert.match(beforeStart, /adoptParkedCommandIdentity\(turn, turn\.tracker\.userKind\)/);
	// Cleared exactly when the parked turn closes, never mid-park.
	assert.match(source, /if \(opts\.completeTurn === true\) noteCommandTurnClosed\(opts\.commandTurnId\)/);
	assert.match(source, /noteCommandTurnClosed\(commandTurnId\);/);
	const clears = source.match(/activeCommandTurnIdentity = null/g) ?? [];
	assert.ok(clears.length >= 4, `identity clears on every authority rotation (${clears.length} sites)`);
	// Only a parsed receipt may claim storage; no identity-stripping fallback.
	assert.match(source, /parsePostSessionReceipt\(raw/);
	assert.match(source, /debug\("post delivery failed"/);
	assert.match(source, /retry: "never"/);
	assert.doesNotMatch(source, /post retried unbound|buildArgs\(true\)/);
});

test("killed/terminal tasks observed in tool results reconcile the pending set (f453c61f)", () => {
	const end = source.slice(source.indexOf('pi.on("tool_execution_end"'), source.indexOf('pi.on("session_shutdown"'));
	// Launch registration is unchanged: only successful notifying wakes park.
	assert.match(end, /automaticBackgroundTaskId\(event\.toolName, event\.result, event\.isError\)/);
	// Terminal observations resolve: a kill produces no completion message,
	// so without this the id leaks and every later settle posts
	// complete_turn:false forever (live 2026-09-20: 5h stuck Working).
	assert.match(end, /terminalBackgroundTaskIds\(event\.toolName, event\.result, event\.isError\)/);
	assert.match(end, /turn\.tracker\.resolveBackgroundTask\(terminalId\)/);
	// Observability: note/resolve events with the running count make the next
	// leak computable (notes minus resolves) instead of needing forensics.
	// (Counts only — debug.ts drops all strings by design, so ids stay out.)
	// (Numeric counts only — debug.ts drops all strings by design.)
	assert.match(end, /debug\("background task noted", \{ pendingBg: turn\.tracker\.pendingBackgroundTasks\(\)\.length \}\)/);
	assert.match(end, /debug\("background task resolved from tool result", \{ pendingBg: turn\.tracker\.pendingBackgroundTasks\(\)\.length \}\)/);
});
