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
import { noticeReplyFinalText, noticeReplyTerminalMessage, postNoticeReply } from "../extensions/core/notice-reply.ts";
import { remoteRunActivityPolicy } from "../extensions/core/system-notice.ts";

// DevSpec item 6aad2b46. The REAL message_end hook and segment closer from
// devspec-remote.ts, with the wire mocked: a notice-woken segment's last message is
// its reply, posted only as a notice reply and never through the speech, trail,
// local-turn or completion writers. scripts/e2e-notice-reply.mjs runs the same in Pi.
const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const speech = source.slice(source.indexOf("const assistantSpeechQueue ="), source.indexOf("// Per-turn telemetry"));
const endHook = source.slice(source.indexOf('\tpi.on("message_end"'), source.indexOf('\tpi.on("tool_execution_start"'));
const segment = source.slice(source.indexOf("async function postSegmentAnswer("), source.indexOf("/**\n * Settle the run"));
const NOTICE = "17171717-1717-4171-8171-171717171717";
const envelope = (details: unknown) => ({ content: [{ type: "text", text: JSON.stringify(details) }] });
const assistant = (text: string, stopReason: string, tools = false) => ({ role: "assistant", stopReason, content: [{ type: "text", text }, ...(tools ? [{ type: "toolCall", name: "get_task" }] : [])] });

function harness(options: { refuse?: string } = {}) {
	const hooks: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
	const requests: Array<{ name: string; args: Record<string, unknown> }> = [];
	const other: string[] = [], warnings: string[] = [], posts: Promise<void>[] = [];
	const bond = { connectionId: "11111111-1111-4111-8111-111111111111", sessionId: "room", connectionCapability: "cap" };
	const t: Record<string, unknown> = { revision: 1, tracker: new TurnTracker(), trail: new TrailBuilder(), receiptBatch: { noteAssistantText() {}, suppressEmptyFallback() { return false; } },
		trailDelivery: new TrailDeliveryState(), completionNeutral: true, canPost: () => true, speechManaged: true,
		noticeReply: { connectionId: bond.connectionId, noticeIds: [NOTICE], roomPromised: true, finalText: null } };
	class DevspecToolError extends Error {}
	const sandbox = {
		AssistantSpeechSource, AssistantSpeechQueue, assistantSpeechWithinBudget, unwrapMcpResult, parsePostSessionReceipt, TurnTracker, shouldSplitSpeech, isClosedAnswer, extractAssistantParts,
		noticeReplyFinalText, noticeReplyTerminalMessage, postNoticeReply, remoteRunActivityPolicy, DevspecToolError,
		turn: t, pump: { bond, generation: 1, stop: false }, lastCtx: { hasUI: true }, AGENT_NAME: "Pi",
		getBond: () => bond, resolveToken: async () => ({ token: "private-bearer" }), replyModelArgs: () => ({}),
		noteProgressEvent() {}, debug() {}, telemetry: { addMessageUsage() {} }, safeHasUI: () => true,
		notify: (_ctx: unknown, warning: string) => warnings.push(warning), noteOwnRoomMessage: (id: string) => other.push(`own:${id}`),
		trackTerminalPost: (post: Promise<void>) => posts.push(post), splitTurnAtBoundary() { other.push("split"); },
		INTERACTION_EVENT_CUSTOM_TYPE: "interaction", QUESTION_DISMISSAL_EVENT_CUSTOM_TYPE: "dismissal", FINAL_TRAIL_CHARS: 100000,
		planSettle() { other.push("planSettle"); return { kind: "none" }; }, isCommandTurnUnbound: () => true, interactionIdentity: () => undefined,
		postToSession: async () => { other.push("postToSession"); return true; },
		callDevspec: async (_token: string, name: string, args: Record<string, unknown>, opts: { beforeSend?: () => void }) => {
			opts.beforeSend?.();
			requests.push({ name, args });
			if (options.refuse) throw new DevspecToolError(JSON.stringify({ delivery: { status: "rejected", reason: options.refuse, retryable: false }, error: `Refused: ${options.refuse}.` }));
			return envelope({ delivery: { status: "stored", message_id: "row" }, message_id: "row", session_id: "room", connection_id: args.connection_id, phase: "answer", notice_reply: { notice_ids: args.system_notice_ids }, turn_effect: "none", complete_turn: false });
		},
		pi: { on: (name: string, fn: typeof hooks[string]) => hooks[name] = fn, appendEntry: () => other.push("journal") },
	};
	const api = runInNewContext(stripTypeScriptTypes(`${speech}\n${segment}\n${endHook}\n({ postSegmentAnswer })`), sandbox) as { postSegmentAnswer: (t: unknown, stats: null, why: string, complete?: boolean) => Promise<boolean> };
	return { hooks, t, api, requests, other, warnings, drain: () => Promise.all(posts) };
}

test("a notice segment closes by posting its last message as the notice reply, and nothing else", async () => {
	const h = harness();
	await h.hooks.message_end({ message: assistant("Checking the record.", "toolUse", true) }, {});
	await h.hooks.message_end({ message: assistant("Your duplicate is closed.", "stop") }, {});
	await h.drain();
	assert.equal(await h.api.postSegmentAnswer(h.t, null, "run_end", true), false, "it completes no turn");
	assert.deepEqual(h.requests, [{ name: "post_session_message", args: { agent_name: "Pi", connection_id: "11111111-1111-4111-8111-111111111111", message: "Your duplicate is closed.", system_notice_ids: [NOTICE] } }]);
	assert.deepEqual(h.other, ["own:row"], "no speech, trail, prompt mirror or split");
	assert.deepEqual(h.warnings, []);
});

test("a notice segment that ends on a tool call or an abort posts nothing", async () => {
	for (const last of [assistant("Still checking.", "toolUse", true), assistant("Partial", "aborted"), assistant("", "stop")]) {
		const h = harness();
		await h.hooks.message_end({ message: assistant("Earlier text.", "stop") }, {});
		await h.hooks.message_end({ message: last }, {});
		await h.drain();
		assert.equal(await h.api.postSegmentAnswer(h.t, null, "run_end", true), false);
		assert.deepEqual(h.requests, []);
		assert.deepEqual(h.warnings, []);
	}
});

test("a refused notice reply is shown in the terminal with DevSpec's reason", async () => {
	const h = harness({ refuse: "not_attached" });
	await h.hooks.message_end({ message: assistant("Your duplicate is closed.", "stop") }, {});
	await h.api.postSegmentAnswer(h.t, null, "run_end", true);
	assert.deepEqual(h.warnings, ["DevSpec: The reply to the DevSpec notice was not posted to the room (not_attached). Refused: not_attached."]);
});
