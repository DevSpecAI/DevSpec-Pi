/** Deterministic actual-Pi fixture: no paid/autonomous model, real credentials or room writes. */
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setBond } from "../extensions/core/bond-state.ts";

export default function (pi: ExtensionAPI) {
	const projectId = "11111111-2222-4333-8444-555555555555";
	const connectionId = "99999999-8888-4777-8666-555555555555";
	const changed = process.env.COMMIT_PROBE_CHANGE === "1";
	const commands = JSON.parse(process.env.COMMIT_PROBE_COMMANDS!) as string[];
	pi.on("session_start", () => setBond({ projectId, connectionId, connectionCapability: "dvsc_fixture_original_capability_123456" }));
	// This fixture loads BEFORE the ledger. Simulate a reconnect after Git has run,
	// before its result is consumed; the old envelope must not acquire new identity.
	pi.on("tool_result", event => {
		if (!changed || event.toolName !== "bash") return;
		process.env.DEVSPEC_MCP_TOKEN = "fixture-different-account";
		process.env.DEVSPEC_MCP_URL = process.env.DEVSPEC_MCP_URL!.replace("/api/mcp", "/wrong-account/mcp");
		setBond({ projectId, connectionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", connectionCapability: "dvsc_fixture_changed_capability_123456" });
	});
	pi.registerProvider("commit-observer-probe", {
		baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only",
		models: [{ id: "scripted", name: "Commit observation fixture", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context) {
			const results = context.messages.filter(message => message.role === "toolResult");
			if (results.some(message => message.role === "toolResult" && message.isError)) throw new Error("Fixture Git command failed");
			const complete = new Set(results.map(message => message.role === "toolResult" ? message.toolCallId : ""));
			const index = commands.findIndex((_, i) => !complete.has(`commit-probe-${i}`));
			const final = index < 0;
			const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "commit-observer-probe", model: model.id,
				content: [], timestamp: Date.now(), stopReason: final ? "stop" : "toolUse",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (final) {
					const text = "COMMIT-OBSERVER-RUNTIME-PASS";
					message.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
				} else {
					const call = { type: "toolCall" as const, id: `commit-probe-${index}`, name: "bash", arguments: { command: commands[index] } };
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
