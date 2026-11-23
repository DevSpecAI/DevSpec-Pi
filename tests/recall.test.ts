import assert from "node:assert/strict";
import { test } from "node:test";
import registerMemory, { type MemoryDeps } from "../extensions/devspec-memory.ts";
import {
	RECALL_SEEN_KEYS_PER_REQUEST,
	automationRunText,
	isScopeMiss,
	readTurnRecall,
	recallTurn,
	remoteCommandText,
	seenRecallKeys,
	turnRecallUrl,
} from "../extensions/core/recall.ts";
import { formatInboundBundleMessage } from "../extensions/core/remote-payload.ts";
import { formatAutomationRunMessage } from "../extensions/core/dispatch.ts";
import { setBond } from "../extensions/core/bond-state.ts";

const PROMPT = "How should we structure the webhook retry logic for failed deliveries?";

// A server answer carrying every lane, plus one no plugin has heard of (decision 3ea02bd2:
// a later lane such as environment entries reaches the model with no plugin release).
const BLOCK = [
	"== PROACTIVE PROJECT RECALL ==",
	"Project records surfaced automatically for this turn.",
	"- [REQUIREMENT · binding] Retries are idempotent (req-1) — read get_resource({ id: \"doc-9\" }) in full",
	"- [RUNBOOK] Webhook replay routine (doc-2)",
	"- [MEMORY · decision] Exponential backoff with jitter (mem-3)",
	"- [BRIEF · active] Delivery reliability (brief-4)",
	"- [TASK · dismissed:not_wanted] Drop failed webhooks silently (task-5) — rejected: customers lose events",
	"- [TASK · done] Shipped retry queue (task-6) — past shipped work; verify against live code",
	"- [ENVIRONMENT · staging] Webhook relay host (env-7)",
].join("\n");
const KEYS = ["requirement:req-1:v1", "document:doc-2:v3", "memory:mem-3:v2", "brief:brief-4:v1", "task:task-5:v4", "task:task-6:v9", "environment_entry:env-7:v1"];

function answer(block = BLOCK, keys = KEYS, status = 200): Response {
	return new Response(JSON.stringify({ version: 1, formatted_block: block, cards: keys.map((dedupe_key) => ({ dedupe_key })), seen_keys: keys }), { status });
}

interface Call { url: string; init: RequestInit; body: Record<string, any> }

function harness(overrides: Partial<MemoryDeps> = {}, respond: (call: Call) => Promise<Response> | Response = () => answer()) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<any>>();
	const calls: Call[] = [];
	const branch: unknown[] = [];
	registerMemory(
		{ on: (name: string, handler: any) => handlers.set(name, handler), registerCommand() {} } as never,
		{
			resolveToken: async () => ({ token: "secret-token-abc" }),
			getBond: () => null,
			resolveEndpoint: async () => "https://api.devspec.test/api/mcp?model_tools=x",
			folderScope: async () => ({ git_remote: "git@github.com:acme/app.git" }),
			fetch: async (url: string, init: RequestInit) => {
				const call = { url, init, body: JSON.parse(String(init.body)) };
				calls.push(call);
				return respond(call);
			},
			...overrides,
		},
	);
	const handler = handlers.get("before_agent_start")!;
	const ctx = { cwd: "/project", sessionManager: { getSessionId: () => "conv-1", getBranch: () => branch } };
	/** Run one turn; what it injects is appended to the branch as Pi persists it. */
	const turn = async (event: unknown) => {
		const out = await handler(event, ctx);
		if (out?.message) branch.push({ type: "custom_message", id: `e${branch.length}`, ...out.message });
		else branch.push({ type: "message", id: `e${branch.length}` });
		return out;
	};
	return { calls, branch, turn };
}

const typed = (prompt: string) => ({ type: "before_agent_start", messageType: "user", prompt });

test("only a substantive request is recalled: no prompt, short, slash and DevSpec's own runs make no call", () => {
	assert.deepEqual(recallTurn({ messageType: "custom" }), { recall: false, reason: "no_typed_prompt" });
	assert.deepEqual(recallTurn({ messageType: "user" }), { recall: false, reason: "no_typed_prompt" });
	assert.deepEqual(recallTurn(undefined), { recall: false, reason: "no_typed_prompt" });
	assert.equal(recallTurn(typed("ok")).recall, false);
	assert.equal(recallTurn(typed("yes do it now")).recall, false, "17 characters is an acknowledgement");
	assert.equal(recallTurn(typed("/devspec.work e10f3ad1 — work this item please")).recall, false);
	assert.equal(recallTurn(typed("[DevSpec remote — check job to Calm Osprey]\nRule these entries carefully please")).recall, false);
	assert.equal(recallTurn(typed("[DevSpec directed-question workflow continuation]\nThe person answered your question")).recall, false);
	assert.equal(recallTurn(typed("### DevSpec memory — auto-recall\nleftover context block text")).recall, false);
	assert.deepEqual(recallTurn(typed(PROMPT)), { recall: true, query: PROMPT, source: "local" });
	assert.deepEqual(recallTurn(typed("explain the retry queue")), { recall: true, query: "explain the retry queue", source: "local" });
});

