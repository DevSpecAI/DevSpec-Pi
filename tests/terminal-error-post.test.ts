import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { AssistantSpeechSource, AssistantSpeechQueue, assistantSpeechWithinBudget } from "../extensions/core/assistant-speech.ts";
import { TurnTracker, shouldSplitSpeech, isClosedAnswer } from "../extensions/core/turn-lifecycle.ts";
import { extractAssistantParts, TrailBuilder } from "../extensions/core/trail.ts";
import { unwrapMcpResult } from "../extensions/core/result.ts";
import { parsePostSessionReceipt, TrailDeliveryState } from "../extensions/core/post-session-receipt.ts";
import { formatSenderStyleRepair, REMOTE_INGRESS_CONTEXT_CUSTOM_TYPE, senderStyleRepairNeeded } from "../extensions/core/remote-payload.ts";

// Item e99d158b: a run dying on a terminal provider error (402 out-of-credit,
// auth, exhausted retries) must post its reason to the room instead of closing
// silently. These tests exercise the REAL message_end hook and the real
// reportTerminalError sliced from devspec-remote.ts, with the wire mocked.
const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const speech = source.slice(source.indexOf("const assistantSpeechQueue ="), source.indexOf("// Per-turn telemetry"));
const contextHook = source.slice(source.indexOf('\tpi.on("context"'), source.indexOf('\tpi.on("turn_start"'));
const endHook = source.slice(source.indexOf('\tpi.on("message_end"'), source.indexOf('\tpi.on("tool_execution_start"'));
const segment = source.slice(source.indexOf("async function postSegmentAnswer("), source.indexOf("/**\n * Settle the run"));
const terminalError = source
	.slice(source.indexOf("const TERMINAL_ERROR_PROVIDER_CHARS"), source.indexOf("/** Start the exact event/claim-bound activity"))
	.replace("export function renderTerminalErrorPost", "function renderTerminalErrorPost");
const envelope = (details: unknown) => ({ content: [{ type: "text", text: JSON.stringify(details) }] });

function captureHarness() {
	const hooks: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
	const bond = { connectionId: "connection", sessionId: "room", attachedAt: "2026-09-22T01:02:03.123456+00:00", speechAttachmentId: "epoch", connectionCapability: "private-cap" };
	const t = { revision: 1, tracker: new TurnTracker(), trail: new TrailBuilder(), receiptBatch: { noteAssistantText() {}, suppressEmptyFallback() { return false; } },
		trailDelivery: new TrailDeliveryState(), commandTurnId: "command", commandMessageId: "input", completionNeutral: false, canPost: () => true } as Record<string, unknown>;
	const ctx = { hasUI: true };
	const sandbox = {
		AssistantSpeechSource, AssistantSpeechQueue, assistantSpeechWithinBudget, unwrapMcpResult, parsePostSessionReceipt,
		TurnTracker, shouldSplitSpeech, isClosedAnswer, extractAssistantParts, turn: t, pump: { bond, generation: 1, stop: false }, lastCtx: ctx,
		getBond: () => bond, resolveToken: async () => ({ token: "private-bearer" }), ensureTurn() {}, replyModelArgs: () => ({}),
		interactionIdentity: () => undefined, exactInteractionContinuationArgs: (value: unknown) => value,
		noteProgressEvent: () => {}, currentProgressMarker: () => "1",
		DevspecToolError: Error, safeHasUI: () => true, notify: () => {},
		trackTerminalPost: () => {}, debug() {}, telemetry: { addMessageUsage() {} },
		INTERACTION_EVENT_CUSTOM_TYPE: "interaction", QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE: "dismissal", splitTurnAtBoundary() {},
		activeCommandStyles: new Map(), senderStyleRepairNeeded, formatSenderStyleRepair, REMOTE_INGRESS_CONTEXT_CUSTOM_TYPE,
		remoteRunActivityPolicy: () => ({ reportTranscript: true }), FINAL_TRAIL_CHARS: 100000,
		planSettle() { throw new Error("legacy speech planner called"); }, isCommandTurnUnbound: () => false,
		postToSession: async () => true,
		callDevspec: async (_token: string, _name: string, args: Record<string, unknown>) =>
			envelope({ connection_id: args.connection_id, session_id: bond.sessionId, phase: "answer", assistant_source_id: args.assistant_source_id, message_id: "row", delivery: { status: "stored", message_id: "row" } }),
		pi: { on: (name: string, fn: typeof hooks[string]) => hooks[name] = fn, appendEntry: () => {} },
	};
	runInNewContext(stripTypeScriptTypes(`${speech}\n${segment}\n${contextHook}\n${endHook}`), sandbox);
	return { hooks, ctx, t };
}

