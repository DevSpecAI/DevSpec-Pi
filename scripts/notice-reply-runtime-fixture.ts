// Deterministic actual-host fixture for scripts/e2e-notice-reply.mjs. No external
// model, credentials or live room data.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: any) {
	const root = process.env.NOTICE_PROBE_ROOT!;
	const mode = process.env.NOTICE_PROBE_MODE ?? "reply";
	const text = (m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
	pi.registerTool({ name: "probe_hold", label: "Probe hold", description: "Deterministic harmless lifecycle latch.", parameters: Type.Object({ phase: Type.String() }), async execute(_id: string, { phase }: any, signal: AbortSignal) {
		writeFileSync(join(root, `${phase}-started`), "ready");
		while (!existsSync(join(root, `${phase}-release`))) {
			if (signal?.aborted) throw new Error("Probe cancelled");
			await new Promise((r) => setTimeout(r, 25));
		}
		return { content: [{ type: "text", text: "Latch released" }], details: undefined };
	} });
	pi.registerTool({ name: "probe_note", label: "Probe note", description: "Deterministic harmless tool.", parameters: Type.Object({}), async execute() {
		return { content: [{ type: "text", text: "noted" }], details: undefined };
	} });
	let requests = 0;
	pi.registerProvider("notice-probe", {
		baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only",
		models: [{ id: "scripted", name: "Deterministic notice probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model: any, context: any) {
			const messages = context.messages as any[];
			// Whichever input came last decides the run: the owner command or a notice.
			const last = (match: (t: string) => boolean) => messages.findLastIndex((m) => m.role !== "assistant" && m.role !== "toolResult" && match(text(m)));
			const noticeAt = last((t) => t.startsWith("[DevSpec system notice v1"));
			const ownerAt = last((t) => t.includes("OWNER-COMMAND-BODY"));
			const notice = noticeAt > ownerAt;
			const inputAt = Math.max(noticeAt, ownerAt);
			const round = messages.slice(inputAt + 1).filter((m) => m.role === "toolResult").length;
			appendFileSync(join(root, "provider-trace.jsonl"), JSON.stringify({ request: ++requests, notice, round, input: inputAt >= 0 ? text(messages[inputAt]) : null }) + "\n");
			const message: any = { role: "assistant", api: "openai-completions", provider: "notice-probe", model: model.id, content: [], timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			let reply = ""; let call: any = null;
			if (!notice) {
				// The owner command holds on a latch so a notice can arrive while it runs.
				if (round === 0) { reply = "OWNER-WORKING"; call = { type: "toolCall", id: `hold-${requests}`, name: "probe_hold", arguments: { phase: "owner" } }; }
				else reply = "OWNER-ANSWER";
			} else if (mode === "silent") {
				// Tool work, then a final message with no text: nothing to post.
				if (round === 0) call = { type: "toolCall", id: `note-${requests}`, name: "probe_note", arguments: {} };
			} else if (round === 0) {
				reply = "NOTICE-PROGRESS: checking the record";
				call = { type: "toolCall", id: `note-${requests}`, name: "probe_note", arguments: {} };
			} else reply = "NOTICE-REPLY-FINAL: DevSpec confirmed the duplicate; I closed mine.";
			if (call) message.stopReason = "toolUse";
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				let index = 0;
				if (reply) {
					message.content.push({ type: "text", text: reply });
					stream.push({ type: "text_start", contentIndex: index, partial: message });
					stream.push({ type: "text_delta", contentIndex: index, delta: reply, partial: message });
					stream.push({ type: "text_end", contentIndex: index, content: reply, partial: message });
					index += 1;
				}
				if (call) {
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
				}
				stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
			});
			return stream;
		},
	});
}