test("a DevSpec command is recalled on its exact text, never its framing or delegated scope instruction", () => {
	const command = (id: string, text: string, scoped = false) => ({
		id, text, requester: { display_name: "Ali Price", user_id: "u1" }, addressee: { label: "Calm Osprey" },
		...(scoped ? { project_scope: { instruction: "SCOPE_INSTRUCTION only touch project X" } } : {}),
	});
	const message = formatInboundBundleMessage({
		commandTurnId: "turn-1",
		primaryCommand: command("m1", PROMPT),
		commands: [command("m1", PROMPT), command("m2", "And add a dead-letter queue for the poison ones.", true)],
	} as never);
	assert.match(message, /^\[DevSpec remote — message from Ali Price/);
	const turn = recallTurn(typed(message));
	assert.equal(turn.recall, true);
	assert.equal(turn.recall && turn.source, "remote");
	assert.equal(turn.recall && turn.query, `${PROMPT}\n\nAnd add a dead-letter queue for the poison ones.`);
	assert.doesNotMatch(remoteCommandText(message), /SCOPE_INSTRUCTION|canonical turn|--- /);
	assert.equal(recallTurn(typed("[DevSpec remote — message from Ali Price to Calm Osprey · canonical turn:t]\n--- command 1/1 · message:m · from Ali · to Calm ---\nok\n--- end command:m ---")).recall, false);
});

test("an automation run is recalled on the automation's name, the only words of its own the wake carries", () => {
	const envelope = (name: string) => ({
		id: "run-1", kind: "automation_run", run_id: "run-1", automation_id: "automation-1", automation_name: name,
		trigger_kind: "event", owner: { user_id: "owner-1", display_name: "Ali Price" }, permission: "look_only",
		queued_at: "2026-08-20T12:00:00.000Z", delivery_connection_id: "conn-1", requester: null,
	});
	const message = formatAutomationRunMessage(envelope("Nightly dependency advisory audit"), "Calm Osprey");
	assert.equal(automationRunText(message), "Nightly dependency advisory audit");
	assert.deepEqual(recallTurn(typed(message)), { recall: true, query: "Nightly dependency advisory audit", source: "automation" });
	assert.equal(recallTurn(typed(formatAutomationRunMessage(envelope("Deploy recovery"), "Calm Osprey"))).recall, false, "a short name is not worth a recall");
});

test("seen keys come from this branch's recall messages, newest first, and stop where compaction summarised them away", () => {
	const recall = (id: string, keys: unknown) => ({ type: "custom_message", id, customType: "devspec-proactive", details: { dedupeKeys: keys } });
	const branch = [
		recall("a", ["memory:old:v1"]),
		{ type: "message", id: "kept" },
		recall("b", ["memory:kept:v1"]),
		{ type: "compaction", id: "c", firstKeptEntryId: "kept" },
		recall("d", ["task:new:v2", 42, ""]),
		{ type: "custom_message", id: "e", customType: "devspec-repository-context", details: { dedupeKeys: ["memory:other:v1"] } },
		recall("f", ["memory:newest:v3"]),
	];
	assert.deepEqual(seenRecallKeys(branch), ["memory:newest:v3", "task:new:v2", "memory:kept:v1"]);
	assert.deepEqual(seenRecallKeys([recall("a", ["memory:x:v1"]), { type: "compaction", id: "c" }]), [], "a compaction with nothing kept ends the scan");
	assert.deepEqual(seenRecallKeys(undefined), []);
	const many = Array.from({ length: 600 }, (_, i) => recall(`r${i}`, [`memory:m${i}:v1`]));
	const capped = seenRecallKeys(many);
	assert.equal(capped.length, RECALL_SEEN_KEYS_PER_REQUEST);
	assert.equal(capped[0], "memory:m599:v1", "the newest keys are the ones kept");
});

test("the endpoint sits beside the MCP endpoint, without its query", () => {
	assert.equal(turnRecallUrl("https://api.devspecstaging.com/api/mcp?model_tools=a,b"), "https://api.devspecstaging.com/api/mcp/turn-recall");
	assert.equal(turnRecallUrl("https://api.devspec.ai/api/mcp/"), "https://api.devspec.ai/api/mcp/turn-recall");
});

test("DevSpec's block is taken verbatim, whatever lanes it carries; an empty block is nothing", () => {
	assert.deepEqual(readTurnRecall({ formatted_block: BLOCK, seen_keys: KEYS, cards: KEYS.map((k) => ({ dedupe_key: k })) }), { block: BLOCK, keys: KEYS, cards: KEYS.length });
	assert.deepEqual(readTurnRecall({ formatted_block: "B", cards: [{ dedupe_key: "memory:a:v1" }, { seenKey: "task:b:v2" }] })?.keys, ["memory:a:v1", "task:b:v2"]);
	assert.equal(readTurnRecall({ formatted_block: "", cards: [], seen_keys: [] }), null);
	assert.equal(readTurnRecall(null), null);
	assert.equal(isScopeMiss(400, "project_required"), true);
	assert.equal(isScopeMiss(400, "project_choice_required"), true);
	assert.equal(isScopeMiss(400, "project_selection_unavailable"), false);
	assert.equal(isScopeMiss(400, "invalid_request"), false);
	assert.equal(isScopeMiss(503, "project_required"), false);
});

test("a turn adds DevSpec's block at the tail with its keys, and the next turn sends them back so nothing repeats", async () => {
	const h = harness({}, ({ body }) => body.seen_versions.length === 0 ? answer() : answer("", []));
	const first = await h.turn(typed(PROMPT));
	assert.equal(first.systemPrompt, undefined, "never the system prompt");
	assert.equal(first.message.customType, "devspec-proactive");
	assert.equal(first.message.display, false);
	assert.equal(first.message.content, BLOCK, "verbatim, including a lane no plugin knows");
	assert.deepEqual(first.message.details, { dedupeKeys: KEYS });

	const [call] = h.calls;
	assert.equal(call!.url, "https://api.devspec.test/api/mcp/turn-recall");
	assert.equal(call!.init.method, "POST");
	assert.deepEqual(call!.body, { query: PROMPT, host: "pi", conversation_id: "conv-1", git_remote: "git@github.com:acme/app.git", seen_versions: [] });
	const headers = call!.init.headers as Record<string, string>;
	assert.equal(headers.authorization, "Bearer secret-token-abc");
	assert.match(headers["x-devspec-plugin"] ?? "", /^pi\//);

	const second = await h.turn(typed(PROMPT));
	assert.equal(second, undefined, "nothing new: no message at all");
	assert.deepEqual(h.calls[1]!.body.seen_versions, [...KEYS].reverse());
	assert.ok(!JSON.stringify(h.calls.map((c) => c.body)).includes("secret-token-abc"), "the token is never in a body");
	assert.ok(!JSON.stringify(first.message).includes("secret-token-abc"), "nor in model context");
});

test("an edited record comes back as its new version", async () => {
	let version = 1;
	const h = harness({}, ({ body }) => {
		const key = `memory:mem-3:v${version}`;
		return body.seen_versions.includes(key) ? answer("", []) : answer(`== PROACTIVE PROJECT RECALL ==\n- v${version}`, [key]);
	});
	assert.match((await h.turn(typed(PROMPT))).message.content, /v1/);
	assert.equal(await h.turn(typed(PROMPT)), undefined);
	version = 2;
	const changed = await h.turn(typed(PROMPT));
	assert.match(changed.message.content, /v2/);
	assert.deepEqual(changed.message.details.dedupeKeys, ["memory:mem-3:v2"]);
});

test("a run started by a DevSpec notice does no recall and raises no error (task a4b24107)", async () => {
	const h = harness();
	const noticeRun = {
		type: "before_agent_start",
		messageType: "custom",
		message: { customType: "devspec-system-notice", content: "[DevSpec system notice v1]", display: true },
		systemPrompt: "",
		systemPromptOptions: {},
	};
	assert.equal(await h.turn(noticeRun), undefined);
	assert.equal(await h.turn(typed("ok")), undefined);
	assert.equal(h.calls.length, 0, "no recall for a turn nobody typed, nor an acknowledgement");
	await h.turn(typed(PROMPT));
	assert.equal(h.calls.length, 1, "a typed substantive prompt still recalls");
});

test("fails open: a thrown fetch, a server error or the deadline add nothing and record nothing", async () => {
	for (const respond of [
		() => { throw new TypeError("fetch failed"); },
		() => answer(BLOCK, KEYS, 500),
		() => new Response("not json", { status: 200 }),
	]) {
		const h = harness({}, respond);
		assert.equal(await h.turn(typed(PROMPT)), undefined);
		assert.equal(h.branch.filter((e: any) => e.customType === "devspec-proactive").length, 0);
	}
	const hung = harness({ timeoutMs: 50 }, ({ init }) => new Promise<Response>((_, reject) => {
		init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
	}));
	const started = Date.now();
	assert.equal(await hung.turn(typed(PROMPT)), undefined);
	assert.ok(Date.now() - started < 1_000, "the turn is not held past the budget");
	const neverSettles = harness({ timeoutMs: 50 }, () => new Promise<Response>(() => {}));
	const t0 = Date.now();
	assert.equal(await neverSettles.turn(typed(PROMPT)), undefined);
	assert.ok(Date.now() - t0 < 1_000, "even a request that ignores its abort cannot hold the turn");
	const slowSignIn = harness({ timeoutMs: 50, resolveToken: () => new Promise(() => {}) });
	assert.equal(await slowSignIn.turn(typed(PROMPT)), undefined);
	assert.equal(slowSignIn.calls.length, 0);
});

test("logged out, or no project evident here, makes no call", async () => {
	const loggedOut = harness({ resolveToken: async () => null });
	assert.equal(await loggedOut.turn(typed(PROMPT)), undefined);
	assert.equal(loggedOut.calls.length, 0);
	const nowhere = harness({ folderScope: async () => ({}) });
	assert.equal(await nowhere.turn(typed(PROMPT)), undefined);
	assert.equal(nowhere.calls.length, 0);
});

test("a scope DevSpec cannot place is not asked again in this conversation; another scope, or a passing failure, is", async () => {
	let pin = "";
	const h = harness(
		{ folderScope: async () => pin ? { pinned_project_id: pin } : { git_remote: "git@github.com:acme/unknown.git" } },
		() => new Response(JSON.stringify({ error: "x", code: "project_required" }), { status: 400 }),
	);
	await h.turn(typed(PROMPT));
	await h.turn(typed(PROMPT));
	assert.equal(h.calls.length, 1, "the same scope is a known miss");
	pin = "6c3b2f6e-0d8f-4a43-9b9f-2f4a3c1d0e11";
	await h.turn(typed(PROMPT));
	assert.equal(h.calls.length, 2, "a new pin is a new scope");

	const transient = harness({}, () => new Response(JSON.stringify({ code: "project_selection_unavailable" }), { status: 400 }));
	await transient.turn(typed(PROMPT)); await transient.turn(typed(PROMPT));
	assert.equal(transient.calls.length, 2, "a passing failure is asked again");
	const down = harness({}, () => new Response("{}", { status: 503 }));
	await down.turn(typed(PROMPT)); await down.turn(typed(PROMPT));
	assert.equal(down.calls.length, 2, "an outage is never remembered as a miss");
});

test("a bonded conversation sends its capability as a header only, with its project and room", async () => {
	setBond({ connectionId: "conn-1", projectId: "proj-1", sessionId: "sess-1", connectionCapability: "dvsc_capabilityvalue_1234567890" });
	try {
		const { getBond } = await import("../extensions/core/bond-state.ts");
		const h = harness({ getBond, folderScope: async () => { throw new Error("folder facts are not needed when bonded"); } });
		const out = await h.turn(typed(PROMPT));
		assert.equal(out.message.content, BLOCK);
		const call = h.calls[0]!;
		assert.deepEqual(call.body, { query: PROMPT, host: "pi", conversation_id: "conv-1", project_id: "proj-1", session_id: "sess-1", seen_versions: [] });
		assert.equal((call.init.headers as Record<string, string>)["x-devspec-connection-capability"], "dvsc_capabilityvalue_1234567890");
		assert.ok(!JSON.stringify(call.body).includes("dvsc_"), "the capability is never a body field");
		assert.ok(!out.message.content.includes("dvsc_"));
	} finally {
		setBond(null);
	}
});

test("a remote command is recalled once, on its text, through the same hook", async () => {
	const h = harness();
	const message = formatInboundBundleMessage({
		commandTurnId: "turn-9",
		primaryCommand: { id: "m9", text: PROMPT, requester: { display_name: "Ali Price", user_id: "u" }, addressee: { label: "Calm Osprey" } },
		commands: [{ id: "m9", text: PROMPT, requester: { display_name: "Ali Price", user_id: "u" }, addressee: { label: "Calm Osprey" } }],
	} as never);
	const out = await h.turn(typed(message));
	assert.equal(out.message.content, BLOCK);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0]!.body.query, PROMPT);
});
