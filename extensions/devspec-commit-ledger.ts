/**
 * DevSpec Pi — the commit-ledger watcher (item efe7e0a7).
 *
 * Sees every successful bash git commit/merge the agent makes and captures
 * the SHA into the ledger (core/commit-ledger.ts) — so record_implementation
 * never depends on the model transcribing a SHA by hand. Zero tokens, no
 * model involvement: capture at the source, validate at the write.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureGitCommit, repoResolver } from "./core/commit-ledger.ts";
import { debugRemote } from "./core/debug.ts";

function commandOf(args: unknown): string {
	const a = args as { command?: unknown } | null;
	return typeof a?.command === "string" ? a.command : "";
}

function outputOf(result: unknown): string {
	const r = result as { content?: Array<{ type?: string; text?: string }> } | null;
	if (!r || !Array.isArray(r.content)) return "";
	return r.content
		.filter((p) => p && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	// tool_execution_end carries no args — the command is known at start, so
	// remember it by call id (bounded; entries are deleted at end).
	const pending = new Map<string, string>();

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "bash") return;
		pending.set(event.toolCallId, commandOf(event.args));
		if (pending.size > 50) {
			const oldest = pending.keys().next().value;
			if (oldest) pending.delete(oldest);
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const command = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!command || event.isError) return;
		const captured = captureGitCommit(command, outputOf(event.result), repoResolver(ctx.cwd));
		if (captured) debugRemote("commit ledger captured");
	});
}
