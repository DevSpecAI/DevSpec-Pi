/** Deterministic runtime probe: no real provider, token or DevSpec writes. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callDevspec } from "../extensions/core/client.ts";
import { getProjectChoice } from "../extensions/core/project-choice.ts";
import { getBond } from "../extensions/core/bond-state.ts";
import assert from "node:assert/strict";
import { patchStatus, paintStatus } from "../extensions/core/status-line.ts";
export default function (pi: ExtensionAPI) {
	pi.registerCommand("footer-theme-probe", {
		description: "Check semantic foreground and muted roles in the actual Pi renderer",
		handler: async (args, ctx) => {
			const name = args.split(" ")[0] || "dark";
			const result = ctx.ui.setTheme(name);
			if (!result.success) throw new Error(result.error);
			if (!args.includes("--hot")) {
				patchStatus({ automationName: "Daily review" });
				paintStatus(ctx);
			}
			writeFileSync(join(process.env.PROJECT_PROBE_TEMP!, "theme-expectations.json"), JSON.stringify({
				foreground: ["DevSpec: ", "Proud Eagle", "Planning checkout with the customer team", "Daily review", "Improve checkout navigation on mobile"].map(text => ctx.ui.theme.fg("text", text)),
				muted: ["Client Website", " · ", "automation “"].map(text => ctx.ui.theme.fg("dim", text)),
			}));
			ctx.ui.notify(`FOOTER-THEME ${name}`, "info");
		},
	});
	pi.registerCommand("footer-probe", {
		description: "Render a known work footer in the disposable runtime probe",
		handler: async (_args, ctx) => {
			patchStatus({ codename: "Proud Eagle", sessionId: "fixture-room", sessionTitle: "Planning checkout with the customer team", workId: "fixture-item", workTitle: "Improve checkout navigation on mobile", automationName: undefined });
			ctx.ui.setStatus("bg-probe", "BG 1 done");
			ctx.ui.setStatus("mcp-probe", "MCP 4 servers");
			paintStatus(ctx);
		},
	});
	pi.registerCommand("project-probe", {
		description: "Project-selection runtime probe only",
		handler: async (args, ctx) => {
			await callDevspec("fixture-only-not-a-real-token", "get_project_summary", {}, { cwd: ctx.cwd });
			const facts = getBond()?.repositoryContext;
			assert.ok(facts, "registration delivered a repository snapshot");
			const data = JSON.parse(facts.split("<devspec-repository-data>\n")[1]!.split("\n</devspec-repository-data>")[0]!);
			assert.equal(data.project_id, getProjectChoice()?.project.id);
			assert.equal(data.status, "available");
			assert.equal(data.repositories[0].git_url, `https://example.test/${data.project_id}.git`);
			assert.equal(data.repositories[0].target_branch, "staging");
			ctx.ui.notify(`PROJECT-PROBE-PASS ${args.trim()} ${getProjectChoice()?.project.id}`, "info");
		},
	});
}
