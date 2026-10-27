/**
 * How the Pi extension feeds the request chain (item 7a4d04fd): which messages
 * start or join a turn, which are typed by the owner, that only those are
 * admitted as local turns, how a wake's reply is posted, and what is released
 * without a message event. Runs the real bindSegmentForMessage,
 * scanAppendedNotices and adoptParkedCommandIdentity from devspec-remote.ts
 * against a real chain and ledger.
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
const binder = source.slice(source.indexOf("const QUESTION_EVENT_CUSTOM_TYPES"), source.indexOf("function noteCommandTurnClosed("));
const adoption = source.slice(source.indexOf("function adoptParkedCommandIdentity("), source.indexOf("// ---- The request chain (item 7a4d04fd)"));

const DELIVERY_A = "2000000a-0000-4000-8000-00000000000a";
const DELIVERY_B = "2000000b-0000-4000-8000-00000000000b";
const MSG_A = "1000000a-0000-4000-8000-00000000000a";
const MSG_B = "1000000b-0000-4000-8000-00000000000b";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const notice = (id: string) => `<background-task-notification><task-id>${id}</task-id><status>completed</status></background-task-notification>`;

function harness(requesters: Record<string, string> = {}) {
	const calls: Array<Record<string, unknown>> = [];
	const chain = new RequestChain({
		connectionId: "connection",
		transport: { call: async (args) => {
			calls.push(args);
			return { request_id: args.request_id, status: args.action === "close" ? "closed" : "open",
				requested_by_user_id: requesters[String(args.provenance_ref)] ?? "owner" };
		} },
	});
	const ledger = new TypedInputLedger();
	const serveTool: boolean[] = [];
	const branch: Array<Record<string, unknown>> = [];
	const sandbox: Record<string, unknown> = {
		INTERACTION_EVENT_CUSTOM_TYPE, QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE, SYSTEM_NOTICE_CUSTOM_TYPE,
		wakeKeys, backgroundNotificationTask, isBackgroundCompletionOrigin, classifyUserKind,
		requestChain: () => chain, activeRequestChain: () => chain, typedInputLedger: () => ledger,
		pi_setServeToolActive: (enabled: boolean) => serveTool.push(enabled), debug() {},
		runActive: true, leafWake: null, segmentInputKind: undefined, lastTypedText: null, lastScannedEntryId: null,
	};
	vm.createContext(sandbox);
	vm.runInContext(stripTypeScriptTypes(binder, { mode: "transform" }), sandbox);
	const bind = (input: Record<string, unknown>) => (sandbox.bindSegmentForMessage as (input: unknown) => string | null)({
		customType: null, details: undefined, isRealUserMessage: true, ...input,
	});
	const ctx = { sessionManager: { getBranch: () => branch } };
	const scan = () => (sandbox.scanAppendedNotices as (chain: unknown, ctx: unknown) => void)(chain, ctx);
	const typed = (text: string, streamingBehavior?: string) => { ledger.noteInput({ text, source: "interactive", streamingBehavior }); return bind({ text }); };
	const commandMessage = (deliveries: Array<[string, string]>) => {
		const text = `[DevSpec remote — message from someone] ${deliveries.map(([, id]) => id).join(" ")}`;
		ledger.noteInput({ text, source: "extension" });
		return bind({ text, incomingCommand: { turnId: "turn", commandMessageId: deliveries[0]![1],
			requests: deliveries.map(([provenanceRef, messageId]) => ({ provenanceRef, messageId })) } });
	};
	return { chain, ledger, sandbox, bind, calls, serveTool, branch, scan, typed, commandMessage };
}

test("a prompt the owner typed opens their request; another extension's send does not", async () => {
	const h = harness();
	assert.equal(h.typed("fix the build"), "typed");
	await settle();
	assert.deepEqual(h.calls.map((call) => call.kind), ["typed_prompt"]);
	assert.ok(await h.chain.stamp());
	h.chain.endTurn();

	h.ledger.noteInput({ text: "DevSpec recovery: continue", source: "extension" });
	assert.equal(h.bind({ text: "DevSpec recovery: continue" }), "untyped");
	assert.equal(h.calls.filter((call) => call.action === "open").length, 1, "no request for an extension's own send");
	assert.equal(await h.chain.stamp(), null, "a run it starts names nothing");
});

test("an automation run is never admitted as typed, and its writes are stamped nobody's request", async () => {
	const h = harness();
	const run = "[DevSpec remote — automation run] nightly";
	h.ledger.noteInput({ text: run, source: "extension" });
	h.ledger.noteInput({ text: "typed meanwhile", source: "interactive", streamingBehavior: "followUp" });
	assert.equal(h.bind({ text: run }), "automation");
	assert.equal(h.calls.length, 0);
	// "none" resolves to the running automation on the server; unstamped, a
	// live command would win DevSpec's default and be credited instead.
	assert.equal(await h.chain.stamp(), "none");
	assert.equal(h.ledger.pending(), 1, "the owner's typed record is still theirs");
	assert.equal(h.bind({ text: "typed meanwhile" }), "typed");
});

test("a command opens the request of every command its delivery carries", async () => {
	const h = harness();
	assert.equal(h.commandMessage([[DELIVERY_A, MSG_A]]), "command");
	await settle();
	assert.deepEqual(h.calls.map((call) => [call.kind, call.provenance_ref]), [["command", DELIVERY_A]]);
	assert.equal(h.ledger.pending(), 0);
	assert.equal(h.chain.launchSnapshot().request, h.chain.currentRequestId());
});

test("a command message with no binding names nothing, and never takes a leaf notice's request", async () => {
	const h = harness();
	h.typed("run the suite");
	h.chain.recordLaunch(taskKey("suite"), h.chain.launchSnapshot());
	h.chain.endTurn();
	h.sandbox.leafWake = [{ key: taskKey("suite"), terminal: true }];
	const stray = "[DevSpec remote — message from someone] replayed";
	h.ledger.noteInput({ text: stray, source: "extension" });
	assert.equal(h.bind({ text: stray }), "untyped");
	assert.equal(h.chain.currentRequestId(), null);
	assert.equal(await h.chain.stamp(), null);
});

test("only a wake replaying the owner's last prompt takes the leaf notice's request", async () => {
	const h = harness();
	h.typed("run the suite");
	const typed = h.chain.currentRequestId();
	h.chain.recordLaunch(taskKey("suite"), h.chain.launchSnapshot());
	h.chain.endTurn();
	h.sandbox.leafWake = [{ key: taskKey("suite"), terminal: true }];
	h.ledger.noteInput({ text: "run the suite", source: "extension" });
	assert.equal(h.bind({ text: "run the suite" }), "untyped");
	assert.equal(h.chain.currentRequestId(), typed, "the replay is the wake's turn");
	h.chain.endTurn();

	h.typed("something else");
	h.chain.recordLaunch(taskKey("job"), h.chain.launchSnapshot());
	h.chain.endTurn();
	h.sandbox.leafWake = [{ key: taskKey("job"), terminal: true }];
	h.ledger.noteInput({ text: "an unrelated send", source: "extension" });
	h.bind({ text: "an unrelated send" });
	assert.equal(h.chain.currentRequestId(), null, "anything else names nothing; the notice's request only joins");
});

test("an owner prompt typed mid-run joins the run, and terminal vs room makes it undecided", async () => {
	const h = harness();
	h.commandMessage([[DELIVERY_A, MSG_A]]);
	const command = h.chain.currentRequestId();
	assert.equal(h.typed("also check the docs", "steer"), "typed");
	assert.equal(h.chain.currentRequestId(), command, "the run still serves the command");
	assert.deepEqual((await h.chain.ambiguity())!.map((entry) => entry.kind), ["command", "typed_prompt"]);
});

test("serve_request shows only when the run's requests would be recorded differently", async () => {
	const same = harness({ [DELIVERY_A]: "ali", [DELIVERY_B]: "ali" });
	same.commandMessage([[DELIVERY_A, MSG_A]]);
	same.commandMessage([[DELIVERY_B, MSG_B]]);
	await settle(); await settle();
	assert.equal(same.serveTool.includes(true), false, "one person's two commands never show it");

	const two = harness({ [DELIVERY_A]: "ali", [DELIVERY_B]: "brandon" });
	two.commandMessage([[DELIVERY_A, MSG_A]]);
	two.commandMessage([[DELIVERY_B, MSG_B]]);
	await settle(); await settle();
	assert.equal(two.serveTool.at(-1), true);
});

test("a harness wake continues the request that launched its work; one nothing launched names nothing", async () => {
	const h = harness();
	h.typed("run the suite");
	const typed = h.chain.currentRequestId();
	h.chain.recordLaunch(taskKey("suite"), h.chain.launchSnapshot());
	h.chain.endTurn();
	assert.equal(h.bind({ text: notice("suite"), customType: "background-task-notification", isRealUserMessage: false }), "wake");
	assert.equal(h.chain.currentRequestId(), typed);
	h.chain.endTurn();
	assert.equal(h.bind({ text: notice("other"), customType: "background-task-notification", isRealUserMessage: false }), "none");
	assert.equal(await h.chain.stamp(), null);
});

test("context injections are not input; a notice outside a run starts nothing", () => {
	const h = harness();
	assert.equal(h.bind({ text: "### DevSpec memory — auto-recall\n…", customType: "devspec-memory", isRealUserMessage: false }), null);
	assert.equal(h.chain.turnActive, false);
	h.sandbox.runActive = false;
	assert.equal(h.bind({ text: notice("x"), customType: "background-task-notification", isRealUserMessage: false }), null);
	assert.equal(h.chain.turnActive, false);
});

test("a notice Pi appended without a message event still releases its work", async () => {
	const h = harness();
	h.typed("run the suite");
	h.chain.recordLaunch(taskKey("suite"), h.chain.launchSnapshot());
	h.chain.endTurn();
	await settle();
	h.branch.push({ id: "e1", type: "message" });
	h.scan();
	await settle();
	assert.equal(h.calls.filter((call) => call.action === "close").length, 0, "still to wake");
	h.branch.push({ id: "e2", type: "custom_message", customType: "background-task-notification", content: notice("suite") });
	h.scan();
	await settle(); await settle();
	assert.equal(h.calls.filter((call) => call.action === "close").length, 1);
	assert.equal(h.sandbox.lastScannedEntryId, "e2", "the next scan starts after what this one read");
});

test("a system notice run names nothing", () => {
	const h = harness();
	assert.equal(h.bind({ text: "[DevSpec system notice v1]", customType: SYSTEM_NOTICE_CUSTOM_TYPE, isRealUserMessage: false }), "none");
	assert.equal(h.chain.currentRequestId(), null);
});

test("a wake's reply posts as the open command turn's newest command, on any server; who asked travels in request_ref", async () => {
	const sandbox: Record<string, unknown> = { activeCommandTurnIdentity: null, debug() {} };
	vm.createContext(sandbox);
	vm.runInContext(stripTypeScriptTypes(adoption, { mode: "transform" }), sandbox);
	const adopt = (open: unknown, kind = "harness", t: Record<string, unknown> = {}) => {
		sandbox.activeCommandTurnIdentity = open;
		(sandbox.adoptParkedCommandIdentity as (t: unknown, kind: string) => void)(t, kind);
		return t;
	};
	// An old server: every open fails. M1 starts a job; M2 joins the same open
	// turn; the job's wake must post as M2 so the newer segment is not left
	// Working, while its writes name nothing (DevSpec resolves who asked).
	const refused = new RequestChain({ connectionId: "connection", transport: { call: async () => { throw new Error("unknown tool report_request"); } } });
	refused.arrive([refused.openCommand({ provenanceRef: DELIVERY_A, messageId: MSG_A, commandTurnId: "T", commandMessageId: MSG_A })!]);
	await settle();
	refused.recordLaunch(taskKey("job"), refused.launchSnapshot());
	refused.arrive([refused.openCommand({ provenanceRef: DELIVERY_B, messageId: MSG_B, commandTurnId: "T", commandMessageId: MSG_B })!]);
	await settle();
	refused.endTurn();
	assert.equal(refused.wake([{ key: taskKey("job"), terminal: true }]), true, "the launch was recorded though no request opened");
	assert.equal(await refused.stamp(), null);
	assert.deepEqual(adopt({ turnId: "T", commandMessageId: MSG_B }), { commandTurnId: "T", commandMessageId: MSG_B });
	assert.deepEqual(adopt(null), {}, "no open command turn: posts unbound, as before");
	assert.deepEqual(adopt({ turnId: "T", commandMessageId: MSG_B }, "local"), {});
	assert.deepEqual(adopt({ turnId: "T", commandMessageId: MSG_B }, "harness", { commandTurnId: "own", commandMessageId: "own" }), { commandTurnId: "own", commandMessageId: "own" });
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

test("a revive keeps the chain unless the connection changed or ended; the run boundary, launches and shutdown feed it", () => {
	const revive = source.slice(source.indexOf("async function reviveRecoverableBond("), source.indexOf("async function ensureRoomSync("));
	assert.match(revive, /if \(changedConnection \|\| serverEnded\) dropRequestChain\(\);\s*setBond\(bond\);/);
	assert.equal((revive.match(/dropRequestChain\(\)/g) ?? []).length, 1);
	const loop = source.slice(source.indexOf("async function pumpLoop("));
	// The server said the connection ended (push end, poll status ended/not_found): its requests closed.
	assert.match(loop, /push ended recoverable[^]{0,120}reviveRecoverableBond\(active, token, ctx, undefined, true\)/);
	assert.match(loop, /poll recoverable server response[^]{0,160}reviveRecoverableBond\(active, token, ctx, undefined, true\)/);
	// An auth-shaped poll failure revives the same, still-live connection: its requests stay carried.
	assert.match(loop, /const failure = \{ authFailed: false \};\s*if \(await reviveRecoverableBond\(active, token, ctx, failure\)\)/);
	const settled = source.slice(source.indexOf('pi.on("agent_settled"'), source.indexOf("const activeAtSettle = pump;"));
	assert.match(settled, /typedInputLedger\(\)\.expire\(\);[^]*settledChain\?\.endTurn\(\);[^]*scanAppendedNotices\(settledChain, ctx\)/);
	const call = source.slice(source.indexOf('pi.on("tool_call"'), source.indexOf('pi.on("tool_execution_start"'));
	assert.match(call, /isLaunchCall\(call\.toolName, call\.input\)/);
	assert.match(call, /const carried = await chain\.ambiguity\(\);[^]*return \{ block: true, reason: launchRefusal\(carried\) \}/);
	const launch = source.slice(source.indexOf('pi.on("tool_execution_start"'), source.indexOf('pi.on("tool_execution_update"'));
	assert.match(launch, /if \(!launchRequests\.has\(event\.toolCallId\)\) \{\s*launchRequests\.set\(event\.toolCallId, \{ snapshot: requestChain\(\)\?\.launchSnapshot\(\) \?\? null/);
	const end = source.slice(source.indexOf('pi.on("tool_execution_end"'), source.indexOf('pi.on("session_shutdown"'));
	assert.match(end, /recordLaunchedWork\(event\.toolName, launch, event\.result, event\.isError\)/);
	const observed = source.slice(source.indexOf("const applyBackgroundObservation ="), source.indexOf("const backgroundObserver = new BackgroundWorkObserver"));
	assert.match(observed, /task\.state === "killed"\) chain\.endLaunch\(taskKey\(task\.id\)\)/);
	assert.match(observed, /reconcileRestored\(chain, false, null\)/);
	const reconcile = source.slice(source.indexOf("const reconcileRestored ="), source.indexOf("pi_reconcileRestoredLaunches ="));
	// After a fresh refresh, a restored task the provider does not list (and the journal never saw finish) is over.
	assert.match(reconcile, /const listedAfterRefresh = refreshed && observation\.scope !== null;/);
	assert.match(reconcile, /if \(state === undefined && listedAfterRefresh\) return false;/);
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
