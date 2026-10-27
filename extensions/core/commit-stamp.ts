/**
 * Host side of commit tag stamping (DevSpec item df71ab6c).
 *
 * Pi's git stand-in tags a plain commit with the claimed task's
 * `[devspec:<uuid>]` (runtime/commit-stamp.mjs). This module decides what the
 * stand-in is armed with for one Bash call, and words what the model is told
 * about each commit it made. How tags link commits to work is the served
 * contract's commit_provenance_contract; nothing here blocks a commit.
 */

import { createHash } from "node:crypto";
import type { CommitStampReport, CommitStampScope } from "./git-observer.ts";
import type { ObservedClaim } from "./work-state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CommitStampDeps {
	/** This conversation's observed claims. */
	claims(sessionId: string): ObservedClaim[];
	/** The raw `git remote get-url origin` of a directory, or null. */
	originUrl(cwd: string): Promise<string | null>;
	/** The project a directory positively belongs to (pin or server-verified remote), or null. */
	resolveProject(cwd: string): Promise<string | null>;
}

export function originFingerprint(url: string): string {
	return createHash("sha256").update(url.trim()).digest("hex");
}

/**
 * What to arm the stand-in with, or null when no task is claimed in this project.
 * The task id goes only with exactly one claim. The origin fingerprint goes only
 * when the call's own directory is verified to belong to the project; the stand-in
 * also accepts a pin naming the project, and leaves every other repository alone.
 */
export async function commitStampScope(input: { sessionId: string; projectId: string; cwd: string }, deps: CommitStampDeps): Promise<CommitStampScope | null> {
	if (!UUID.test(input.projectId)) return null;
	const projectId = input.projectId.toLowerCase();
	const claims = deps.claims(input.sessionId)
		.filter((claim) => UUID.test(claim.taskId) && (!claim.projectId || claim.projectId.toLowerCase() === projectId));
	const taskIds = [...new Set(claims.map((claim) => claim.taskId.toLowerCase()))];
	if (taskIds.length === 0) return null;
	let remoteSha256: string | null = null;
	try {
		const url = await deps.originUrl(input.cwd);
		if (url?.trim() && (await deps.resolveProject(input.cwd))?.toLowerCase() === projectId) remoteSha256 = originFingerprint(url);
	} catch { remoteSha256 = null; }
	return { projectId, claimCount: taskIds.length, taskId: taskIds.length === 1 ? taskIds[0]! : null, remoteSha256 };
}

const REASON_WORDS: Readonly<Record<string, string>> = {
	amend: "it amends an earlier commit",
	fixup: "it is a fixup commit",
	squash: "it is a squash commit",
	reuse_message: "it reuses another commit's message",
	no_edit: "it keeps an earlier commit's message",
	edit: "its message is edited in an editor",
	editor: "its message was written in an editor",
	template: "its message starts from a template",
	interactive: "it was made interactively",
	unrecognised_option: "it uses a git commit option Pi does not read",
	conflicting_messages: "it names its message more than once",
	not_plain_commit: "it was not run as a plain git commit",
	message_file_unreadable: "Pi could not read its message file",
	message_unreadable: "Pi could not read its message",
	terminal_stdin: "its message was typed at a terminal",
	no_subject: "its message has no line the tag could go on",
};

/**
 * The line the model reads under the command's output, or null. A commit outside
 * the project, or one that already names a task, needs nothing said.
 */
export function commitStampNote(commit: { sha: string; stamp?: CommitStampReport }): string | null {
	const stamp = commit.stamp;
	if (!stamp) return null;
	const short = commit.sha.slice(0, 7);
	if (stamp.outcome === "stamped" && stamp.task) {
		return `DevSpec: Pi added [devspec:${stamp.task}] to the message of commit ${short}, for the one task claimed in this conversation.`;
	}
	if (stamp.reason === "outside_project" || stamp.reason === "has_reference") return null;
	if (stamp.reason === "several_claims") {
		return `DevSpec: Pi did not add a task tag to commit ${short}: ${stamp.claims} tasks are claimed in this conversation, so it cannot tell which one this commit is for. Write the right task's [devspec:<full-uuid>] into the message yourself.`;
	}
	const why = (stamp.reason && REASON_WORDS[stamp.reason]) ?? "its message could not be changed safely";
	return `DevSpec: Pi did not add [devspec:${stamp.task}] to commit ${short}, because ${why}. If this commit is for that task, write the tag into its message yourself.`;
}
