/**
 * Capability-honest provenance assistance for Pi.
 *
 * Pi exposes reliable first-class file edit calls, so an explicitly associated
 * project may receive one advisory nudge. Pi does not expose a first-class Git
 * commit-message or outgoing-push hook, so this extension never parses arbitrary
 * shell text, rewrites commits, blocks tools, or claims push enforcement.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveProjectPin, writeProjectPin } from "./core/project-scope.ts";
import { hasObservedClaim, markProjectNudged } from "./core/work-state.ts";

const RELIABLE_EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "notebook"]);
const FULL_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProvenanceRuntime {
	cwd: string;
	sessionManager: { getSessionId(): string };
}

export interface ProvenanceNudge {
	customType: "devspec-provenance-nudge";
	content: string;
	display: true;
	details: { projectId: string };
}

export async function unclaimedEditNudge(
	toolName: string,
	runtime: ProvenanceRuntime,
	pinResolver: (cwd: string) => Promise<string | null> = resolveProjectPin,
): Promise<ProvenanceNudge | null> {
	if (!RELIABLE_EDIT_TOOLS.has(toolName)) return null;
	const sessionId = runtime.sessionManager.getSessionId();
	if (hasObservedClaim(sessionId)) return null;

	// A pin is positive local jurisdiction. A git remote alone proves only that
	// this is a repository, not that the current folder belongs to this DevSpec
	// project. Every absent/malformed/read-error state therefore fails open.
	const projectId = await pinResolver(runtime.cwd);
	if (!projectId || !FULL_PROJECT_ID.test(projectId) || !markProjectNudged(sessionId, projectId)) return null;
	return {
		customType: "devspec-provenance-nudge",
		content:
			`DevSpec provenance note: this folder is explicitly associated with project ${projectId}, ` +
			"but this Pi session has not observed an active claim. Continue this edit—editing is never blocked. " +
			"Before committing, use search_action_items to find and claim the covering item; if none exists, " +
			"create and claim a thin last-mile item. Pi cannot add the [devspec:<full-uuid>] commit reference for you, " +
			"so include it in the commit message yourself.",
		display: true,
		details: { projectId },
	};
}

export default function (pi: ExtensionAPI): void {
	// Work observations live on globalThis and are keyed by Pi session id, so a
	// /reload cannot re-arm a nudge or forget an already observed claim.
	pi.on("tool_call", async (event, ctx) => {
		const nudge = await unclaimedEditNudge(event.toolName, ctx);
		if (nudge) pi.sendMessage(nudge, { deliverAs: "steer", triggerTurn: false });
		// Advisory only: every tool call always proceeds.
		return undefined;
	});

	pi.registerCommand("devspec.pin", {
		description: "Explicitly associate this repository/folder with a DevSpec project id.",
		handler: async (args, ctx) => {
			const projectId = args.trim();
			if (!FULL_PROJECT_ID.test(projectId)) {
				ctx.ui.notify("Usage: /devspec.pin <full-project-uuid>", "warning");
				return;
			}
			try {
				const result = await writeProjectPin(ctx.cwd, projectId);
				const replacement = result.replaced ? ` (replaced ${result.replaced})` : "";
				ctx.ui.notify(`DevSpec project association written to ${result.path}${replacement}.`, "info");
			} catch (error) {
				// Project association assists local scoping; failure never blocks work.
				ctx.ui.notify(`DevSpec could not write the project association: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});
}
