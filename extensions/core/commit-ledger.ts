/**
 * DevSpec Pi — the mechanical commit ledger (item efe7e0a7).
 *
 * An agent that commits through the bash tool should never TRANSCRIBE a commit
 * SHA — it should HAVE it. Ali watched a hand-typed SHA land wrong past the
 * short prefix (2026-08-12): "it should be mechanical, impossible to get
 * wrong." So: the extension sees every git commit/merge the agent makes, keeps
 * the SHAs itself, and record_implementation is validated against that ledger
 * (plus the repo's own object store) before anything reaches the server.
 *
 * Same principle class as mechanical-only delivery (cc9e8c43): the system
 * knows it, so the system says it — never the model's job to remember or
 * transcribe. Like all cross-extension state, the ledger lives on globalThis
 * (jiti gives every extension file a fresh module graph).
 */

import { execFileSync } from "node:child_process";

export interface LedgerCommit {
	/** Full SHA when the repo resolved it; the short SHA otherwise. */
	sha: string;
	shortSha: string;
	branch: string;
	at: number;
}

const GLOBAL_KEY = "__devspecPiCommitLedger";
const MAX_ENTRIES = 20;
/** A commit is a candidate for auto-fill for 30 minutes. */
const RECENT_MS = 30 * 60 * 1000;

interface LedgerStore {
	commits: LedgerCommit[];
}

function store(): LedgerStore {
	const g = globalThis as unknown as Record<string, LedgerStore | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { commits: [] };
	return g[GLOBAL_KEY] as LedgerStore;
}

export function recentCommits(): LedgerCommit[] {
	return [...store().commits];
}

function noteCommit(entry: LedgerCommit): void {
	const s = store();
	const existing = s.commits.findIndex((c) => c.sha === entry.sha);
	if (existing >= 0) s.commits.splice(existing, 1);
	s.commits.push(entry);
	if (s.commits.length > MAX_ENTRIES) s.commits.splice(0, s.commits.length - MAX_ENTRIES);
}

/** A resolver answers the full SHA for a rev, or null when it cannot. */
export type GitResolver = (rev: string) => string | null;

/** The real resolver: ask the repo at `cwd`. Worktrees share the object
 *  store, so a commit made in a linked worktree resolves from the main one. */
const GIT_REVISION = /^(?:HEAD|[0-9a-f]{7,40}(?:\^\{commit\})?)$/;
const COMMIT_SHA_INPUT = /^[0-9a-f]{7,40}$/;

export function repoResolver(cwd: string): GitResolver {
	return (rev: string) => {
		// rev-parse accepts revision syntax powerful enough to reach reflogs and,
		// when interpolated into a shell, arbitrary commands. This resolver needs
		// only HEAD or a hexadecimal commit candidate with an optional peel.
		if (!GIT_REVISION.test(rev)) return null;
		try {
			const out = execFileSync("git", ["rev-parse", "--verify", rev], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			})
				.toString()
				.trim();
			return /^[0-9a-f]{40}$/.test(out) ? out : null;
		} catch {
			return null;
		}
	};
}

const COMMIT_LINE = /^\[([^\s\]]+)\s+([0-9a-f]{7,10})\]/m;
const GIT_WRITE = /\bgit\s+(commit|merge)\b/;
const NO_NEW_COMMIT = /Already up to date|nothing to commit|nothing added to commit/i;

/** Parse the commit summary line git prints: `[branch shortsha] subject`. */
export function parseCommitOutput(output: string): { branch: string; shortSha: string } | null {
	const m = COMMIT_LINE.exec(output);
	if (!m) return null;
	return { branch: m[1], shortSha: m[2] };
}

/**
 * The watcher entry point — call from tool_execution_end for successful bash
 * calls. Returns the captured commit, or null when the command left no new
 * commit (non-git commands, failed writes, "Already up to date" merges).
 */
export function captureGitCommit(command: string, output: string, resolve: GitResolver): LedgerCommit | null {
	if (!GIT_WRITE.test(command)) return null;
	if (NO_NEW_COMMIT.test(output)) return null;

	const parsed = parseCommitOutput(output);
	if (parsed) {
		const full = resolve(parsed.shortSha) ?? parsed.shortSha;
		const entry: LedgerCommit = { sha: full, shortSha: parsed.shortSha, branch: parsed.branch, at: Date.now() };
		noteCommit(entry);
		return entry;
	}

	// Merges print no SHA ("Merge made by the 'ort' strategy") — HEAD is it.
	const head = resolve("HEAD");
	if (head) {
		const entry: LedgerCommit = { sha: head, shortSha: head.slice(0, 7), branch: "(merge)", at: Date.now() };
		noteCommit(entry);
		return entry;
	}
	return null;
}

function formatCandidates(commits: LedgerCommit[]): string {
	if (commits.length === 0) return "none observed this session";
	return commits.map((c) => `${c.shortSha} (${c.branch})`).join(", ");
}

export type CommitShaVerdict = { ok: true; sha: string; autoFilled: boolean } | { ok: false; error: string };

/**
 * Validate (or fill) the commit_sha for record_implementation — BEFORE the
 * server call. A SHA that neither matches the ledger nor resolves in the repo
 * is refused with the candidate list, so the model corrects immediately
 * instead of recording a broken link. (Tonight's incident: a hand-typed SHA
 * wrong past the short prefix would have been caught here.)
 */
export function validateCommitSha(input: string | undefined, resolve: GitResolver, now: number = Date.now()): CommitShaVerdict {
	const recent = recentCommits().filter((c) => now - c.at <= RECENT_MS);

	if (!input || !input.trim()) {
		if (recent.length === 1) return { ok: true, sha: recent[0].sha, autoFilled: true };
		return {
			ok: false,
			error:
				`record_implementation needs a commit_sha, and the ledger cannot pick one (recent commits: ${formatCandidates(recent)}). ` +
				`Run \`git rev-parse HEAD\` in the work tree and pass that.`,
		};
	}

	const sha = input;
	if (sha !== sha.trim() || !COMMIT_SHA_INPUT.test(sha)) {
		return {
			ok: false,
			error: "commit_sha must be 7–40 lowercase hexadecimal characters; revision syntax and shell text are not accepted.",
		};
	}
	const hit = recent.find((c) => c.sha === sha || c.sha.startsWith(sha));
	if (hit) return { ok: true, sha: hit.sha, autoFilled: false };

	const resolved = resolve(`${sha}^{commit}`);
	if (resolved) return { ok: true, sha: resolved, autoFilled: false };

	return {
		ok: false,
		error:
			`commit_sha ${sha} resolves nowhere — not in this session's ledger, not a commit in this repo. ` +
			`Recent commits: ${formatCandidates(recent)}. Check with \`git rev-parse HEAD\` and pass the real SHA.`,
	};
}
