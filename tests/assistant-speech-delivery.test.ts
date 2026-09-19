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

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const speech = source.slice(source.indexOf("const assistantSpeechQueue ="), source.indexOf("// Per-turn telemetry"));
const contextHook = source.slice(source.indexOf('\tpi.on("context"'), source.indexOf('\tpi.on("turn_start"'));
const endHook = source.slice(source.indexOf('\tpi.on("message_end"'), source.indexOf('\tpi.on("tool_execution_start"'));
const segment = source.slice(source.indexOf("async function postSegmentAnswer("), source.indexOf("/**\n * Settle the run"));
const envelope = (details: unknown) => ({ content: [{ type: "text", text: JSON.stringify(details) }] });
const message = (text: string, stopReason = "stop", tools = false) => ({ role: "assistant", stopReason, content: [
	{ type: "thinking", thinking: "private thinking" }, { type: "text", text }, ...(tools ? [{ type: "toolCall", name: "bash" }] : []),
] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { resolve, promise }; }

function harness(gate?: Promise<void>, receipt?: (args: Record<string, unknown>) => unknown) {
	const hooks: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
	const journal: unknown[] = [], requests: Array<{ name: string; args: Record<string, unknown>; opts: Record<string, unknown>; token: string }> = [];
	const posts: Promise<void>[] = [], warnings: string[] = [];
	const bond = { connectionId: "connection", sessionId: "room", attachedAt: "2026-09-17T01:02:03.123456+00:00", speechAttachmentId: "epoch", connectionCapability: "private-cap" };
	const t = { revision: 1, tracker: new TurnTracker(), trail: new TrailBuilder(), receiptBatch: { noteAssistantText() {}, suppressEmptyFallback() { return false; } },
		trailDelivery: new TrailDeliveryState(), commandTurnId: "command", commandMessageId: "input", completionNeutral: false, canPost: () => true };
	t.tracker.userMessage("[DevSpec remote — message from Ali] continue");
	const ctx = { hasUI: true };
	const sandbox = {
		AssistantSpeechSource, AssistantSpeechQueue, assistantSpeechWithinBudget, unwrapMcpResult, parsePostSessionReceipt,
		TurnTracker, shouldSplitSpeech, isClosedAnswer, extractAssistantParts, turn: t, pump: { bond, generation: 1, stop: false }, lastCtx: ctx,
		getBond: () => bond, resolveToken: async () => ({ token: "private-bearer" }), ensureTurn() {}, replyModelArgs: () => ({ model: { providerID: "test", modelID: "model" } }),
		interactionIdentity: () => undefined, exactInteractionContinuationArgs: (value: unknown) => value,
		DevspecToolError: Error, safeHasUI: () => true, notify: (_ctx: unknown, warning: string) => warnings.push(warning),
		trackTerminalPost: (post: Promise<void>) => posts.push(post), debug() {}, telemetry: { addMessageUsage() {} },
		INTERACTION_EVENT_CUSTOM_TYPE: "interaction", QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE: "dismissal", splitTurnAtBoundary() { throw new Error("speech split execution"); },
		activeCommandStyles: new Map(), senderStyleRepairNeeded, formatSenderStyleRepair, REMOTE_INGRESS_CONTEXT_CUSTOM_TYPE,
		remoteRunActivityPolicy: () => ({ reportTranscript: true }), FINAL_TRAIL_CHARS: 100000,
		planSettle() { throw new Error("legacy speech planner called"); }, isCommandTurnUnbound: () => false,
		postToSession: async (_text: string, opts: { phase?: string }) => { assert.equal(opts.phase, "trail"); return true; },
		callDevspec: async (token: string, name: string, args: Record<string, unknown>, opts: Record<string, unknown>) => {
			(opts.beforeSend as () => void)?.();
			requests.push({ token, name, args, opts });
			if (name === "report_pickup") {
				await gate;
				return envelope({ ...args, attempt_id: "attempt" });
			}
			return envelope(receipt ? receipt(args) : { connection_id: args.connection_id, session_id: args.expected_session_id, phase: "answer", assistant_source_id: args.assistant_source_id, message_id: "row", delivery: { status: "stored", message_id: "row" } });
		},
		pi: { on: (name: string, fn: typeof hooks[string]) => hooks[name] = fn, appendEntry: (type: string, data: unknown) => journal.push({ type, data }) },
	};
	const api = runInNewContext(stripTypeScriptTypes(`${speech}\n${segment}\n${contextHook}\n${endHook}\n({ prepareAssistantSpeech, postSegmentAnswer })`), sandbox);
	return { hooks, ctx, t, bond, sandbox, requests, journal, warnings, api, drain: () => Promise.all(posts) };
}

test("actual context/message_end hooks deliver each text in order, tools and abort/error included, without second settle speech", async () => {
	const h = harness();
	const texts = ["I’ll wait for the build.", "  raw 👩‍💻\n\n", "partial abort", "partial error", "same", "same"];
	for (const [i, text] of texts.entries()) {
		await h.hooks.context({}, h.ctx);
		await h.hooks.message_end({ message: message(text, i === 2 ? "aborted" : i === 3 ? "error" : "stop", i === 0) }, h.ctx);
	}
	await h.drain();
	assert.equal(h.requests.filter(r => r.name === "report_pickup").length, 1);
	const speech = h.requests.filter(r => r.name === "post_session_message");
	assert.deepEqual(speech.map(r => r.args.message), texts);
	assert.equal(new Set(speech.map(r => r.args.assistant_source_id)).size, texts.length);
	assert.ok(speech.every(r => r.args.complete_turn === false && r.args.attempt_id === "attempt" && r.opts.connectionCapability === "private-cap"));
	assert.equal(await h.api.postSegmentAnswer(h.t, null, "run_end", true), false);
	assert.equal(h.requests.filter(r => r.name === "post_session_message").length, texts.length);
	assert.equal(JSON.stringify(h.journal).includes("private-"), false);
});

for (const variant of ["missing source", "wrong source", "untyped receipt", "wrong row"] as const) {
	test(`source delivery does not confirm a ${variant}`, async () => {
		const h = harness(undefined, args => ({
			connection_id: args.connection_id, session_id: args.expected_session_id, phase: "answer", message_id: "row",
			...(variant === "missing source" ? {} : { assistant_source_id: variant === "wrong source" ? "other-source" : args.assistant_source_id }),
			...(variant === "untyped receipt" ? {} : { delivery: { status: "stored", message_id: variant === "wrong row" ? "other-row" : "row" } }),
		}));
		await h.hooks.context({}, h.ctx);
		await h.hooks.message_end({ message: message("original source") }, h.ctx);
		await h.drain();
		assert.equal(h.warnings.length, 1);
		assert.match(JSON.stringify(h.journal), /"stored":false/);
		assert.equal(h.requests.filter(r => r.name === "post_session_message").length, 1);
	});
}

for (const change of ["capability", "epoch", "timestamp", "room ABA"] as const) {
	test(`scope acquired after ${change} cannot relabel the in-flight source or refresh it next round`, async () => {
		const gate = deferred(), h = harness(gate.promise);
		const preparing = h.hooks.context({}, h.ctx);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(h.requests.length, 1);
		if (change === "capability") h.bond.connectionCapability = "new-cap";
		if (change === "epoch") h.bond.speechAttachmentId = "new-epoch";
		if (change === "timestamp") h.bond.attachedAt = "2026-09-17T01:02:04+00:00";
		if (change === "room ABA") { h.bond.sessionId = "other"; h.bond.sessionId = "room"; h.bond.speechAttachmentId = "new-epoch"; }
		gate.resolve(); await preparing;
		await h.hooks.message_end({ message: message("raw unsent") }, h.ctx);
		await h.hooks.context({}, h.ctx);
		await h.hooks.message_end({ message: message("later unsent") }, h.ctx);
		await h.drain();
		assert.equal(h.requests.filter(r => r.name === "post_session_message").length, 0);
		assert.equal(h.requests.filter(r => r.name === "report_pickup").length, 1);
		assert.match(JSON.stringify(h.journal), /raw unsent/);
		assert.equal(h.warnings.length, 2);
	});
}

test("missing scope and structural notice never fall back or acquire generic local publication", async () => {
	for (const notice of [false, true]) {
		const h = harness();
		if (notice) h.t.completionNeutral = true; else h.bond.attachedAt = "";
		await h.hooks.context({}, h.ctx);
		await h.hooks.message_end({ message: message("actual but unsupported") }, h.ctx);
		await h.drain();
		assert.equal(h.requests.length, 0);
		assert.equal(h.warnings.length, 1);
	}
});

test("tool/custom/user/thinking input never becomes speech and a post cannot refresh revoked source authority", async () => {
	const h = harness();
	await h.hooks.context({}, h.ctx);
	for (const role of ["toolResult", "custom", "user", "system"]) {
		await h.hooks.message_end({ message: { role, content: [{ type: "text", text: "not assistant speech" }] } }, h.ctx);
	}
	await h.hooks.message_end({ message: { role: "assistant", content: [{ type: "thinking", thinking: "not speech" }] } }, h.ctx);
	assert.equal(h.journal.length, 0);
	await h.hooks.context({}, h.ctx);
	h.bond.connectionCapability = "replacement-cap";
	await h.hooks.message_end({ message: message("raw delayed text") }, h.ctx);
	await h.drain();
	assert.equal(h.requests.filter(r => r.name === "post_session_message").length, 0);
	assert.equal(h.requests.filter(r => r.name === "report_pickup").length, 1);
	assert.match(JSON.stringify(h.journal), /raw delayed text/);
	assert.doesNotMatch(JSON.stringify(h.journal), /replacement-cap|private-cap|private-bearer/);
	assert.equal(h.warnings.length, 1);
});

test("sources ignore non-assistant/empty content, preserve concatenation, and reject changed bytes", () => {
	const source = new AssistantSpeechSource();
	assert.equal(source.finalize({ role: "custom", content: [{ type: "text", text: "not speech" }] }), null);
	const captured = source.finalize(message("  text\n"));
	assert.equal(source.finalize(message("  text\n", "aborted")), captured);
	assert.throws(() => source.finalize(message("text")), /conflict/);
	assert.equal(new AssistantSpeechSource().finalize(message(" \u2060\u00ad\u200d\ufe0f\n")), null);
	assert.equal(new AssistantSpeechSource().finalize({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "hidden" }, { type: "text", text: "b" }] })?.text, "ab");
	assert.equal(assistantSpeechWithinBudget("😀".repeat(100000)), true);
	assert.equal(assistantSpeechWithinBudget("x".repeat(100001)), false);
	assert.equal(assistantSpeechWithinBudget("\u0001".repeat(85333)), true);
	assert.equal(assistantSpeechWithinBudget("\u0001".repeat(85334)), false);
});

