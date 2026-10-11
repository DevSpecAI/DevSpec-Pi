/**
 * How the Pi extension feeds the request chain (item 7a4d04fd): which messages
 * start or join a turn, which are typed by the owner, and that only those are
 * admitted as local turns. Runs the real bindSegmentForMessage from
 * devspec-remote.ts against a real chain and ledger.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { test } from "node:test";
import {
	RequestChain,
	TypedInputLedger,
	backgroundNotificationTask,
	taskKey,
	wakeKeys,
} from "../extensions/core/request-chain.ts";
import { classifyUserKind, isBackgroundCompletionOrigin } from "../extensions/core/turn-lifecycle.ts";
import { INTERACTION_EVENT_CUSTOM_TYPE, QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE } from "../extensions/core/interaction-events.ts";
import { SYSTEM_NOTICE_CUSTOM_TYPE } from "../extensions/core/system-notice.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const tools = readFileSync(new URL("../extensions/devspec-tools.ts", import.meta.url), "utf8");
const binder = source.slice(source.indexOf("const QUESTION_EVENT_CUSTOM_TYPES"), source.indexOf("/** The command a wake-bound segment continues"));

const DELIVERY_A = "2000000a-0000-4000-8000-00000000000a";
const MSG_A = "1000000a-0000-4000-8000-00000000000a";

function harness() {
	const opened: Array<Record<string, unknown>> = [];
	const chain = new RequestChain({
		connectionId: "connection",
		transport: { call: async (args) => { opened.push(args); return { request_id: args.request_id, status: "open", requested_by_user_id: "owner" }; } },
	});
	const ledger = new TypedInputLedger();
	const serveTool: boolean[] = [];
	const sandbox: Record<string, unknown> = {
		INTERACTION_EVENT_CUSTOM_TYPE, QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE, SYSTEM_NOTICE_CUSTOM_TYPE,
		wakeKeys, backgroundNotificationTask, isBackgroundCompletionOrigin, classifyUserKind,
		requestChain: () => chain, typedInputLedger: () => ledger,
		pi_setServeToolActive: (enabled: boolean) => serveTool.push(enabled),
		runActive: true, leafWake: null, segmentInputKind: undefined,
	};
	vm.createContext(sandbox);
	vm.runInContext(stripTypeScriptTypes(binder, { mode: "transform" }), sandbox);
	const bind = (input: Record<string, unknown>) => (sandbox.bindSegmentForMessage as (input: unknown) => string | null)({
		customType: null, details: undefined, isRealUserMessage: true, ...input,
	});
	return { chain, ledger, sandbox, bind, opened, serveTool };
}

test("a prompt the owner typed opens their request; another extension's send does not", async () => {
	const h = harness();
	h.ledger.noteInput({ text: "fix the build", source: "interactive" });
	assert.equal(h.bind({ text: "fix the build" }), "typed");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(h.opened.map((call) => call.kind), ["typed_prompt"]);
	assert.ok(await h.chain.stamp());
	h.chain.endTurn();

	h.ledger.noteInput({ text: "DevSpec recovery: continue", source: "extension" });
	assert.equal(h.bind({ text: "DevSpec recovery: continue" }), "untyped");
	assert.equal(h.opened.length, 1, "no request for an extension's own send");
	assert.equal(await h.chain.stamp(), null, "a run it starts names nothing");
});

test("an automation run is never admitted as typed, even while the owner has typed input queued", async () => {
	const h = harness();
	const run = "[DevSpec remote — automation run] nightly";
	h.ledger.noteInput({ text: run, source: "extension" });
	h.ledger.noteInput({ text: "typed meanwhile", source: "interactive", streamingBehavior: "followUp" });
	assert.equal(h.bind({ text: run }), "automation");
	assert.equal(h.opened.length, 0);
	assert.equal(await h.chain.stamp(), null, "the server records the automation itself");
	assert.equal(h.ledger.pending(), 1, "the owner's typed record is still theirs");
	assert.equal(h.bind({ text: "typed meanwhile" }), "typed");
});

test("a command opens the request of every command its delivery carries", async () => {
	const h = harness();
	h.ledger.noteInput({ text: "[DevSpec remote — message from Ali] go", source: "extension" });
	const kind = h.bind({ text: "[DevSpec remote — message from Ali] go", incomingCommand: {
		turnId: "turn", commandMessageId: MSG_A, requests: [{ provenanceRef: DELIVERY_A, messageId: MSG_A }],
	} });
	assert.equal(kind, "command");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(h.opened.map((call) => [call.kind, call.provenance_ref]), [["command", DELIVERY_A]]);
	assert.equal(h.ledger.pending(), 0);
	assert.deepEqual(h.chain.commandIdentity(), { commandTurnId: "turn", commandMessageId: MSG_A });
});

test("a harness wake continues the request that launched its work; one nothing launched names nothing", async () => {
	const h = harness();
	h.ledger.noteInput({ text: "run the suite", source: "interactive" });
	h.bind({ text: "run the suite" });
	const typed = h.chain.currentRequestId();
	h.chain.recordLaunch(taskKey("suite"), h.chain.launchSnapshot());
	h.chain.endTurn();
	const notice = "<background-task-notification><task-id>suite</task-id><status>completed</status></background-task-notification>";
	assert.equal(h.bind({ text: notice, customType: "background-task-notification", isRealUserMessage: false }), "wake");
	assert.equal(h.chain.currentRequestId(), typed);
	h.chain.endTurn();
	const stranger = "<background-task-notification><task-id>other</task-id><status>completed</status></background-task-notification>";
	assert.equal(h.bind({ text: stranger, customType: "background-task-notification", isRealUserMessage: false }), "none");
	assert.equal(await h.chain.stamp(), null);
});

test("context injections are not input; a notice appended outside a run starts nothing", () => {
	const h = harness();
	assert.equal(h.bind({ text: "### DevSpec memory — auto-recall\n…", customType: "devspec-memory", isRealUserMessage: false }), null);
	assert.equal(h.chain.turnActive, false);
	h.sandbox.runActive = false;
	const notice = "<background-task-notification><task-id>x</task-id><status>completed</status></background-task-notification>";
	assert.equal(h.bind({ text: notice, customType: "background-task-notification", isRealUserMessage: false }), null);
	assert.equal(h.chain.turnActive, false);
});

test("a system notice run names nothing; serve_request shows only once a second request joins", () => {
	const h = harness();
	assert.equal(h.bind({ text: "[DevSpec system notice v1]", customType: SYSTEM_NOTICE_CUSTOM_TYPE, isRealUserMessage: false }), "none");
	assert.equal(h.chain.currentRequestId(), null);
	h.chain.endTurn();
	h.ledger.noteInput({ text: "one", source: "interactive" });
	h.bind({ text: "one" });
	assert.equal(h.serveTool.at(-1), false);
	h.ledger.noteInput({ text: "two", source: "interactive", streamingBehavior: "steer" });
	h.bind({ text: "two" });
	assert.equal(h.serveTool.at(-1), true);
});

test("only a typed segment is admitted or mirrored as a local turn", () => {
	const admission = source.slice(source.indexOf("function prepareLocalActivity("), source.indexOf("/** Consumed input is known at context"));
	assert.match(admission, /t\.requestKind !== "typed"/);
	const context = source.slice(source.indexOf('\tpi.on("context"'), source.indexOf('\tpi.on("turn_start"'));
	assert.match(context, /t\.tracker\.shouldMirrorPrompt && t\.tracker\.userText && t\.requestKind === "typed"/);
	const start = source.slice(source.indexOf('pi.on("message_start"'), source.indexOf('pi.on("message_update"'));
	assert.match(start, /turn\.requestKind = segmentKind \?\? "untyped"/);
	assert.match(start, /if \(turn\.requestKind !== "typed"\) turn\.tracker\.shouldMirrorPrompt = false/);
	// Bound before the room check: a sessionless connection carries requests too.
	assert.ok(start.indexOf("bindSegmentForMessage(") < start.indexOf("if (!turn) return;"));
});

test("the run boundary, launch capture and shutdown feed the chain", () => {
	const settled = source.slice(source.indexOf('pi.on("agent_settled"'), source.indexOf("const activeAtSettle = pump;"));
	assert.match(settled, /typedInputLedger\(\)\.expire\(\);[^]*requestChain\(\)\?\.endTurn\(\);/);
	const launch = source.slice(source.indexOf('pi.on("tool_execution_start"'), source.indexOf('pi.on("tool_execution_update"'));
	assert.match(launch, /launchRequests\.set\(event\.toolCallId, \{ snapshot: requestChain\(\)\?\.launchSnapshot\(\) \?\? null, args: event\.args \}\)/);
	const end = source.slice(source.indexOf('pi.on("tool_execution_end"'), source.indexOf('pi.on("session_shutdown"'));
	assert.match(end, /recordLaunchedWork\(event\.toolName, launch, event\.result, event\.isError\)/);
	const shutdown = source.slice(source.indexOf('pi.on("session_shutdown"'));
	assert.ok(shutdown.indexOf("chainAtShutdown.shutdown()") < shutdown.indexOf("pump = null;"));
	assert.match(source, /pi\.on\("input", \(event\) => \{\s*typedInputLedger\(\)\.noteInput\(event\);/);
});

test("every DevSpec write is stamped or refused before it reaches the network", () => {
	const verb = tools.slice(tools.indexOf("async function executeVerb("), tools.indexOf("function registerCatalogTool("));
	assert.match(verb, /stampRequestRef\(\{[^]*inputSchema: catalogEntry\(name\)\?\.inputSchema,[^]*connectionId: bond\?\.connectionId/);
	assert.ok(verb.indexOf('if ("deny" in stamped)') < verb.indexOf("callDevspec("));
	const work = readFileSync(new URL("../extensions/devspec-work.ts", import.meta.url), "utf8");
	assert.match(work, /markTypedSend\(prompt\);\s*try \{\s*pi\.sendUserMessage\(prompt\);/);
});
