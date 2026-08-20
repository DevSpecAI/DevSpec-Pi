/**
 * DevSpec Pi — the commit-ledger watcher (item efe7e0a7).
 *
 * Recognizes successful Bash Git commit/merge output and captures the resulting
 * SHA into the ledger (core/commit-ledger.ts), then reads the immutable commit
 * message without a shell. This improves record_implementation accuracy but is
 * not a first-class Git hook and therefore never claims source attribution.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { getBond } from "./core/bond-state.ts";
import { callDevspec } from "./core/client.ts";
import {
	annotateCommitMessage,
	captureGitCommit,
	repoCommitMessage,
	repoResolver,
	type LedgerCommit,
} from "./core/commit-ledger.ts";
import { debugRemote } from "./core/debug.ts";
import { resolveGitRemote, resolveProjectPin } from "./core/project-scope.ts";
import { unwrapMcpResult } from "./core/result.ts";

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

const FULL_SHA = /^[0-9a-f]{40}$/iu;
const FULL_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ReporterDeps {
	getBond(): { connectionId: string } | null;
	resolveToken(): Promise<{ token: string } | null>;
	resolveGitRemote(cwd: string): Promise<string | null>;
	resolveProjectPin(cwd: string): Promise<string | null>;
	call(
		token: string,
		name: string,
		args: Record<string, unknown>,
		options?: { lane?: "work" | "pump"; timeoutMs?: number; cwd?: string },
	): Promise<unknown>;
}

const reporterDeps: ReporterDeps = {
	getBond,
	resolveToken,
	resolveGitRemote,
	resolveProjectPin,
	call: callDevspec,
};

function hasUniqueRemoteMatch(raw: unknown): boolean {
	const result = unwrapMcpResult(raw);
	if (result.isError || !result.details || typeof result.details !== "object") return false;
	const remoteMatch = (result.details as { remote_match?: unknown }).remote_match;
	return Boolean(
		remoteMatch &&
			typeof remoteMatch === "object" &&
			typeof (remoteMatch as { resolved_project_id?: unknown }).resolved_project_id === "string",
	);
}

/**
 * Report one commit the existing ledger already captured. This never widens
 * command recognition: quiet/opaque forms the ledger cannot prove remain
 * unknown rather than guessed. The server treats the exact connection as a
 * measurement only; it grants no authority.
 */
export async function reportCapturedCommit(
	commit: LedgerCommit,
	cwd: string,
	deps: ReporterDeps = reporterDeps,
): Promise<boolean> {
	if (!FULL_SHA.test(commit.sha)) return false;
	const bond = deps.getBond();
	if (!bond?.connectionId) return false;
	const resolved = await deps.resolveToken().catch(() => null);
	if (!resolved?.token) return false;

	try {
		// Positive jurisdiction is required before attributing local Git state to
		// the bonded project. An explicit pin is sufficient. Otherwise prove that
		// this checkout's remote maps uniquely to a project before reporting.
		const [pin, remote] = await Promise.all([
			deps.resolveProjectPin(cwd).catch(() => null),
			deps.resolveGitRemote(cwd).catch(() => null),
		]);
		let jurisdiction = typeof pin === "string" && FULL_PROJECT_ID.test(pin);
		if (!jurisdiction && remote) {
			const match = await deps.call(
				resolved.token,
				"list_projects",
				{ git_remote: remote },
				{ lane: "work", timeoutMs: 10_000 },
			);
			jurisdiction = hasUniqueRemoteMatch(match);
		}
		if (!jurisdiction) return false;

		await deps.call(
			resolved.token,
			"report_commit_provenance",
			{
				connection_id: bond.connectionId,
				commit_sha: commit.sha,
				branch: commit.branch,
			},
			{ lane: "work", timeoutMs: 10_000 },
		);
		return true;
	} catch {
		// Provenance is best-effort and strictly post-commit. No transport,
		// authentication, scoping, or server failure may affect the Bash result.
		return false;
	}
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
		if (!captured) return;
		const message = repoCommitMessage(ctx.cwd, captured.sha);
		if (message !== null) annotateCommitMessage(captured.sha, message);
		debugRemote("commit ledger captured");
		// Fire-and-forget after the commit has already succeeded. The reporter
		// catches every failure internally and cannot alter this tool result.
		void reportCapturedCommit(captured, ctx.cwd);
	});
}
