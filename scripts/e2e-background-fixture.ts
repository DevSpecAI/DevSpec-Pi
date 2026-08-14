import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Deterministic automatic-wake task fixture for e2e-lifecycle phase 3. */
export default function e2eBackgroundFixture(pi: ExtensionAPI): void {
	const timers = new Set<ReturnType<typeof setTimeout>>();

	pi.registerTool({
		// e2e-lifecycle launches Pi with -ne, so no production background package
		// is loaded. Override the real launch identity to exercise the same
		// allowlisted tool_execution_end path without widening production code.
		name: "bg_run",
		label: "E2E bg_run fixture",
		description: "Start one deterministic automatic-wake background task for the lifecycle E2E",
		parameters: Type.Object({
			id: Type.String(),
			delay_ms: Type.Integer({ minimum: 1 }),
			completion_instruction: Type.String(),
		}),
		async execute(_toolCallId, params) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				pi.sendMessage({
					customType: "background-task-notification",
					content: [
						"<background-task-notification>",
						`  <task-id>${params.id}</task-id>`,
						"  <status>completed</status>",
						`  <summary>${params.completion_instruction}</summary>`,
						"</background-task-notification>",
					].join("\n"),
					display: true,
					details: { id: params.id, status: "completed" },
				}, { triggerTurn: true, deliverAs: "followUp" });
			}, params.delay_ms);
			if (typeof timer.unref === "function") timer.unref();
			timers.add(timer);
			return {
				content: [{ type: "text", text: `Started automatic-wake task ${params.id}.` }],
				details: {
					task: {
						id: params.id,
						status: "running",
						notifyOnCompletion: true,
						triggerOnCompletion: true,
					},
				},
			};
		},
	});

	pi.on("session_shutdown", () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	});
}