test("context hook re-attaches a styled turn's response style only when its delivery context is gone", async () => {
	const h = harness();
	const styles = [{ id: "command-message", responseStyleNotes: ["Talk to me like a person talking aloud."] }];
	(h.sandbox.activeCommandStyles as Map<string, unknown>).set("command", styles);
	// Delivery context present: no-op, hook returns undefined.
	const present = await h.hooks.context({ messages: [{ role: "user" }, { role: "custom", customType: "devspec-remote-ingress-context" }] }, h.ctx);
	assert.equal(present, undefined);
	// Delivery context gone (compacted away): repair appends a style-only message.
	const repaired: any = await h.hooks.context({ messages: [{ role: "user" }] }, h.ctx);
	assert.equal(repaired.messages.length, 2);
	const repair = repaired.messages[1];
	assert.equal(repair.role, "custom");
	assert.equal(repair.customType, "devspec-remote-ingress-context");
	assert.equal(repair.display, false);
	assert.ok(String(repair.content).includes("command turn:command"));
	assert.ok(String(repair.content).includes("Talk to me like a person talking aloud."));
});

test("context hook never repairs without an active styled turn", async () => {
	const h = harness();
	const out = await h.hooks.context({ messages: [{ role: "user" }] }, h.ctx);
	assert.equal(out, undefined);
});
