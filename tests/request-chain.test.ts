/**
 * The request chain (item 7a4d04fd): which request a turn, a launch and a write
 * serve, and when a write must say which. Mirrors the Claude Code plugin's
 * hooks/scripts/requests.test.mjs rule for rule.
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
	NO_REQUEST,
	UNSTATED,
	RequestChain,
	TypedInputLedger,
	ambiguityRefusal,
	askedQuestionId,
	backgroundLaunch,
	backgroundNotificationTask,
	cancelledQuestionId,
	declaresRequestRef,
	installRequestChain,
	parseRequestLinkEntry,
	questionKey,
	REQUEST_LINK_ENTRY,
	stampRequestRef,
	subagentKey,
	subagentLaunch,
	taskKey,
	wakeKeys,
	withServeRequestToolActive,
	SERVE_REQUEST_TOOL,
	type RequestLinkEntry,
} from "../extensions/core/request-chain.ts";
import { MCP_CATALOG } from "../extensions/generated/mcp-catalog.ts";

const CONN = "11111111-1111-4111-8111-111111111111";
const ALI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRANDON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELIVERY_A = "2000000a-0000-4000-8000-00000000000a";
const DELIVERY_B = "2000000b-0000-4000-8000-00000000000b";
const DELIVERY_C = "2000000c-0000-4000-8000-00000000000c";
const MSG_A = "1000000a-0000-4000-8000-00000000000a";
const MSG_B = "1000000b-0000-4000-8000-00000000000b";
const MSG_C = "1000000c-0000-4000-8000-00000000000c";

interface Call { action: string; request_id: string; kind?: string; provenance_ref?: string; reason?: string }

/** A fake report_request: who asked follows the delivery; the owner typed prompts. */
function harness(options: { requesters?: Record<string, string>; refuse?: (args: Call) => boolean; closed?: Set<string> } = {}) {
	const calls: Call[] = [];
	const journal: Array<Omit<RequestLinkEntry, "version" | "nativeSessionId" | "connectionId">> = [];
	const requesters = options.requesters ?? { [DELIVERY_A]: ALI, [DELIVERY_B]: BRANDON, [DELIVERY_C]: ALI };
	const chain = new RequestChain({
		connectionId: CONN,
		transport: {
			call: async (raw) => {
				const args = raw as unknown as Call;
				calls.push(args);
				if (options.refuse?.(args)) throw new Error("request: refused");
				if (args.action === "close") return { request_id: args.request_id, status: "closed", already_closed: false };
				const status = options.closed?.has(args.request_id) ? "closed" : "open";
				return { request_id: args.request_id, status, already_open: false,
					requested_by_user_id: args.kind === "typed_prompt" ? ALI : requesters[args.provenance_ref ?? ""] };
			},
		},
		journal: (entry) => journal.push(entry),
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	return { chain, calls, journal, settle };
}

const command = (chain: RequestChain, provenanceRef: string, messageId: string) =>
	chain.openCommand({ provenanceRef, messageId, commandTurnId: "turn", commandMessageId: messageId })!;

describe("opening and closing requests", () => {
	test("a command opens with its provenance_ref, a typed prompt without; a carried command is reused", async () => {
		const { chain, calls, settle } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		const t = chain.openTyped()!;
		assert.equal(command(chain, DELIVERY_A, MSG_A), a, "the same command is the request it already is");
		await settle();
		assert.deepEqual(calls.map(({ action, kind, provenance_ref }) => ({ action, kind, provenance_ref })), [
			{ action: "open", kind: "command", provenance_ref: DELIVERY_A },
			{ action: "open", kind: "typed_prompt", provenance_ref: undefined },
		]);
		assert.notEqual(a, t);
	});

	test("a request closes when its turn settles with nothing pending", async () => {
		const { chain, calls, settle } = harness();
		chain.arrive([command(chain, DELIVERY_A, MSG_A)]);
		await settle();
		chain.endTurn();
		await settle();
		assert.deepEqual(calls.map((call) => call.action), ["open", "close"]);
		assert.equal(calls[1]!.reason, "host_finished");
		assert.equal(await chain.stamp(), null, "a finished request is never stamped again");
	});

	test("work a request launched keeps it open until that work's wake; the wake continues it", async () => {
		const { chain, calls, settle } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		chain.arrive([a]);
		await settle();
		chain.recordLaunch(taskKey("job"), chain.launchSnapshot(), { notifies: true });
		chain.endTurn();
		await settle();
		assert.deepEqual(calls.map((call) => call.action), ["open"], "still carried while its job runs");
		chain.wake([{ key: taskKey("job"), terminal: true }]);
		assert.equal(chain.currentRequestId(), a);
		const stamped = await chain.stamp();
		assert.equal(stamped, calls[0]!.request_id);
		chain.endTurn();
		await settle();
		assert.deepEqual(calls.map((call) => call.action), ["open", "close"]);
	});

	test("a launch that never notifies does not hold its request; a kill or cancelled question releases it", async () => {
		for (const end of ["quiet", "kill", "cancel"] as const) {
			const { chain, calls, settle } = harness();
			chain.arrive([chain.openTyped()!]);
			await settle();
			const key = end === "cancel" ? questionKey("q") : taskKey("job");
			chain.recordLaunch(key, chain.launchSnapshot(), { notifies: end !== "quiet" });
			chain.endTurn();
			if (end !== "quiet") {
				await settle();
				assert.deepEqual(calls.map((call) => call.action), ["open"], end);
				chain.endLaunch(key);
			}
			await settle();
			assert.deepEqual(calls.map((call) => call.action), ["open", "close"], end);
		}
	});

	test("a question the request asked keeps it open until the answer wakes the agent", async () => {
		const { chain, calls, settle } = harness();
		const t = chain.openTyped()!;
		chain.arrive([t]);
		await settle();
		chain.recordLaunch(questionKey("q1"), chain.launchSnapshot());
		chain.endTurn();
		await settle();
		assert.equal(calls.filter((call) => call.action === "close").length, 0);
		chain.wake([{ key: questionKey("q1"), terminal: true }]);
		assert.equal(chain.currentRequestId(), t);
		chain.endTurn();
		await settle();
		assert.equal(calls.filter((call) => call.action === "close").length, 1);
	});

	test("shutdown closes what has nothing pending and keeps a request whose work is still to wake", async () => {
		const { chain, calls, settle } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		chain.arrive([a]);
		await settle();
		chain.recordLaunch(taskKey("job"), chain.launchSnapshot());
		const b = command(chain, DELIVERY_B, MSG_B);
		chain.arrive([b]);
		await settle();
		await chain.shutdown();
		const closed = calls.filter((call) => call.action === "close").map((call) => call.request_id);
		assert.deepEqual(closed, [b]);
		assert.equal(await chain.stamp(), null, "a disposed chain stamps nothing");
	});
});

describe("what a turn and a wake carry", () => {
	test("never infers nobody's request: a wake nothing recorded, an unstated launch or a finished request is unstated", async () => {
		const { chain, settle } = harness();
		chain.wake([{ key: taskKey("stranger"), terminal: true }]);
		assert.equal(await chain.stamp(), null);
		chain.endTurn();

		chain.recordLaunch(taskKey("unknown"), { request: UNSTATED, also: [] });
		chain.wake([{ key: taskKey("unknown"), terminal: true }]);
		assert.equal(await chain.stamp(), null);
		chain.endTurn();

		const a = command(chain, DELIVERY_A, MSG_A);
		chain.arrive([a]);
		chain.recordLaunch(taskKey("gone"), { request: a, also: [] }, { notifies: false });
		chain.endTurn();
		await settle();
		await settle();
		chain.wake([{ key: taskKey("gone"), terminal: true }]);
		assert.equal(chain.currentRequestId(), null);
		assert.equal(await chain.stamp(), null);
	});

	test("is nobody's request only when the launch was made for nobody's", async () => {
		const { chain } = harness();
		chain.recordLaunch(taskKey("own"), { request: NO_REQUEST, also: [] });
		chain.wake([{ key: taskKey("own"), terminal: true }]);
		assert.equal(await chain.stamp(), NO_REQUEST);
	});

	test("records every launch: for the current request, for nobody's when the turn was, and as not known otherwise", async () => {
		const { chain, settle } = harness();
		assert.deepEqual(chain.launchSnapshot(), { request: UNSTATED, also: [] }, "before any input");
		const a = command(chain, DELIVERY_A, MSG_A);
		chain.arrive([a]);
		assert.deepEqual(chain.launchSnapshot(), { request: a, also: [] });
		chain.endTurn();
		chain.arriveUnknown();
		assert.deepEqual(chain.launchSnapshot(), { request: UNSTATED, also: [] });
		assert.equal(chain.serve({ none: true }).ok, true);
		assert.deepEqual(chain.launchSnapshot(), { request: NO_REQUEST, also: [] });
		await settle();
	});

	test("a command or prompt DevSpec could not open clears the current request, never keeps the previous one", async () => {
		const { chain, settle } = harness({ refuse: (args) => args.provenance_ref === DELIVERY_B });
		chain.arrive([command(chain, DELIVERY_A, MSG_A)]);
		await settle();
		assert.ok(await chain.stamp());
		chain.arrive([command(chain, DELIVERY_B, MSG_B)]);
		await settle();
		assert.equal(await chain.stamp(), null);
		assert.equal(await chain.ambiguity(), null, "an unopened request is not carried");
		chain.endTurn();
		chain.arrive([]);
		assert.equal(await chain.stamp(), null, "a turn whose request has no id stamps nothing");
	});

	test("an automation run or an unknown wake mid-turn clears the current request", async () => {
		const { chain, settle } = harness();
		chain.arrive([chain.openTyped()!]);
		await settle();
		assert.ok(await chain.stamp());
		chain.arriveUnknown();
		assert.equal(await chain.stamp(), null);
	});

	test("another extension's message changes nothing mid-turn and names nothing when it starts one", async () => {
		const { chain, settle } = harness();
		const t = chain.openTyped()!;
		chain.arrive([t]);
		chain.arriveUntyped();
		assert.equal(chain.currentRequestId(), t);
		chain.endTurn();
		await settle();
		chain.arriveUntyped();
		assert.equal(await chain.stamp(), null);
	});

	test("a launch's subagent directory finds its launch; terminal keys only release it", async () => {
		const { chain, calls, settle } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		chain.arrive([a]);
		chain.recordLaunch(subagentKey("run1"), chain.launchSnapshot(), { aliases: ["/tmp/async/run1"] });
		chain.endTurn();
		await settle();
		chain.wake([{ key: subagentKey("run1"), terminal: false }]);
		assert.equal(chain.currentRequestId(), a, "a workflow child continues its launch");
		chain.endTurn();
		await settle();
		assert.equal(calls.filter((call) => call.action === "close").length, 0, "the workflow is still running");
		chain.wake([{ key: "/tmp/async/run1", terminal: true }]);
		assert.equal(chain.currentRequestId(), a);
		chain.endTurn();
		await settle();
		assert.equal(calls.filter((call) => call.action === "close").length, 1);
	});
});

describe("when a write must say whose request it serves", () => {
	test("one person's two commands have one answer", async () => {
		const { chain } = harness();
		chain.arrive([command(chain, DELIVERY_A, MSG_A)]);
		chain.arrive([command(chain, DELIVERY_C, MSG_C)]);
		assert.equal(await chain.ambiguity(), null);
	});

	test("two people's requests in one turn do not, until the agent names one", async () => {
		const { chain, calls } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		const b = command(chain, DELIVERY_B, MSG_B);
		chain.arrive([a]);
		chain.arrive([b]);
		assert.deepEqual((await chain.ambiguity())!.map((entry) => entry.id), [a, b]);
		assert.deepEqual(chain.serve({ messageId: MSG_B }), { ok: true, serving: `the room command with message_id ${MSG_B}` });
		assert.equal(await chain.ambiguity(), null);
		assert.equal(await chain.stamp(), calls.find((call) => call.provenance_ref === DELIVERY_B)!.request_id);
	});

	test("several commands in one delivery: the newest wakes it and the rest join", async () => {
		const { chain } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		const b = command(chain, DELIVERY_B, MSG_B);
		chain.arrive([a, b]);
		assert.equal(chain.currentRequestId(), b);
		assert.deepEqual((await chain.ambiguity())!.map((entry) => entry.id), [b, a]);
	});

	test("a person at the terminal and the same person in a room are recorded differently", async () => {
		const { chain } = harness();
		chain.arrive([chain.openTyped()!]);
		chain.arrive([command(chain, DELIVERY_A, MSG_A)]);
		assert.deepEqual((await chain.ambiguity())!.map((entry) => entry.kind), ["typed_prompt", "command"]);
	});

	test("a turn woken for nobody's request that a command then reaches carries both", async () => {
		const { chain } = harness();
		chain.recordLaunch(taskKey("own"), { request: NO_REQUEST, also: [] });
		chain.wake([{ key: taskKey("own"), terminal: true }]);
		const b = command(chain, DELIVERY_B, MSG_B);
		chain.arrive([b]);
		assert.deepEqual((await chain.ambiguity())!.map((entry) => entry.id), [NO_REQUEST, b]);
	});

	test("a new arrival undoes a choice, and a new turn clears what joined the last one", async () => {
		const { chain } = harness();
		chain.arrive([command(chain, DELIVERY_A, MSG_A)]);
		chain.arrive([command(chain, DELIVERY_B, MSG_B)]);
		chain.serve({ messageId: MSG_A });
		assert.equal(await chain.ambiguity(), null);
		chain.arrive([chain.openTyped()!]);
		assert.ok(await chain.ambiguity());
		chain.endTurn();
		chain.arrive([command(chain, DELIVERY_B, MSG_B)]);
		assert.equal(await chain.ambiguity(), null);
	});

	test("launched while the turn carries two people's requests, its wake carries both again and both stay open", async () => {
		const { chain, calls, settle } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		const b = command(chain, DELIVERY_B, MSG_B);
		chain.arrive([a]);
		chain.arrive([b]);
		await settle();
		const snapshot = chain.launchSnapshot();
		assert.deepEqual(snapshot, { request: a, also: [b] });
		chain.recordLaunch(taskKey("job"), snapshot);
		chain.endTurn();
		await settle();
		assert.equal(calls.filter((call) => call.action === "close").length, 0, "Stop keeps every request the job carried");
		chain.wake([{ key: taskKey("job"), terminal: true }]);
		assert.equal(chain.currentRequestId(), a);
		assert.deepEqual((await chain.ambiguity())!.map((entry) => entry.id), [a, b]);
	});

	test("serve names a command by message id, the terminal prompt, or nobody, and refuses anything else", () => {
		const { chain } = harness();
		const a = command(chain, DELIVERY_A, MSG_A);
		const t = chain.openTyped()!;
		chain.arrive([a]);
		assert.equal(chain.serve({ messageId: MSG_A }).ok, true);
		assert.equal(chain.currentRequestId(), a);
		assert.equal(chain.serve({ terminal: true }).ok, true);
		assert.equal(chain.currentRequestId(), t);
		assert.equal(chain.serve({ none: true }).ok, true);
		assert.equal(chain.currentRequestId(), null);
		assert.equal(chain.serve({ messageId: MSG_B }).ok, false);
		assert.equal(chain.serve({ terminal: true, none: true }).ok, false);
		assert.equal(chain.serve({}).ok, false);
	});
});

describe("stamping a DevSpec write", () => {
	const declared = { type: "object", properties: { title: { type: "string" }, request_ref: { type: "string", "x-devspec-host-only": true } } };
	const undeclared = { type: "object", properties: { title: { type: "string" } } };

	test("stamps only where the wire schema takes request_ref, and nothing when nothing is known", async () => {
		const { chain } = harness();
		installRequestChain(chain);
		try {
			chain.arrive([command(chain, DELIVERY_A, MSG_A)]);
			const stamped = await stampRequestRef({ params: { title: "x" }, inputSchema: declared, connectionId: CONN });
			assert.ok("args" in stamped && typeof stamped.args.request_ref === "string");
			assert.deepEqual(await stampRequestRef({ params: { title: "x" }, inputSchema: undeclared, connectionId: CONN }), { args: { title: "x" } });
			assert.deepEqual(await stampRequestRef({ params: { title: "x" }, inputSchema: declared, connectionId: "other" }), { args: { title: "x" } });
			chain.endTurn();
			chain.arriveUnknown();
			assert.deepEqual(await stampRequestRef({ params: { title: "x" }, inputSchema: declared, connectionId: CONN }), { args: { title: "x" } });
		} finally { installRequestChain(null); }
	});

	test("stamps nobody's request as none, and leaves a call that already names a request as written", async () => {
		const { chain } = harness();
		installRequestChain(chain);
		try {
			chain.serve({ none: true });
			assert.deepEqual(await stampRequestRef({ params: {}, inputSchema: declared, connectionId: CONN }), { args: { request_ref: NO_REQUEST } });
			assert.deepEqual(await stampRequestRef({ params: { request_ref: "x" }, inputSchema: declared, connectionId: CONN }), { args: { request_ref: "x" } });
		} finally { installRequestChain(null); }
	});

	test("refuses a write that could serve two people's requests, naming how to choose, unless it cites its work or command", async () => {
		const { chain } = harness();
		installRequestChain(chain);
		try {
			chain.arrive([command(chain, DELIVERY_A, MSG_A)]);
			chain.arrive([command(chain, DELIVERY_B, MSG_B)]);
			const refused = await stampRequestRef({ params: {}, inputSchema: declared, connectionId: CONN });
			assert.ok("deny" in refused);
			assert.match(refused.deny, /more than one person/);
			assert.match(refused.deny, new RegExp(`${SERVE_REQUEST_TOOL} with message_id "${MSG_A}"`));
			assert.match(refused.deny, new RegExp(`${SERVE_REQUEST_TOOL} with message_id "${MSG_B}"`));
			assert.ok("args" in await stampRequestRef({ params: {}, inputSchema: undeclared, connectionId: CONN }), "a read is never refused");
			assert.ok("args" in await stampRequestRef({ params: { work_claim_ref: "w" }, inputSchema: declared, connectionId: CONN }));
			assert.ok("args" in await stampRequestRef({ params: { provenance_ref: DELIVERY_B }, inputSchema: declared, connectionId: CONN }));
			chain.serve({ messageId: MSG_B });
			assert.ok("args" in await stampRequestRef({ params: {}, inputSchema: declared, connectionId: CONN }));
		} finally { installRequestChain(null); }
	});

	test("the refusal lists the terminal prompt and nobody's request with their own instructions", () => {
		const text = ambiguityRefusal([{ id: NO_REQUEST, kind: "none", current: true }, { id: "t", kind: "typed_prompt", current: false }]);
		assert.match(text, /none: true/);
		assert.match(text, /terminal: true/);
	});

	test("the tools that take a request come from the served catalogue: the 31 work-claim provenance writes", () => {
		const takes = MCP_CATALOG.filter((entry) => declaresRequestRef(entry.inputSchema)).map((entry) => entry.name);
		assert.equal(takes.length, 31);
		for (const name of ["post_session_message", "reserve_work_items", "claim_work_item", "report_request", "get_action_item"]) {
			assert.ok(!takes.includes(name), name);
		}
		for (const name of ["record_implementation", "update_action_item", "create_action_item", "record_memory"]) assert.ok(takes.includes(name), name);
		for (const entry of MCP_CATALOG) {
			assert.ok(!("request_ref" in ((entry.modelInputSchema.properties ?? {}) as Record<string, unknown>)), `${entry.name} hides request_ref from the model`);
		}
	});

	test("serve_request is shown only while it can matter", () => {
		assert.deepEqual(withServeRequestToolActive(["read"], true), ["read", SERVE_REQUEST_TOOL]);
		assert.deepEqual(withServeRequestToolActive(["read", SERVE_REQUEST_TOOL], false), ["read"]);
	});
});

describe("launch and wake shapes", () => {
	test("background launches record every task, and notice whether its end notifies", () => {
		const receipt = (task: Record<string, unknown>) => ({ details: { task } });
		assert.deepEqual(backgroundLaunch("bg_run", receipt({ id: "t1", startTime: 1, status: "running", notifyOnCompletion: true, triggerOnCompletion: true })), { id: "t1", notifies: true });
		assert.deepEqual(backgroundLaunch("bg_run", receipt({ id: "t2", startTime: 1, status: "running" })), { id: "t2", notifies: false });
		assert.equal(backgroundLaunch("bg_logs", receipt({ id: "t3", startTime: 1, status: "running" })), null, "inspection is not a launch");
		assert.equal(backgroundLaunch("bg_run", receipt({ id: "t4", startTime: 1, status: "running" }), true), null);
	});

	test("async subagents, directed questions and their cancellations", () => {
		assert.deepEqual(subagentLaunch("subagent", { details: { asyncId: "run1", asyncDir: "/d/run1" } }), { id: "run1", aliases: ["/d/run1"] });
		assert.equal(subagentLaunch("subagent", { details: { results: [] } }), null, "a foreground run left nothing running");
		const q = "33333333-3333-4333-8333-333333333333";
		assert.equal(askedQuestionId("manage_directed_question", { action: "create" }, { details: { question: { id: q } } }), q);
		assert.equal(askedQuestionId("manage_directed_question", { action: "cancel" }, { details: { question: { id: q } } }), null);
		assert.equal(cancelledQuestionId("manage_directed_question", { action: "cancel", question_id: q }), q);
	});

	test("wakes name their work: tasks by id whatever the status, subagent runs, workflow children, question answers", () => {
		const q = "33333333-3333-4333-8333-333333333333";
		const xml = "<background-task-notification><task-id>t1</task-id><status>completed</status></background-task-notification>";
		assert.deepEqual(backgroundNotificationTask(xml), { id: "t1", terminal: true });
		assert.deepEqual(backgroundNotificationTask("", { task: { id: "t2", status: "running" } }), { id: "t2", terminal: false });
		assert.equal(backgroundNotificationTask("plain text"), null);
		assert.deepEqual(wakeKeys({ text: xml, task: { id: "t1", terminal: true } }), [{ key: taskKey("t1"), terminal: true }]);
		assert.deepEqual(wakeKeys({ text: "Background task completed: **worker**\n\nok", customType: "subagent-notify",
			details: { runs: [{ runId: "run1", status: "completed" }, { runId: "run2", status: "paused" }] } }),
		[{ key: subagentKey("run1"), terminal: true }, { key: subagentKey("run2"), terminal: false }]);
		assert.deepEqual(wakeKeys({ text: "Workflow child completed: **a**\nWorkflow run: wf1\nStatus: workflow still running", customType: "subagent-incremental-child-notify" }),
			[{ key: subagentKey("wf1"), terminal: false }]);
		assert.deepEqual(wakeKeys({ text: "Background task completed: **worker**\n\nRetention-managed async directory: /d/run1", known: ["/d/run1"] }),
			[{ key: "/d/run1", terminal: true }]);
		const types = ["devspec-directed-question-answer"];
		assert.deepEqual(wakeKeys({ text: "answer", customType: types[0], details: { event: { question_id: q } }, questionCustomTypes: types }), [{ key: questionKey(q), terminal: true }]);
	});
});

describe("the journal keeps launches across /reload", () => {
	test("a reloaded chain re-opens each launch's request and continues it on the wake", async () => {
		const first = harness();
		const a = command(first.chain, DELIVERY_A, MSG_A);
		first.chain.arrive([a]);
		first.chain.recordLaunch(taskKey("job"), first.chain.launchSnapshot(), { notifies: true });
		first.chain.recordLaunch(taskKey("own"), { request: NO_REQUEST, also: [] });
		first.chain.recordLaunch(taskKey("done"), first.chain.launchSnapshot());
		first.chain.wake([{ key: taskKey("done"), terminal: true }]);
		const entries = first.journal.map((data) => ({ type: "custom", customType: REQUEST_LINK_ENTRY,
			data: { version: 1, nativeSessionId: "native", connectionId: CONN, ...data } }));
		entries.push({ type: "custom", customType: REQUEST_LINK_ENTRY, data: { version: 1, nativeSessionId: "other", connectionId: CONN, key: taskKey("x"), request: NO_REQUEST } as never });

		const second = harness();
		assert.equal(second.chain.restore(entries, "native"), 2, "the finished launch and another conversation's are not restored");
		await second.settle();
		assert.deepEqual(second.calls.map(({ action, request_id, provenance_ref }) => ({ action, request_id, provenance_ref })),
			[{ action: "open", request_id: a, provenance_ref: DELIVERY_A }], "re-opened by its own id to learn its state");
		second.chain.wake([{ key: taskKey("job"), terminal: true }]);
		assert.equal(second.chain.currentRequestId(), a);
		assert.equal(await second.chain.stamp(), a);
		second.chain.endTurn();
		second.chain.wake([{ key: taskKey("own"), terminal: true }]);
		assert.equal(await second.chain.stamp(), NO_REQUEST);
	});

	test("a request the server reports closed after reload is never stamped", async () => {
		const first = harness();
		const a = command(first.chain, DELIVERY_A, MSG_A);
		first.chain.arrive([a]);
		first.chain.recordLaunch(taskKey("job"), first.chain.launchSnapshot());
		const entries = first.journal.map((data) => ({ type: "custom", customType: REQUEST_LINK_ENTRY,
			data: { version: 1, nativeSessionId: "native", connectionId: CONN, ...data } }));
		const second = harness({ closed: new Set([a]) });
		second.chain.restore(entries, "native");
		await second.settle();
		second.chain.wake([{ key: taskKey("job"), terminal: true }]);
		assert.equal(await second.chain.stamp(), null);
	});

	test("the journal row is a strict allowlist", () => {
		const row = { version: 1, nativeSessionId: "n", connectionId: CONN, key: "task:x", request: NO_REQUEST };
		assert.ok(parseRequestLinkEntry(row));
		assert.equal(parseRequestLinkEntry({ ...row, prompt: "secret" }), null);
		assert.equal(parseRequestLinkEntry({ ...row, request: { id: "not-a-uuid", kind: "typed_prompt" } }), null);
		assert.equal(parseRequestLinkEntry({ ...row, request: { id: CONN, kind: "command" } }), null, "a command needs its provenance_ref");
		assert.equal(parseRequestLinkEntry({ ...row, request: "someone" }), null);
	});
});

describe("which input the owner typed", () => {
	test("interactive and RPC input is typed; the extension's own sends are not, unless marked", () => {
		const ledger = new TypedInputLedger();
		ledger.noteInput({ text: "typed", source: "interactive" });
		assert.equal(ledger.takeForMessage("typed"), true);
		ledger.noteInput({ text: "rpc", source: "rpc" });
		assert.equal(ledger.takeForMessage("rpc"), true);
		ledger.noteInput({ text: "DevSpec recovery: continue", source: "extension", streamingBehavior: "followUp" });
		assert.equal(ledger.takeForMessage("DevSpec recovery: continue"), false);
		ledger.markTyped("/devspec.work prompt");
		ledger.noteInput({ text: "/devspec.work prompt", source: "extension" });
		assert.equal(ledger.takeForMessage("/devspec.work prompt"), true);
	});

	test("a typed template Pi expanded still counts; an untyped send never takes a typed record", () => {
		const ledger = new TypedInputLedger();
		ledger.noteInput({ text: "/review", source: "interactive" });
		ledger.noteInput({ text: "extension text", source: "extension", streamingBehavior: "followUp" });
		assert.equal(ledger.takeForMessage("extension text"), false);
		assert.equal(ledger.takeForMessage("Review the diff below…"), true);
		assert.equal(ledger.takeForMessage("anything else"), false);
	});

	test("automation runs and commands drop their own record and never consume a typed one", () => {
		const ledger = new TypedInputLedger();
		ledger.noteInput({ text: "[DevSpec remote — automation run] go", source: "extension" });
		ledger.noteInput({ text: "typed while running", source: "interactive", streamingBehavior: "steer" });
		ledger.dropForMessage("[DevSpec remote — automation run] go");
		assert.equal(ledger.pending(), 1);
		assert.equal(ledger.takeForMessage("typed while running"), true);
	});

	test("an idle input supersedes an older idle record nobody consumed; a settled run expires the rest", () => {
		const ledger = new TypedInputLedger();
		ledger.noteInput({ text: "swallowed by another handler", source: "interactive" });
		ledger.noteInput({ text: "extension send", source: "extension" });
		assert.equal(ledger.takeForMessage("something untyped"), false, "the stale typed record is gone");
		ledger.noteInput({ text: "queued", source: "interactive", streamingBehavior: "followUp" });
		ledger.expire();
		assert.equal(ledger.pending(), 0);
	});
});
