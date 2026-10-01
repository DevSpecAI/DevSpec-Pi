/** Actual-Pi native recording fixture: deterministic provider and disposable data only. */
import { execFileSync } from "node:child_process";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setBond } from "../extensions/core/bond-state.ts";
export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => setBond({ connectionId: "99999999-8888-4777-8666-555555555555", projectId: "11111111-2222-4333-8444-555555555555", connectionCapability: "dvsc_fixture_capability_1234567890" }));
  pi.registerProvider("commit-hint-probe", {
    baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only",
    models: [{ id: "scripted", name: "Scoped commit hint probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const completed = new Set(context.messages.filter(m => m.role === "toolResult").map(m => m.role === "toolResult" ? m.toolCallId : ""));
      const index = [0, 1, 2, 3].find(i => !completed.has(`hint-probe-${i}`));
      const final = index === undefined;
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "commit-hint-probe", model: model.id, content: [], timestamp: Date.now(), stopReason: final ? "stop" : "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (final) {
          const text = "COMMIT-HINT-RUNTIME-PASS"; message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        } else {
          let args: Record<string, unknown> = { command: "git commit --allow-empty -q -m 'prior task [devspec:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]'" };
          if (index > 0) {
            const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.env.COMMIT_HINT_PROBE_CWD, encoding: "utf8" }).trim();
            args = { action_item_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", completion_note: index === 1 ? "Report-only next task; no implementing commit." : "Explicit fixture hint.",
              ...(index === 2 ? { commit_sha: sha.slice(0, 8) } : index === 3 ? { commit_sha: sha } : {}) };
          }
          const call = { type: "toolCall" as const, id: `hint-probe-${index}`, name: index === 0 ? "bash" : "record_implementation", arguments: args };
          message.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        }
        stream.push({ type: "done", reason: final ? "stop" : "toolUse", message }); stream.end();
      });
      return stream;
    },
  });
}
