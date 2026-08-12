import assert from "node:assert/strict";
import { test } from "node:test";
import {
	captureGitCommit,
	parseCommitOutput,
	recentCommits,
	validateCommitSha,
	type GitResolver,
} from "../extensions/core/commit-ledger.ts";

const FULL = "fbe44cdd05c52551e70119e28fdf3d8cb6e47e3a";
const resolverReturning = (sha: string | null): GitResolver => () => sha;

test("parseCommitOutput reads the [branch shortsha] summary line", () => {
	const out = "[fix/outro-leak-857d984c fbe44cd] fix(remote): never mirror\n 2 files changed\n";
	assert.deepEqual(parseCommitOutput(out), { branch: "fix/outro-leak-857d984c", shortSha: "fbe44cd" });
	assert.equal(parseCommitOutput("On branch main\nnothing to commit"), null);
});

test("a successful git commit is captured with the resolved full SHA", () => {
	const entry = captureGitCommit(
		"git commit -m 'feat: x'",
		"[feat/x fbe44cd] feat: x\n 1 file changed",
		resolverReturning(FULL),
	);
	assert.ok(entry);
	assert.equal(entry.sha, FULL);
	assert.equal(entry.shortSha, "fbe44cd");
	assert.ok(recentCommits().some((c) => c.sha === FULL));
});

test("a merge captures HEAD (merges print no SHA)", () => {
	const entry = captureGitCommit("git merge --no-ff feat/x", "Merge made by the 'ort' strategy.", resolverReturning(FULL));
	assert.ok(entry);
	assert.equal(entry.sha, FULL);
});

test("non-git commands and no-op writes never populate the ledger (no false candidates)", () => {
	const before = recentCommits().length;
	assert.equal(captureGitCommit("npm test", "87 passing", resolverReturning(FULL)), null);
	assert.equal(captureGitCommit("git status", "On branch main", resolverReturning(FULL)), null);
	assert.equal(captureGitCommit("git merge feat/x", "Already up to date.", resolverReturning(FULL)), null);
	assert.equal(recentCommits().length, before);
});

test("validate: an exact ledger SHA passes; a prefix resolves to the full SHA", () => {
	captureGitCommit("git commit -m x", "[feat/a aaa1111] x", resolverReturning("aaa111105c52551e70119e28fdf3d8cb6e47e3a000"));
	const exact = validateCommitSha("aaa111105c52551e70119e28fdf3d8cb6e47e3a000", resolverReturning(null));
	assert.deepEqual(exact, { ok: true, sha: "aaa111105c52551e70119e28fdf3d8cb6e47e3a000", autoFilled: false });
	const prefix = validateCommitSha("aaa1111", resolverReturning(null));
	assert.deepEqual(prefix, { ok: true, sha: "aaa111105c52551e70119e28fdf3d8cb6e47e3a000", autoFilled: false });
});

test("validate: a SHA that resolves nowhere is REFUSED with the candidate list", () => {
	const verdict = validateCommitSha("deadbeef05c52551e70119e28fdf3d8cb6e47e3a", resolverReturning(null));
	assert.equal(verdict.ok, false);
	if (!verdict.ok) {
		assert.match(verdict.error, /resolves nowhere/);
		assert.match(verdict.error, /aaa1111/, "the error names the observed candidates");
	}
});

test("validate: a SHA unknown to the ledger but real in the repo passes (resolved full)", () => {
	const verdict = validateCommitSha("bbb2222", resolverReturning("bbb222205c52551e70119e28fdf3d8cb6e47e3a0000"));
	assert.deepEqual(verdict, { ok: true, sha: "bbb222205c52551e70119e28fdf3d8cb6e47e3a0000", autoFilled: false });
});

function resetLedger(): void {
	(globalThis as unknown as Record<string, unknown>).__devspecPiCommitLedger = { commits: [] };
}

test("validate: omitted SHA auto-fills when exactly one recent commit exists", () => {
	resetLedger();
	captureGitCommit("git commit -m y", "[feat/b ccc3333] y", resolverReturning("ccc333305c52551e70119e28fdf3d8cb6e47e3a00000"));
	const verdict = validateCommitSha(undefined, resolverReturning(null));
	assert.deepEqual(verdict, { ok: true, sha: "ccc333305c52551e70119e28fdf3d8cb6e47e3a00000", autoFilled: true });
});

test("validate: omitted SHA with no or multiple candidates is an honest error", () => {
	resetLedger();
	const none = validateCommitSha(undefined, resolverReturning(null));
	assert.equal(none.ok, false);
	if (!none.ok) assert.match(none.error, /none observed this session/);

	resetLedger();
	captureGitCommit("git commit -m a", "[feat/a aaa1111] a", resolverReturning("aaa111105c52551e70119e28fdf3d8cb6e47e3a000"));
	captureGitCommit("git commit -m b", "[feat/b bbb2222] b", resolverReturning("bbb222205c52551e70119e28fdf3d8cb6e47e3a0000"));
	const several = validateCommitSha(undefined, resolverReturning(null));
	assert.equal(several.ok, false);
	if (!several.ok) {
		assert.match(several.error, /aaa1111/);
		assert.match(several.error, /bbb2222/);
	}
});
