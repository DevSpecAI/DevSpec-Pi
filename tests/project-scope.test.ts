import assert from "node:assert/strict";
import { test } from "node:test";
import {
	needsProjectScope,
	resolveGitRemote,
	clearGitRemoteCache,
	resolveProjectPin,
	clearProjectPinCache,
} from "../extensions/core/project-scope.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

test("resolveGitRemote reads origin and caches per cwd", async () => {
	clearGitRemoteCache();
	const url = await resolveGitRemote(process.cwd());
	assert.equal(url, "git@github.com:DevSpecAI/DevSpec-Pi.git");
	// Cache hit: same answer without re-spawning git (can't easily assert spawn
	// count — assert stability instead).
	assert.equal(await resolveGitRemote(process.cwd()), url);
});

test("resolveGitRemote returns null outside a git repo", async () => {
	clearGitRemoteCache();
	assert.equal(await resolveGitRemote("/tmp"), null);
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

test("resolveProjectPin reads project_id and caches per cwd", async () => {
	clearProjectPinCache();
	const dir = await pinnedDir('{"project_id":"3dfada23-36c8-4dda-91cd-ba2fbb787a65"}');
	assert.equal(await resolveProjectPin(dir), "3dfada23-36c8-4dda-91cd-ba2fbb787a65");
	assert.equal(await resolveProjectPin(dir), "3dfada23-36c8-4dda-91cd-ba2fbb787a65");
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

test("a repo checkout with no pin yields a remote but no pin", async () => {
	// The two anchors are independent: this repo has a remote and no pin file, and a
	// greenfield folder is the mirror image. The client sends whichever exist.
	clearGitRemoteCache();
	clearProjectPinCache();
	assert.equal(await resolveGitRemote(process.cwd()), "git@github.com:DevSpecAI/DevSpec-Pi.git");
	assert.equal(await resolveProjectPin(process.cwd()), null);
});
