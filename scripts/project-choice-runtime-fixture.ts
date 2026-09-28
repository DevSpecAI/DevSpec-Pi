/** Deterministic runtime probe: no real provider, token or DevSpec writes. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callDevspec } from "../extensions/core/client.ts";
import { getProjectChoice } from "../extensions/core/project-choice.ts";
export default function (pi: ExtensionAPI) {
	pi.registerCommand("project-probe", {
		description: "Project-selection runtime probe only",
		handler: async (args, ctx) => {
			await callDevspec("fixture-only-not-a-real-token", "get_project_summary", {}, { cwd: ctx.cwd });
			ctx.ui.notify(`PROJECT-PROBE-PASS ${args.trim()} ${getProjectChoice()?.project.id}`, "info");
		},
	});
}
