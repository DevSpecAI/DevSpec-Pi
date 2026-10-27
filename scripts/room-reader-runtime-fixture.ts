/** Scripted provider for real-host tool/delivery qualification. No external model. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const text = (m: any): string => typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
/** Pause between two tool calls until the harness has stored a new room message (ce1ffca1). */
async function roomMessageMidTurn(): Promise<void> {
	const ready = process.env.ROOM_PROBE_MIDTURN_READY; const stored = process.env.ROOM_PROBE_MIDTURN_STORED;
	if (!ready || !stored) return;
	writeFileSync(ready, "");
	const end = Date.now() + 30_000;
	while (!existsSync(stored)) {
		if (Date.now() > end) throw new Error("mid-turn room message never stored");
		await new Promise(r => setTimeout(r, 50));
	}
}
export default function (pi: ExtensionAPI) {
	pi.registerProvider("room-probe", {
		baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only",
		models: [{ id: "no-model", name: "Scripted room-reader probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context) {
			const messages = context.messages as any[];
			if (!messages.some(m => text(m).includes("NEW-COMMAND-BODY"))) {
				writeFileSync(process.env.ROOM_PROBE_MODEL_MARKER!, "unexpected history wake");
				throw new Error("Only the exact synthetic current command may start a probe turn");
			}
			const path = process.env.ROOM_PROBE_PROVIDER_TRACE!;
			let trace: unknown[] = [];
			try { trace = JSON.parse(readFileSync(path, "utf8")); } catch { /* first request */ }
			trace.push(JSON.parse(JSON.stringify(messages))); writeFileSync(path, JSON.stringify(trace));
			const local = messages.filter(m => m.role === "toolResult" && m.toolName === "read_room_context");
			const resource = messages.find(m => m.role === "toolResult" && m.toolName === "get_resource");
			let name = "read_room_context"; let args: Record<string, unknown> = { view: "search", query: "secret-codeword" };
			let final = false;
			if (local.length) {
				const last = JSON.parse(text(local.at(-1)));
				if (last.view === "unread") {
					// The reader hands the mid-turn message over whole (ce1ffca1).
					if (last.returned < 1 || !last.messages.some((m: any) => m.change === "new" && String(m.content).startsWith("MIDTURN-ROOM-BODY"))) throw new Error("unread view did not return the new message whole");
					final = true;
				} else if (last.value?.events) {
					if (last.value.events.length !== 2 || last.value.events[0].actor?.label !== "Fixture person" || last.value.events[1].at !== "2026-09-24T10:00:01.123456+00:00" || last.value.events[1].to !== "implemented") throw new Error("server events not preserved by native reader");
					args = { view: "unread" };
				} else if (last.value?.content) {
					if (!last.value.content.includes("VIOLET-ZEBRA")) throw new Error("old content not recovered");
					if (resource) { if (!text(resource).includes("FILE-CODEWORD")) throw new Error("attachment not fetched"); args = { view: "events" }; }
					else { name = "get_resource"; args = { id: last.value.attachments[0].resource_id }; }
				} else if (last.records?.length) args = { view: "message", message_id: last.records[0].message_id };
				else if (last.next_cursor) args = { view: "search", query: "secret-codeword", cursor: last.next_cursor };
				else throw new Error("local search lost older history");
			}
			const message: AssistantMessage = {
				role: "assistant", api: "openai-completions", provider: "room-probe", model: model.id,
				content: [], timestamp: Date.now(), stopReason: final ? "stop" : "toolUse",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			// The message read is the second tool call: a room message lands just before it runs.
			const gate = name === "read_room_context" && args.view === "message" ? roomMessageMidTurn() : Promise.resolve();
			void gate.catch(e => writeFileSync(process.env.ROOM_PROBE_MODEL_MARKER!, String(e))).then(() => {
				stream.push({ type: "start", partial: message });
				if (final) {
					message.content.push({ type: "text", text: "FIXTURE-READERS-PASS VIOLET-ZEBRA FILE-CODEWORD" });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "FIXTURE-READERS-PASS VIOLET-ZEBRA FILE-CODEWORD", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "FIXTURE-READERS-PASS VIOLET-ZEBRA FILE-CODEWORD", partial: message });
				} else {
					const call = { type: "toolCall" as const, id: `fixture-tool-${trace.length}`, name, arguments: args };
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