function reportHarness(postResults: Array<{ receipt?: "stored" | "skipped" | "rejected"; stored: boolean }>) {
	const posts: Array<{ message: string; opts: Record<string, unknown> }> = [];
	const forgotten: Array<unknown> = [];
	const closed: Array<unknown> = [];
	const styles = new Map([["command", [{ id: "x", responseStyleNotes: [] }]]]);
	const t = {
		terminalError: '402 {"error":{"message":"Insufficient balance"}}',
		trail: new TrailBuilder(),
		commandTurnId: "command", commandMessageId: "input",
		interaction: undefined, canPost: () => true,
	};
	t.trail.setText("work before the failure");
	// A tool event makes events() non-empty so the final trail render rides the
	// error post (same rule as postSegmentAnswer: no events → no work_trail).
	t.trail.toolStart("call-1", "bash", { command: "npm test" });
	t.trail.toolEnd("call-1", "bash", true, { content: [] });
	const sandbox = {
		FINAL_TRAIL_CHARS: 100000,
		isCommandTurnUnbound: () => false,
		interactionIdentity: () => undefined,
		postToSession: async (message: string, opts: Record<string, unknown>) => {
			posts.push({ message, opts });
			const next = postResults[posts.length - 1] ?? { stored: false };
			if (next.receipt) (opts.onReceipt as (s: string) => void)?.(next.receipt);
			return next.stored;
		},
		commandTurnBindings: { forgetByCommand: (...args: unknown[]) => forgotten.push(args) },
		activeCommandStyles: styles,
		noteCommandTurnClosed: (id: unknown) => closed.push(id),
	};
	const api = runInNewContext(
		stripTypeScriptTypes(`${terminalError}\n({ reportTerminalError, renderTerminalErrorPost })`),
		sandbox,
	) as { reportTerminalError: (t: unknown, stats: null) => Promise<void>; renderTerminalErrorPost: (m: string) => string };
	return { api, posts, forgotten, closed, styles, t };
}

test("message_end captures a terminal provider error, exactly once, never for stop", async () => {
	const h = captureHarness();
	const errorMessage = '402 {"error":{"message":"Insufficient balance"}}';
	await h.hooks.message_end({ message: { role: "assistant", stopReason: "error", errorMessage, content: [] } }, h.ctx);
	assert.equal(h.t.terminalError, errorMessage);
	// A normal close never sets it.
	const h2 = captureHarness();
	await h2.hooks.message_end({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }, h2.ctx);
	assert.equal(h2.t.terminalError, undefined);
	// Missing errorMessage still captures a usable reason.
	const h3 = captureHarness();
	await h3.hooks.message_end({ message: { role: "assistant", stopReason: "error", content: [] } }, h3.ctx);
	assert.equal(h3.t.terminalError, "The model provider returned an error.");
});

test("reportTerminalError posts phase error with complete_turn and identity, no fallback when stored", async () => {
	const h = reportHarness([{ receipt: "stored", stored: true }]);
	await h.api.reportTerminalError(h.t, null);
	assert.equal(h.posts.length, 1);
	const post = h.posts[0];
	assert.equal(post.opts.phase, "error");
	assert.equal(post.opts.completeTurn, true);
	assert.equal(post.opts.commandTurnId, "command");
	assert.equal(post.opts.commandMessageId, "input");
	assert.ok(typeof post.opts.workTrail === "string" && (post.opts.workTrail as string).includes("npm test"));
	assert.ok(Array.isArray(post.opts.trailEvents) && (post.opts.trailEvents as unknown[]).length > 0);
	assert.ok(post.message.includes("Insufficient balance"));
	assert.deepEqual(h.forgotten, [["command", "input"]]);
	assert.deepEqual(h.closed, ["command"]);
	assert.equal(h.styles.has("command"), false);
});

test("reportTerminalError falls back to a transcript-only post when the server noops (no open bubble)", async () => {
	const h = reportHarness([{ receipt: "skipped", stored: false }, { receipt: "stored", stored: true }]);
	await h.api.reportTerminalError(h.t, null);
	assert.equal(h.posts.length, 2);
	assert.equal(h.posts[0].opts.phase, "error");
	assert.equal(h.posts[1].opts.phase, "answer");
	// The activity was already closed server-side by noop_error: the fallback
	// is transcript-only and must not carry complete_turn.
	assert.equal(h.posts[1].opts.completeTurn, undefined);
	assert.deepEqual(h.forgotten, [["command", "input"]]);
});

test("reportTerminalError never falls back without a server receipt (pre-send skip / lost response)", async () => {
	const h = reportHarness([{ stored: false }]);
	await h.api.reportTerminalError(h.t, null);
	assert.equal(h.posts.length, 1);
	assert.deepEqual(h.forgotten, []);
	assert.deepEqual(h.closed, []);
});

test("reportTerminalError is a no-op without a terminal error", async () => {
	const h = reportHarness([]);
	await h.api.reportTerminalError({ ...h.t, terminalError: undefined }, null);
	assert.equal(h.posts.length, 0);
});

test("renderTerminalErrorPost carries the provider text, the guidance, and caps length", () => {
	const h = reportHarness([]);
	const rendered = h.api.renderTerminalErrorPost('402 {"error":{"message":"Insufficient balance"}}');
	assert.ok(rendered.includes("Insufficient balance"));
	assert.ok(rendered.includes("send another message"));
	assert.ok(!rendered.includes("e99d158b")); // no internals in customer copy
	const long = h.api.renderTerminalErrorPost("x".repeat(5000));
	assert.ok(long.length < 5000);
	assert.ok(long.includes("…"));
});
