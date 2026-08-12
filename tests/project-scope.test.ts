import assert from "node:assert/strict";
import { test } from "node:test";
import { needsProjectScope, resolveGitRemote, clearGitRemoteCache } from "../extensions/core/project-scope.ts";

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
