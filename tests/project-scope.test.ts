import assert from "node:assert/strict";
import { test } from "node:test";
import {
	needsProjectScope,
	resolveGitRemote,
	sanitizeGitRemoteForTransport,
	clearGitRemoteCache,
	resolveProjectPin,
	clearProjectPinCache,
	writeProjectPin,
} from "../extensions/core/project-scope.ts";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("needsProjectScope matches multi-project resolution failures", () => {
	assert.ok(needsProjectScope("You have multiple accessible projects; pass git_remote or project_id"));
	assert.ok(needsProjectScope("Could not resolve which project this call belongs to"));
	assert.ok(needsProjectScope("unable to determine project from context"));
});

test("needsProjectScope ignores auth and ordinary failures", () => {
	assert.ok(!needsProjectScope("DevSpec rejected the token (invalid or revoked)"));
	assert.ok(!needsProjectScope("Action item not found"));
	assert.ok(!needsProjectScope("fetch failed"));
});

test("resolveGitRemote reads fresh origin identity on every call", async (t) => {
	clearGitRemoteCache();
	const dir = await mkdtemp(join(tmpdir(), "devspec-fresh-remote-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	git(dir, ["init", "-q"]);
	git(dir, ["remote", "add", "origin", "git@github.com:acme/first.git"]);
	assert.equal(await resolveGitRemote(dir), "git@github.com:acme/first.git");
	git(dir, ["remote", "set-url", "origin", "git@github.com:acme/second.git"]);
	assert.equal(await resolveGitRemote(dir), "git@github.com:acme/second.git");
});

test("resolveGitRemote returns null outside a git repo", async () => {
	clearGitRemoteCache();
	assert.equal(await resolveGitRemote("/tmp"), null);
});

test("credential-bearing remotes are never transport scope", async (t) => {
	assert.equal(sanitizeGitRemoteForTransport("https://token@github.com/acme/app.git"), null);
	assert.equal(sanitizeGitRemoteForTransport("https://user:secret@github.com/acme/app.git"), null);
	assert.equal(sanitizeGitRemoteForTransport("git+https://SECRET@github.com/acme/app.git"), null);
	assert.equal(sanitizeGitRemoteForTransport("ssh://git@github.com/acme/app.git"), "ssh://git@github.com/acme/app.git");
	assert.equal(sanitizeGitRemoteForTransport("ssh://SECRET@github.com/acme/app.git"), null);
	assert.equal(sanitizeGitRemoteForTransport("SECRET@github.com:acme/app.git"), null);
	assert.equal(sanitizeGitRemoteForTransport("git@github.com:acme/app.git"), "git@github.com:acme/app.git");
	const dir = await mkdtemp(join(tmpdir(), "devspec-credential-remote-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	git(dir, ["init", "-q"]);
	git(dir, ["remote", "add", "origin", "https://secret-token@github.com/acme/app.git"]);
	clearGitRemoteCache();
	assert.equal(await resolveGitRemote(dir), null);
});

/**
 * The folder pin (item 6faa4044) — how a folder with NO git repo names its project.
 * A greenfield project's code does not exist yet, so there is no remote to match on.
 */

/** Write a .devspec/project.json into a fresh temp dir and return the dir. */
async function pinnedDir(contents: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "devspec-pin-"));
	await mkdir(join(dir, ".devspec"), { recursive: true });
	await writeFile(join(dir, ".devspec", "project.json"), contents, "utf8");
	return dir;
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

test("resolveProjectPin reads fresh project identity on every call", async () => {
	clearProjectPinCache();
	const dir = await pinnedDir('{"project_id":"3dfada23-36c8-4dda-91cd-ba2fbb787a65"}');
	assert.equal(await resolveProjectPin(dir), "3dfada23-36c8-4dda-91cd-ba2fbb787a65");
	await writeFile(join(dir, ".devspec", "project.json"), '{"project_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}', "utf8");
	assert.equal(await resolveProjectPin(dir), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
});

test("resolveProjectPin trims and tolerates extra keys", async () => {
	clearProjectPinCache();
	const dir = await pinnedDir('{"project_id":"  abc-123  ","project_name":"Scratch"}');
	assert.equal(await resolveProjectPin(dir), "abc-123");
});

test("resolveProjectPin returns null when there is no pin", async () => {
	clearProjectPinCache();
	const dir = await mkdtemp(join(tmpdir(), "devspec-nopin-"));
	assert.equal(await resolveProjectPin(dir), null);
});

test("resolveProjectPin returns null for a broken pin rather than throwing", async () => {
	// A malformed pin must never surface as an error on an unrelated call, and must
	// never be sent as a guess — every failure mode is a plain null.
	clearProjectPinCache();
	assert.equal(await resolveProjectPin(await pinnedDir("not json at all")), null);
	clearProjectPinCache();
	assert.equal(await resolveProjectPin(await pinnedDir('{"project_id":""}')), null);
	clearProjectPinCache();
	assert.equal(await resolveProjectPin(await pinnedDir('{"project_id":42}')), null);
	clearProjectPinCache();
	assert.equal(await resolveProjectPin(await pinnedDir('{"other":"key"}')), null);
});

/**
 * The location contract (ADR dd0c1cff D12). Before this, Pi read cwd ONLY while the six
 * prose plugins said "workspace root" / "repo root" / "project directory" — so the same
 * pinned folder resolved or failed depending on which agent you happened to run.
 */

test("finds a pin in an ancestor — a subdirectory of a pinned folder resolves", async () => {
	clearProjectPinCache();
	const root = await pinnedDir('{"project_id":"outer-project"}');
	const deep = join(root, "apps", "web");
	await mkdir(deep, { recursive: true });
	// The motivating case: agents in this very monorepo are launched from apps/web.
	assert.equal(await resolveProjectPin(deep), "outer-project");
});

test("nearest pin wins, so an inner folder can override an outer one", async () => {
	clearProjectPinCache();
	const root = await pinnedDir('{"project_id":"outer-project"}');
	const inner = join(root, "packages", "thing");
	await mkdir(join(inner, ".devspec"), { recursive: true });
	await writeFile(join(inner, ".devspec", "project.json"), '{"project_id":"inner-project"}', "utf8");
	assert.equal(await resolveProjectPin(inner), "inner-project");
});

test("the walk stops at the repository root — a pin outside the repo is not used", async () => {
	// A repo is one tree with one identity. Letting a pin leak in from the parent
	// directory would capture every clone sitting beside it.
	clearProjectPinCache();
	const outer = await pinnedDir('{"project_id":"outer-project"}');
	const repo = join(outer, "some-clone");
	await mkdir(join(repo, ".git"), { recursive: true });
	const sub = join(repo, "src");
	await mkdir(sub, { recursive: true });
	assert.equal(await resolveProjectPin(sub), null);
});

test("a linked worktree inherits an untracked pin from the main checkout", async (t) => {
	clearProjectPinCache();
	const root = await mkdtemp(join(tmpdir(), "devspec-pin-worktree-"));
	const main = join(root, "main");
	const linked = join(root, "linked");
	t.after(async () => {
		clearProjectPinCache();
		await rm(root, { recursive: true, force: true });
	});

	await mkdir(main, { recursive: true });
	git(main, ["init", "--quiet"]);
	git(main, ["config", "user.email", "test@example.com"]);
	git(main, ["config", "user.name", "DevSpec test"]);
	await writeFile(join(main, "README.md"), "seed\n", "utf8");
	git(main, ["add", "README.md"]);
	git(main, ["commit", "--quiet", "-m", "seed"]);
	git(main, ["worktree", "add", "--quiet", "-b", "linked-test", linked]);

	// Write after creating the worktree so this pin exists only in the main checkout.
	await mkdir(join(main, ".devspec"), { recursive: true });
	await writeFile(
		join(main, ".devspec", "project.json"),
		'{"project_id":"11111111-1111-4111-8111-111111111111"}',
		"utf8",
	);

	assert.equal(
		await resolveProjectPin(linked, join(root, "not-home")),
		"11111111-1111-4111-8111-111111111111",
	);

	// The repository fallback remains last: an explicit linked-worktree pin wins.
	await mkdir(join(linked, ".devspec"), { recursive: true });
	await writeFile(
		join(linked, ".devspec", "project.json"),
		'{"project_id":"22222222-2222-4222-8222-222222222222"}',
		"utf8",
	);
	clearProjectPinCache();
	assert.equal(
		await resolveProjectPin(linked, join(root, "not-home")),
		"22222222-2222-4222-8222-222222222222",
	);
});

test("a linked worktree never inherits a main checkout pin at or above $HOME", async (t) => {
	clearProjectPinCache();
	const root = await mkdtemp(join(tmpdir(), "devspec-pin-home-boundary-"));
	const main = join(root, "main");
	const home = join(main, "home");
	const linked = join(home, "linked");
	t.after(async () => {
		clearProjectPinCache();
		await rm(root, { recursive: true, force: true });
	});

	await mkdir(main, { recursive: true });
	git(main, ["init", "--quiet"]);
	git(main, ["config", "user.email", "test@example.com"]);
	git(main, ["config", "user.name", "DevSpec test"]);
	await writeFile(join(main, "README.md"), "seed\n", "utf8");
	git(main, ["add", "README.md"]);
	git(main, ["commit", "--quiet", "-m", "seed"]);
	await mkdir(home, { recursive: true });
	git(main, ["worktree", "add", "--quiet", "-b", "home-boundary-test", linked]);
	await mkdir(join(main, ".devspec"), { recursive: true });
	await writeFile(
		join(main, ".devspec", "project.json"),
		'{"project_id":"above-home-project"}',
		"utf8",
	);

	assert.equal(await resolveProjectPin(linked, home), null);
});

test("an unusual separate Git directory fails open instead of guessing a checkout", async (t) => {
	clearProjectPinCache();
	const root = await mkdtemp(join(tmpdir(), "devspec-pin-separate-git-"));
	const main = join(root, "main");
	const metadata = join(root, "metadata");
	const gitDirectory = join(metadata, "repository.git");
	const linked = join(root, "linked");
	t.after(async () => {
		clearProjectPinCache();
		await rm(root, { recursive: true, force: true });
	});

	await mkdir(metadata, { recursive: true });
	git(root, ["init", "--quiet", `--separate-git-dir=${gitDirectory}`, main]);
	git(main, ["config", "user.email", "test@example.com"]);
	git(main, ["config", "user.name", "DevSpec test"]);
	await writeFile(join(main, "README.md"), "seed\n", "utf8");
	git(main, ["add", "README.md"]);
	git(main, ["commit", "--quiet", "-m", "seed"]);
	git(main, ["worktree", "add", "--quiet", "-b", "separate-git-test", linked]);

	// Neither Git's separate metadata path nor the undiscoverable checkout path
	// is guessed as repository jurisdiction from the linked worktree.
	await mkdir(join(gitDirectory, ".devspec"), { recursive: true });
	await writeFile(
		join(gitDirectory, ".devspec", "project.json"),
		'{"project_id":"metadata-is-not-a-worktree"}',
		"utf8",
	);
	await mkdir(join(main, ".devspec"), { recursive: true });
	await writeFile(
		join(main, ".devspec", "project.json"),
		'{"project_id":"undiscoverable-main-worktree"}',
		"utf8",
	);
	assert.equal(await resolveProjectPin(linked, join(root, "not-home")), null);
});

test("a pin at or above $HOME is never read", async () => {
	// ~/.devspec is the MACHINE-state directory (connections, bonds, poller pids). A
	// project.json there would silently capture every folder the user owns.
	clearProjectPinCache();
	const home = await pinnedDir('{"project_id":"home-project"}');
	const work = join(home, "work", "thing");
	await mkdir(work, { recursive: true });
	assert.equal(await resolveProjectPin(work, home), null);

	// ...and the bound is the only reason: the same tree resolves with home elsewhere.
	clearProjectPinCache();
	assert.equal(await resolveProjectPin(work, join(home, "nowhere")), "home-project");
});

/**
 * Writing the pin (item 597c5d49). Nothing wrote this file before — a user had to
 * hand-author JSON whose shape they learned from an error message.
 */

test("writes the pin at the working directory when there is no repo", async () => {
	clearProjectPinCache();
	const dir = await mkdtemp(join(tmpdir(), "devspec-write-"));
	const r = await writeProjectPin(dir, "greenfield-project", undefined, join(dir, "no-home"));
	assert.equal(r.path, join(dir, ".devspec", "project.json"));
	assert.equal(r.replaced, null);
	// Round-trip through the READER, not just the returned path.
	assert.equal(await resolveProjectPin(dir, join(dir, "no-home")), "greenfield-project");
});

test("writes at the repository ROOT, not the subdirectory it was called from", async () => {
	// D13: the root is the only place the read walk reaches from every subdirectory, and
	// where a committed pin belongs. A pin halfway up resolves for one subtree only.
	clearProjectPinCache();
	const repo = await mkdtemp(join(tmpdir(), "devspec-writerepo-"));
	await mkdir(join(repo, ".git"), { recursive: true });
	const deep = join(repo, "apps", "web");
	await mkdir(deep, { recursive: true });

	const r = await writeProjectPin(deep, "monorepo-project", undefined, join(repo, "no-home"));
	assert.equal(r.path, join(repo, ".devspec", "project.json"));
	// Resolves from a SIBLING subdirectory, which a cwd-level write would not have done.
	const sibling = join(repo, "packages", "core");
	await mkdir(sibling, { recursive: true });
	assert.equal(await resolveProjectPin(sibling, join(repo, "no-home")), "monorepo-project");
});

test("re-pinning reports what it replaced, so a caller can say so before overwriting", async () => {
	// Silently repointing a COMMITTED pin would move a whole team's folder on one
	// person's say-so, so the write surfaces the previous id rather than swallowing it.
	clearProjectPinCache();
	const dir = await pinnedDir('{"project_id":"old-project"}');
	const r = await writeProjectPin(dir, "new-project", undefined, join(dir, "no-home"));
	assert.equal(r.replaced, "old-project");
	assert.equal(await resolveProjectPin(dir, join(dir, "no-home")), "new-project");

	// Re-writing the SAME id is not a replacement — nothing changed to report.
	clearProjectPinCache();
	const again = await writeProjectPin(dir, "new-project", undefined, join(dir, "no-home"));
	assert.equal(again.replaced, null);
});

test("the written file carries project_id only, plus an optional non-authoritative name", async () => {
	// D10: no path, hostname, user, token or timestamp. That rule is the whole reason
	// this file is safe to commit, so it is asserted rather than trusted to review.
	clearProjectPinCache();
	const dir = await mkdtemp(join(tmpdir(), "devspec-shape-"));
	await writeProjectPin(dir, "shape-project", "Scratch Project", join(dir, "no-home"));
	const raw = JSON.parse(await readFile(join(dir, ".devspec", "project.json"), "utf8"));
	assert.deepEqual(Object.keys(raw).sort(), ["project_id", "project_name"]);
	assert.equal(raw.project_id, "shape-project");

	clearProjectPinCache();
	const bare = await mkdtemp(join(tmpdir(), "devspec-shape2-"));
	await writeProjectPin(bare, "bare-project", undefined, join(bare, "no-home"));
	const raw2 = JSON.parse(await readFile(join(bare, ".devspec", "project.json"), "utf8"));
	assert.deepEqual(Object.keys(raw2), ["project_id"]);
});

test("writeProjectPin refuses an empty project id rather than writing a useless pin", async () => {
	const dir = await mkdtemp(join(tmpdir(), "devspec-empty-"));
	await assert.rejects(() => writeProjectPin(dir, "   "), /projectId is required/);
});

test("a repo checkout with no pin yields a remote but no pin", async () => {
	// The two anchors are independent: this repo has a remote and no pin file, and a
	// greenfield folder is the mirror image. The client sends whichever exist.
	clearGitRemoteCache();
	clearProjectPinCache();
	assert.match(await resolveGitRemote(process.cwd()) ?? "", /github\.com[:/]DevSpecAI\/DevSpec-Pi(?:\.git)?$/);
	assert.equal(await resolveProjectPin(process.cwd()), null);
});
