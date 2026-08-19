import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	annotateCommitMessage,
	captureGitCommit,
	parseCommitOutput,
	recentCommits,
	repoCommitMessage,
	repoResolver,
	validateCommitSha,
	type GitResolver,
} from "../extensions/core/commit-ledger.ts";

const FULL = "fbe44cdd05c52551e70119e28fdf3d8cb6e47e3a";
const FULL_A = "aaa111105c52551e70119e28fdf3d8cb6e47e3a";
const FULL_B = "bbb222205c52551e70119e28fdf3d8cb6e47e3a";
const FULL_C = "ccc333305c52551e70119e28fdf3d8cb6e47e3a";
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

test("merge output without an object id fails open instead of guessing HEAD", () => {
	assert.equal(
		captureGitCommit("git merge --no-ff feat/x", "Merge made by the 'ort' strategy.", resolverReturning(FULL)),
		null,
	);
	assert.equal(
		captureGitCommit("printf 'git merge\\nMerge made by the ort strategy'", "Merge made by the ort strategy", resolverReturning(FULL)),
		null,
	);
});

test("non-git commands and no-op writes never populate the ledger (no false candidates)", () => {
	const before = recentCommits().length;
	assert.equal(captureGitCommit("npm test", "87 passing", resolverReturning(FULL)), null);
	assert.equal(captureGitCommit("git status", "On branch main", resolverReturning(FULL)), null);
	assert.equal(captureGitCommit("git merge feat/x", "Already up to date.", resolverReturning(FULL)), null);
	assert.equal(captureGitCommit("echo git commit", "git commit", resolverReturning(FULL)), null);
	assert.equal(captureGitCommit("printf 'git merge'", "unrelated output", resolverReturning(FULL)), null);
	assert.equal(recentCommits().length, before);
});

test("recognized commit output attaches the actual object message without claiming its source", () => {
	resetLedger();
	captureGitCommit("git commit -m x", "[feat/a aaa1111] x", resolverReturning(FULL_A));
	const message = `feat: linked\n\n[devspec:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]`;
	assert.equal(annotateCommitMessage(FULL_A, message)?.commitMessage, message);
	assert.deepEqual(validateCommitSha(FULL_A, resolverReturning(null)), {
		ok: true,
		sha: FULL_A,
		autoFilled: false,
		commitMessage: message,
	});
});

test("validate: an exact ledger SHA passes; a prefix resolves to the full SHA", () => {
	captureGitCommit("git commit -m x", "[feat/a aaa1111] x", resolverReturning(FULL_A));
	const exact = validateCommitSha(FULL_A, resolverReturning(null));
	assert.deepEqual(exact, { ok: true, sha: FULL_A, autoFilled: false });
	const prefix = validateCommitSha("aaa1111", resolverReturning(null));
	assert.deepEqual(prefix, { ok: true, sha: FULL_A, autoFilled: false });
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
	const verdict = validateCommitSha("bbb2222", resolverReturning(FULL_B));
	assert.deepEqual(verdict, { ok: true, sha: FULL_B, autoFilled: false });
});

function resetLedger(): void {
	(globalThis as unknown as Record<string, unknown>).__devspecPiCommitLedger = { commits: [] };
}

test("validate: omitted SHA auto-fills when exactly one recent commit exists", () => {
	resetLedger();
	captureGitCommit("git commit -m y", "[feat/b ccc3333] y", resolverReturning(FULL_C));
	const verdict = validateCommitSha(undefined, resolverReturning(null));
	assert.deepEqual(verdict, { ok: true, sha: FULL_C, autoFilled: true });
});

test("validate: omitted SHA with no or multiple candidates is an honest error", () => {
	resetLedger();
	const none = validateCommitSha(undefined, resolverReturning(null));
	assert.equal(none.ok, false);
	if (!none.ok) assert.match(none.error, /none observed this session/);

	resetLedger();
	captureGitCommit("git commit -m a", "[feat/a aaa1111] a", resolverReturning(FULL_A));
	captureGitCommit("git commit -m b", "[feat/b bbb2222] b", resolverReturning(FULL_B));
	const several = validateCommitSha(undefined, resolverReturning(null));
	assert.equal(several.ok, false);
	if (!several.ok) {
		assert.match(several.error, /aaa1111/);
		assert.match(several.error, /bbb2222/);
	}
});

test("repoCommitMessage reads immutable bytes for a strict full SHA", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "devspec-ledger-message-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["-c", "user.name=DevSpec Test", "-c", "user.email=test@devspec.local", "commit", "--allow-empty", "-q", "-m", "feat: actual", "-m", "[devspec:aaaaaaaa]"], { cwd });
	const sha = repoResolver(cwd)("HEAD");
	assert.ok(sha);
	assert.equal(repoCommitMessage(cwd, sha), "feat: actual\n\n[devspec:aaaaaaaa]");
	assert.equal(repoCommitMessage(cwd, `${sha};touch bad`), null);
});

test("repo resolver rejects revision-shell injection before spawning git", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "devspec-ledger-injection-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd });
	const marker = join(cwd, "injected");
	const malicious = `HEAD;touch ${marker}`;
	assert.equal(repoResolver(cwd)(malicious), null);
	assert.equal(existsSync(marker), false);
	const verdict = validateCommitSha(malicious, repoResolver(cwd));
	assert.equal(verdict.ok, false);
	if (!verdict.ok) assert.match(verdict.error, /lowercase hexadecimal/);
	assert.equal(existsSync(marker), false);
	assert.equal(validateCommitSha(` ${FULL}`, repoResolver(cwd)).ok, false, "padded revisions are invalid");
	assert.equal(validateCommitSha(`${FULL} `, repoResolver(cwd)).ok, false, "padded revisions are invalid");
});

test("repo resolver accepts only HEAD or strict hexadecimal commit revisions", (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "devspec-ledger-revision-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd });
	const resolve = repoResolver(cwd);
	for (const revision of ["main", "HEAD@{0}", "HEAD --help", "abc", "ABCDEF1", `${FULL}^{tree}`]) {
		assert.equal(resolve(revision), null, revision);
	}
	// A hostile alias/config entry cannot replace the rev-parse builtin and no
	// shell is involved in argument handling.
	execFileSync("git", ["config", "alias.rev-parse", "!touch hostile-config-ran"], { cwd });
	assert.equal(resolve("HEAD"), null, "an unborn repository has no HEAD");
	assert.equal(existsSync(join(cwd, "hostile-config-ran")), false);
});
