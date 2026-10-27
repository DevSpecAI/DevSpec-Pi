/** Deterministic actual-Pi fixture for scripts/e2e-commit-stamp.mjs: no paid model, real credentials or room writes. */
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setBond } from "../extensions/core/bond-state.ts";

export default function (pi: ExtensionAPI) {
	const projectId = process.env.STAMP_PROBE_PROJECT!;
	const connectionId = "99999999-8888-4777-8666-555555555555";
	const calls = JSON.parse(process.env.STAMP_PROBE_CALLS!) as Array<{ name: string; arguments: Record<string, unknown> }>;
	pi.on("session_start", () => setBond({ projectId, connectionId, connectionCapability: "dvsc_fixture_stamp_capability_123456" }));
	pi.registerProvider("commit-stamp-probe", {
		baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only",
		models: [{ id: "scripted", name: "Commit stamp fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context) {
			const results = context.messages.filter((message) => message.role === "toolResult");
			if (results.some((message) => message.role === "toolResult" && message.isError)) throw new Error("A fixture tool call failed");
			const index = results.length;
			const final = index >= calls.length;
			const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "commit-stamp-probe", model: model.id,
				content: [], timestamp: Date.now(), stopReason: final ? "stop" : "toolUse",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (final) {
					const text = "COMMIT-STAMP-RUNTIME-PASS";
					message.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
				} else {
					const call = { type: "toolCall" as const, id: `stamp-probe-${index}`, name: calls[index]!.name, arguments: calls[index]!.arguments };
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				}
				stream.push({ type: "done", reason: final ? "stop" : "toolUse", message }); stream.end();
			});
			return stream;
		},
	});
}
