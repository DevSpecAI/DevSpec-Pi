/** Runtime qualification only: a model call is a test failure, never a paid run. */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	const failed = () => {
		if (process.env.ROOM_PROBE_MODEL_MARKER) writeFileSync(process.env.ROOM_PROBE_MODEL_MARKER, "unexpected model turn");
		throw new Error("room-store probe forbids model execution");
	};
	pi.on("agent_start", failed);
	pi.registerProvider("room-probe", {
		baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "fixture-only",
		models: [{ id: "no-model", name: "No-model runtime probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
		streamSimple: failed,
	});
}
