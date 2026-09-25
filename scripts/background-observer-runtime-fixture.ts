/** Scripted actual-host fixture. No paid/autonomous model and no real room data. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let requests = 0;
	const root = process.env.BACKGROUND_PROBE_ROOT!;
	const race = process.env.BACKGROUND_PROBE_RACE === "1";
	const queuedInterruption = process.env.BACKGROUND_PROBE_QUEUED === "1";
	pi.registerCommand("probe-notification-state", {
		description: "Inspect notification handoff through the provider's public status API",
		handler: async (id) => {
			for (let attempt = 0; attempt < 20; attempt++) {
				const requestId = randomUUID();
				const snapshot = await new Promise<any>((resolve, reject) => {
					const timer = setTimeout(() => { off(); reject(new Error("Public provider status unavailable")); }, 2000);
					const off = pi.events.on("pi-background-tasks:response:v1", raw => {
						const frame = raw as any;
						if (frame?.request_id !== requestId) return;
						clearTimeout(timer); off(); resolve(frame.ok ? frame.result?.tasks?.[0] : null);
					});
					pi.events.emit("pi-background-tasks:request:v1", { schema_version: "pi-background-tasks.extension-request.v1",
						request_id: requestId, operation: "status", payload: { taskId: id.trim() } });
				});
				if (snapshot?.id === id.trim() && snapshot.notified === true) {
					writeFileSync(join(root, "notification-handed-off.json"), JSON.stringify({ id: snapshot.id,
						notified: snapshot.notified, notifyOnCompletion: snapshot.notifyOnCompletion, triggerOnCompletion: snapshot.triggerOnCompletion }));
					return;
				}
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			throw new Error("Notification was not handed to the host");
		},
	});
	pi.registerTool({ name: "probe_hold_foreground", label: "Hold fixture foreground", description: "Harmless test latch", parameters: Type.Object({ initial: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal) {
			const prefix = params.initial ? "initial-foreground" : "foreground";
			writeFileSync(join(root, `${prefix}-started`), "ready");
			while (!existsSync(join(root, `${prefix}-release`))) {
				if (signal?.aborted) throw new Error("Fixture foreground aborted");
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			return { content: [{ type: "text", text: "released" }], details: undefined };
		},
	});
	pi.registerProvider("background-observer-probe", {
		baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only",
		models: [{ id: "scripted", name: "Background observer probe", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple(model, context) {
			requests += 1;
			if (requests > (race ? 4 : 2)) throw new Error("A non-waking background job unexpectedly woke the model");
			const newer = race && context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("NEWER-FOREGROUND"));
			const results = context.messages.filter(message => message.role === "toolResult" && message.toolName === "bg_run");
			const final = newer ? existsSync(join(root, "foreground-release")) : results.length === 2;
			if (requests === 2 && !final && !queuedInterruption) throw new Error("Expected two real background launch results");
			appendFileSync(process.env.BACKGROUND_PROBE_TRACE!, JSON.stringify({ at: Date.now(), request: requests, final }) + "\n");
			const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "background-observer-probe", model: model.id,
				content: [], timestamp: Date.now(), stopReason: final ? "stop" : "toolUse",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				if (final) {
					const text = newer ? "BACKGROUND-PROBE-NEWER-FINISHED" : "BACKGROUND-PROBE-PARKED";
					message.content.push({ type: "text", text });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
				} else if (newer) {
					const call = { type: "toolCall" as const, id: "hold-newer", name: "probe_hold_foreground", arguments: {} };
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
				} else {
					for (const index of [0, 1]) {
						const call = { type: "toolCall" as const, id: `probe-job-${index}`, name: "bg_run", arguments: {
							name: `Harmless probe ${index}`, command: `node -e 'const fs=require("node:fs"); const t=setInterval(()=>{if(fs.existsSync(process.argv[1])) clearInterval(t)},25)' '${join(root, `job-${index}-release`)}'`, isAgent: false,
							notifyOnCompletion: queuedInterruption && index === 0, triggerOnCompletion: queuedInterruption && index === 0,
						} };
						message.content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: message });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: message });
					}
					if (queuedInterruption) {
						const call = { type: "toolCall" as const, id: "hold-initial", name: "probe_hold_foreground", arguments: { initial: true } };
						message.content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: 2, partial: message });
						stream.push({ type: "toolcall_delta", contentIndex: 2, delta: JSON.stringify(call.arguments), partial: message });
						stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: call, partial: message });
					}
				}
				stream.push({ type: "done", reason: final ? "stop" : "toolUse", message }); stream.end();
			});
			return stream;
		},
	});
}
