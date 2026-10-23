import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, test } from "node:test";
import { callDevspec, DevspecToolError, resetClientCache, setLaneClientFactoryForTests } from "../extensions/core/client.ts";
import { parsePostSessionReceipt, TrailDeliveryState } from "../extensions/core/post-session-receipt.ts";
import { safeHasUI } from "../extensions/core/ctx-guard.ts";
import { TrailPostFence } from "../extensions/core/question-receipt-lifecycle.ts";
import { setProjectChoice } from "../extensions/core/project-choice.ts";
import { resolveEndpoint } from "../extensions/core/auth-store.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const postSource = source.slice(source.indexOf("function capturePostAuthority()"), source.indexOf("function trackTerminalPost("));
const segmentSource = source.slice(source.indexOf("async function postSegmentAnswer("), source.indexOf("/**\n * Settle the run"));
const tickSource = source.slice(source.indexOf("function trailTick()"), source.indexOf("/**\n * Explicitly close this connection"));
const envelope = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const stored = (phase = "answer") => envelope({ session_id: "session", connection_id: "connection", phase, message_id: "row", delivery: { status: "stored", message_id: "row" } });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

// Execute the actual controller functions with real callDevspec, replacing only
// runtime/transport boundaries. This catches inner transport replay, not just parser behavior.
function harness(call: (args: Record<string, unknown>) => Promise<unknown>) {
	const requests: Record<string, unknown>[] = [];
	const sent = deferred<void>();
	setLaneClientFactoryForTests(async () => ({
		callTool: async ({ arguments: args }) => { requests.push(args!); sent.resolve(); return call(args!); },
		readResource: async () => ({}), close: async () => {},
	}));
	const warnings: string[] = [];
	const logs: Array<[string, unknown]> = [];
	const active = { generation: 1, bond: { connectionId: "connection", sessionId: "session", connectionCapability: "secret-capability" }, stop: false };
	const context = {
		pump: active, lastCtx: { hasUI: true }, turn: null,
		settlePlan: { kind: "none" } as Record<string, unknown>,
		planSettle: () => context.settlePlan, FINAL_TRAIL_CHARS: 1000,
		activeCommandTurnIdentity: { turnId: "command", commandMessageId: "source" },
		getBond: () => active.bond, resolveToken: async () => ({ token: "secret-token" }),
		callDevspec, DevspecToolError, parsePostSessionReceipt, safeHasUI,
		debug: (event: string, fields: unknown) => logs.push([event, fields]),
		notify: (_ctx: unknown, message: string) => warnings.push(message),
		noteCommandTurnClosed: () => { context.activeCommandTurnIdentity = null as never; },
		AGENT_NAME: "Pi", replyModelArgs: () => ({}),
		exactInteractionContinuationArgs: (identity: Record<string, unknown>) => identity,
		remoteRunActivityPolicy: () => ({ reportTranscript: true }),
		nextTrailDelayMs: () => 0, isCommandTurnUnbound: () => false,
		interactionIdentity: () => undefined, console: { error: (message: string) => warnings.push(message) },
	};
	const api = runInNewContext(stripTypeScriptTypes(`${postSource}\n${tickSource}\n${segmentSource}\n({postSegmentAnswer, postToSession, capturePostAuthority, trailTick, setTurn: value => { turn = value; }, setPump: value => { pump = value; }})`), context);
	return { ...api, active, requests, sent: sent.promise, warnings, logs, context };
}

afterEach(() => {
	setLaneClientFactoryForTests(null);
	resetClientCache();
	setProjectChoice("test", null);
	(globalThis as Record<string, unknown>).__devspecPiRateLimit = { until: 0 };
});

const bound = { phase: "answer", commandTurnId: "command", commandMessageId: "source", completeTurn: true };

test("bound MCP rejection and non-error noop each fail once, with identity intact", async () => {
	for (const raw of [
		{ isError: true, content: [{ type: "text", text: "Your message was NOT stored (stale_generation)." }] },
		envelope({ skipped: true, noop: true, reason: "stale_generation", retryable: false }),
	]) {
		const h = harness(async () => raw);
		assert.equal(await h.postToSession("private speech", bound), false);
		assert.equal(h.requests.length, 1);
		assert.equal(h.requests[0]!.command_turn_id, "command");
		assert.equal(h.requests[0]!.command_message_id, "source");
		assert.equal(h.requests[0]!.command_turn_unbound, undefined);
		assert.notEqual(h.context.activeCommandTurnIdentity, null);
		assert.equal(h.warnings.length, 1);
		assert.ok(!h.logs.some(([event]) => event === "post stored"));
		assert.ok(!JSON.stringify([h.logs, h.warnings]).includes("private speech"));
		resetClientCache();
	}
});

test("ambiguous response loss never duplicates speech/local_prompt in the inner transport", async () => {
	for (const options of [bound, { ...bound, completeTurn: false }, { turnKind: "local_prompt", localTurn: true }]) {
		const h = harness(async () => { throw new Error("socket closed after write private speech"); });
		assert.equal(await h.postToSession("private speech", options), false);
		assert.equal(h.requests.length, 1, "no hidden reconnect replay");
		assert.match(h.warnings[0]!, /unknown/);
		assert.doesNotMatch(h.warnings[0]!, /private speech|NOT stored/);
		resetClientCache();
	}
});

test("rate-limit refusal keeps shared cooldown but does not wait/replay mechanical speech", async () => {
	const h = harness(async () => ({ isError: true, content: [{ type: "text", text: "Rate limit exceeded. Retry in 5 seconds." }] }));
	assert.equal(await h.postToSession("speech", bound), false);
	assert.equal(h.requests.length, 1);
	assert.ok(((globalThis as Record<string, unknown>).__devspecPiRateLimit as { until: number }).until > Date.now());
});

test("authority is checked after client acquisition, and a captured segment cannot follow reattach", async () => {
	const h = harness(async () => stored());
	const gate = deferred<void>();
	const acquired = deferred<void>();
	setLaneClientFactoryForTests(async () => {
		acquired.resolve();
		await gate.promise;
		return { callTool: async () => { throw new Error("must not send"); }, readResource: async () => ({}), close: async () => {} };
	});
	const pending = h.postToSession("speech", bound);
	await acquired.promise;
	h.active.bond.sessionId = "replacement";
	gate.resolve();
	assert.equal(await pending, false);
	assert.equal(h.requests.length, 0);
	const canPost = h.capturePostAuthority();
	h.active.bond.sessionId = "third-room";
	assert.equal(await h.postToSession("old segment", { ...bound, isCurrent: canPost }), false);
	assert.equal(h.requests.length, 0);
});

test("a stored receipt logs success; late callback cannot clear replacement authority", async () => {
	setProjectChoice("test", { version: 1, endpoint: await resolveEndpoint(), source: "explicit", project: { id: "11111111-1111-4111-8111-111111111111", name: "Chosen project" } });
	const response = deferred<unknown>();
	const h = harness(async () => response.promise);
	const pending = h.postToSession("speech", bound);
	await h.sent; // Observe the request boundary, not a scheduler tick before optional scope I/O.
	const replacement = { turnId: "new-command", commandMessageId: "new-source" };
	h.context.activeCommandTurnIdentity = replacement;
	h.setPump({ ...h.active, generation: 2 });
	response.resolve(stored());
	assert.equal(await pending, true, "the old post was stored, but has no current authority");
	assert.equal(h.context.activeCommandTurnIdentity, replacement);
	assert.ok(h.logs.some(([event]) => event === "post stored"));
});

test("failed dirty trail stays pending without timer replay or resurrecting a replaced turn", async () => {
	const response = deferred<unknown>();
	const h = harness(async () => response.promise);
	const makeTurn = () => ({ trailDelivery: new TrailDeliveryState(), canPost: h.capturePostAuthority(),
		trailPostFence: new TrailPostFence(), receiptBatch: { deferTrail: () => false },
		trail: { events: () => [{ type: "tool" }], render: () => "private work" },
		commandTurnId: "command", commandMessageId: "source", posts: 0, lastPostAt: 0 });
	const previous = makeTurn(); previous.trailDelivery.markDirty();
	h.setTurn(previous); h.trailTick(); h.trailTick();
	await h.sent;
	assert.equal(h.requests.length, 1);
	assert.equal(previous.trailDelivery.dirty, true, "in-flight is not clean");
	const replacement = makeTurn(); h.setTurn(replacement);
	response.resolve(envelope({ skipped: true, noop: true, reason: "stale_generation" }));
	await previous.trailPostFence.drain();
	assert.equal(previous.trailDelivery.dirty, true);
	assert.equal(previous.trailDelivery.blocked, true);
	assert.equal(replacement.trailDelivery.dirty, false);
	h.trailTick();
	assert.equal(h.requests.length, 1);
	assert.equal(h.warnings.length, 1);
});


test("a cooldown wait cannot move a captured post to a new room", async () => {
	const h = harness(async () => stored());
	(globalThis as Record<string, unknown>).__devspecPiRateLimit = { until: Date.now() + 20 };
	const pending = h.postToSession("speech", bound);
	await new Promise(resolve => setImmediate(resolve));
	h.active.bond.sessionId = "other-room";
	assert.equal(await pending, false);
	assert.equal(h.requests.length, 0);
});

test("malformed storage receipt is an explicit failure, and exact interaction args survive", async () => {
	const h = harness(async () => envelope({ ok: true }));
	const interaction = { attempt_id: "attempt", question_dismissal_event_id: "event", question_dismissal_question_id: "question", question_dismissal_claim_token: "claim" };
	assert.equal(await h.postToSession("speech", { phase: "answer", interaction }), false);
	assert.equal(h.requests.length, 1);
	for (const [key, value] of Object.entries(interaction)) assert.equal(h.requests[0]![key], value);
	assert.equal(h.requests[0]!.command_turn_unbound, true);
	assert.equal(h.requests[0]!.local_turn, undefined);
	assert.match(h.warnings[0]!, /malformed/);
	assert.doesNotMatch(JSON.stringify([h.logs, h.warnings]), /secret-token|secret-capability|claim/);
});


test("a refusal after session replacement still exposes failure without reading stale UI", async () => {
	const response = deferred<unknown>();
	const h = harness(async () => response.promise);
	const pending = h.postToSession("speech", bound);
	await h.sent;
	Object.defineProperty(h.context.lastCtx, "hasUI", { get() { throw new Error("stale after session replacement or reload"); } });
	response.resolve(envelope({ skipped: true, noop: true }));
	assert.equal(await pending, false);
	assert.equal(h.warnings.length, 1);
});


test("settle does not replay a failed dirty trail or mark it clean", async () => {
	const h = harness(async () => { throw new Error("must not replay"); });
	const trailDelivery = new TrailDeliveryState();
	trailDelivery.markDirty(); trailDelivery.finish(trailDelivery.begin()!, false);
	const t = { trailDelivery, canPost: h.capturePostAuthority(),
		tracker: { lastAssistantText: "", pendingBackgroundTasks: () => [], userKind: "user" },
		trail: { events: () => [{ type: "tool" }], render: () => "work" },
		receiptBatch: { suppressEmptyFallback: () => false }, commandTurnId: "command", commandMessageId: "source" };
	assert.equal(await h.postSegmentAnswer(t, null, "run_end"), false);
	assert.equal(h.requests.length, 0);
	assert.equal(trailDelivery.dirty, true);
});

test("a failed local prompt is reported even when the answer stores successfully", async () => {
	const h = harness(async args => args.turn_kind === "local_prompt"
		? { isError: true, content: [{ type: "text", text: "refused" }] } : stored());
	h.context.settlePlan = { kind: "local_mirror", prompt: "local input", answer: "local answer" };
	const t = { canPost: h.capturePostAuthority(),
		tracker: { lastAssistantText: "local answer", pendingBackgroundTasks: () => [], userKind: "user" },
		trail: { events: () => [], render: () => "" } };
	assert.equal(await h.postSegmentAnswer(t, null, "run_end"), false);
	assert.equal(h.requests.length, 2, "one prompt and one answer, not a prompt retry");
	assert.match(h.warnings[0]!, /local prompt delivery rejected/);
});

for (const [phase, reason] of [
	...["stale_generation", "stale_attempt", "attempt_finalized", "no_unanswered_dispatch", "conflict"].map(reason => ["trail", reason]),
	["answer", "already_finalized"],
	["needs_input", "connection_ended"],
]) {
	test(`MCP isError with structured ${phase}/${reason} receipt reports rejected, never unknown or replayed`, async () => {
		const raw = { ...envelope({ session_id: "session", connection_id: "connection", phase,
			skipped: true, noop: true, reason, retryable: false,
			delivery: { status: reason === "connection_ended" ? "rejected" : "skipped", reason, retryable: false },
		}), isError: true };
		assert.equal(parsePostSessionReceipt(raw, { sessionId: "session", connectionId: "connection", phase: phase! }).status, "rejected");
		const h = harness(async () => raw);
		assert.equal(await h.postToSession("private speech", { ...bound, phase }), false);
		assert.equal(h.requests.length, 1);
		assert.equal(h.requests[0]!.command_turn_id, "command");
		assert.equal(h.requests[0]!.command_message_id, "source");
		assert.equal(h.requests[0]!.command_turn_unbound, undefined);
		assert.equal(h.warnings.length, 1);
		assert.match(h.warnings[0]!, /delivery rejected/);
		assert.doesNotMatch(h.warnings[0]!, /unknown/);
		const failure = h.logs.find(([event]) => event === "post delivery failed")?.[1] as Record<string, boolean>;
		assert.equal(failure.rejected, true);
		assert.equal(failure.unknown, false);
		assert.ok(!h.logs.some(([event]) => event === "post stored"));
		assert.doesNotMatch(JSON.stringify([h.logs, h.warnings]), /private speech|secret-token|secret-capability|session_id|retryable|stale_generation|stale_attempt|attempt_finalized|no_unanswered_dispatch|conflict|already_finalized|connection_ended/);
	});
}

test("lifecycle-only noop_error is successful MCP work but never a content-storage acknowledgement", async () => {
	const raw = envelope({ session_id: "session", connection_id: "connection", phase: "error",
		closed_trail_turn: false, noop: true,
		delivery: { status: "skipped", reason: "noop_error", retryable: false },
	});
	const h = harness(async () => raw);
	const result = await callDevspec("secret-token", "post_session_message", {
		connection_id: "connection", command_turn_id: "command", command_message_id: "source",
		phase: "error", message: "cleanup only",
	}, { lane: "pump", retry: "never" });
	assert.equal(result, raw);
	assert.equal(h.requests.length, 1);
	assert.equal(parsePostSessionReceipt(result, { sessionId: "session", connectionId: "connection", phase: "error" }).status, "skipped");
});

test("a sessionless automation trail posts through its connection, and with no bond is skipped rather than thrown (a54ff6ba)", async () => {
	// A sessionless post is stored against the connection with no room.
	const roomless = envelope({ session_id: null, connection_id: "connection", phase: "trail", message_id: "row", delivery: { status: "stored", message_id: "row" } });
	const h = harness(async () => roomless);
	h.setTurn({ requestKind: "automation" });
	h.active.bond = { connectionId: "connection", sessionId: undefined as never, connectionCapability: "secret-capability" };
	assert.equal(await h.postToSession("trail text", { phase: "trail", workTrail: "trail text" }), true);
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0]!.connection_id, "connection");
	assert.equal(h.requests[0]!.phase, "trail");
	assert.equal(h.requests[0]!.session_id, undefined);

	const unbonded = harness(async () => roomless);
	unbonded.setTurn({ requestKind: "automation" });
	unbonded.context.getBond = () => null as never;
	assert.equal(await unbonded.postToSession("trail text", { phase: "trail", workTrail: "trail text" }), false);
	assert.equal(unbonded.requests.length, 0);
	assert.equal(unbonded.warnings.length, 1);
});
