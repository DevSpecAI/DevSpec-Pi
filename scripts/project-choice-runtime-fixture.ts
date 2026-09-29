/** Deterministic runtime probe: no real provider, token or DevSpec writes. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callDevspec } from "../extensions/core/client.ts";
import { getProjectChoice } from "../extensions/core/project-choice.ts";
import { patchStatus, paintStatus } from "../extensions/core/status-line.ts";
export default function (pi: ExtensionAPI) {
	pi.registerCommand("footer-probe", {
		description: "Render a known work footer in the disposable runtime probe",
		handler: async (_args, ctx) => {
			patchStatus({ codename: "Proud Eagle", sessionId: "fixture-room", sessionTitle: "Planning checkout with the customer team", workId: "fixture-item", workTitle: "Improve checkout navigation on mobile" });
			ctx.ui.setStatus("bg-probe", "BG 1 done");
			ctx.ui.setStatus("mcp-probe", "MCP 4 servers");
			paintStatus(ctx);
		},
	});
	pi.registerCommand("project-probe", {
		description: "Project-selection runtime probe only",
		handler: async (args, ctx) => {
			await callDevspec("fixture-only-not-a-real-token", "get_project_summary", {}, { cwd: ctx.cwd });
			ctx.ui.notify(`PROJECT-PROBE-PASS ${args.trim()} ${getProjectChoice()?.project.id}`, "info");
		},
	});
}
