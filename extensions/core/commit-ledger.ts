/**
 * DevSpec Pi — the mechanical commit ledger (item efe7e0a7).
 *
 * An agent that commits through the bash tool should never TRANSCRIBE a commit
 * SHA — it should HAVE it. Ali watched a hand-typed SHA land wrong past the
 * short prefix (2026-08-12): "it should be mechanical, impossible to get
 * wrong." So: the extension recognizes ordinary Git commit/merge result output,
 * keeps the resulting SHAs, and can corroborate an explicitly supplied full object.
 * Missing/short hints stay missing/short: only the server's scoped evidence can
 * select an implementation commit or establish project-wide prefix uniqueness.
 *
 * Same principle class as mechanical-only delivery (cc9e8c43): when the system
 * knows the SHA, it says it — never the model's job to remember or transcribe.
 * This is accuracy assistance, not provenance-source proof. Like all cross-extension
 * state, the ledger lives on globalThis
 * (jiti gives every extension file a fresh module graph).
 */

import { execFileSync } from "node:child_process";

export interface LedgerCommit {
	/** Full SHA when the repo resolved it; the short SHA otherwise. */
	sha: string;
	shortSha: string;
	branch: string;
	at: number;
	/** Actual commit-object message observed after a recognized Pi Bash commit. */
	commitMessage?: string;
}

const GLOBAL_KEY = "__devspecPiCommitLedger";
const MAX_ENTRIES = 20;
/** Retain recent explicit-object metadata for 30 minutes; never infer work identity. */
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
	return store().commits.map((commit) => ({ ...commit }));
}

export function recordObservedCommit(entry: LedgerCommit): void {
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

/** Read the immutable commit object's message without a shell. */
export function repoCommitMessage(cwd: string, sha: string): string | null {
	if (!/^[0-9a-f]{40}$/u.test(sha)) return null;
	try {
		return execFileSync("git", ["show", "-s", "--format=%B", sha], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		}).toString().replace(/\n+$/u, "");
	} catch {
		return null;
	}
}

/** Attach the immutable commit message to one already captured ledger entry. */
export function annotateCommitMessage(sha: string, message: string): LedgerCommit | null {
	const entry = store().commits.find((commit) => commit.sha === sha);
	if (!entry) return null;
	entry.commitMessage = message;
	return { ...entry };
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
		recordObservedCommit(entry);
		return entry;
	}

	// Merge output does not identify the resulting object. Without a first-class
	// Git hook or a before/after observation, resolving HEAD could capture an old
	// commit after arbitrary Bash text. Fail open: require an explicit SHA later.
	return null;
}

export type CommitShaVerdict = {
	ok: true;
	/** The sha to send, or null to send none (the server's own fill runs). */
	sha: string | null;
	/** Retained result shape; caller hints are never locally auto-filled. */
	autoFilled: boolean;
	/**
	 * True for every short hint or an uncorroborated full object. Local prefix
	 * matches cannot establish uniqueness across the project. Hints pass to the
	 * server unchanged for scoped resolution/provisional storage (ADR 60efaed0).
	 * A local miss is never an identity verdict in a multi-repo project.
	 */
	unverified?: boolean;
	commitMessage?: string;
} | { ok: false; error: string };

function ledgerVerdict(commit: LedgerCommit, input: string): CommitShaVerdict {
	return {
		ok: true,
		sha: input,
		autoFilled: false,
		...(commit.commitMessage ? { commitMessage: commit.commitMessage } : {}),
	};
}

/**
 * Validate commit_sha shape before record_implementation. A full object can
 * carry locally corroborated message bytes, never authorship or round proof.
 * A sole recent commit is NOT an item/claim binding (P7 / e47fcd4e: report-only
 * P6 inherited the preceding P4 commit). A cwd or ledger prefix match is NOT
 * project-wide uniqueness. Preserve omissions and every supplied hint's bytes
 * for the server's scoped resolver. Only malformed normalized shapes refuse;
 * local misses, ambiguous prefixes and absent hints always remain fail-open.
 */
export function validateCommitSha(input: string | undefined, resolve: GitResolver, now: number = Date.now()): CommitShaVerdict {
	if (input == null || (typeof input === "string" && !input.trim())) {
		return { ok: true, sha: null, autoFilled: false, unverified: true };
	}
	const normalized = typeof input === "string" ? input.trim().toLowerCase() : "";
	if (!COMMIT_SHA_INPUT.test(normalized)) {
		return {
			ok: false,
			error: "commit_sha must contain 7–40 hexadecimal characters; revision syntax and shell text are not accepted.",
		};
	}
	if (normalized.length < 40) return { ok: true, sha: input, autoFilled: false, unverified: true };

	const recent = recentCommits().filter((c) => now - c.at <= RECENT_MS);
	const hit = recent.find((c) => c.sha === normalized);
	if (hit) return ledgerVerdict(hit, input);

	const resolved = resolve(`${normalized}^{commit}`);
	if (resolved === normalized) return { ok: true, sha: input, autoFilled: false };
	return { ok: true, sha: input, autoFilled: false, unverified: true };
}
