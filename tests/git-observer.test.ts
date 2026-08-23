import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { corroborateObservedCommit } from "../extensions/devspec-commit-ledger.ts";
import {
	drainGitObservations,
	initializeGitObserver,
	prepareGitObservation,
	resetGitObserverForTests,
} from "../extensions/core/git-observer.ts";

const SESSION = "session-observer-a";
const CONNECTION = "99999999-8888-4777-8666-555555555555";
const PROJECT = "11111111-2222-4333-8444-555555555555";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(root: string, name: string): string {
	const cwd = join(root, name);
	mkdirSync(cwd);
	git(cwd, "init", "-q");
	git(cwd, "config", "user.name", "Observer Test");
	git(cwd, "config", "user.email", "observer@example.test");
	return cwd;
}

function stage(cwd: string, name: string, value: string): void {
	writeFileSync(join(cwd, name), value);
	git(cwd, "add", name);
}

function prepare(toolCallId: string, session = SESSION) {
	const result = prepareGitObservation({
		toolCallId,
		piSessionId: session,
		connectionId: CONNECTION,
		projectId: PROJECT,
	});
	assert.ok(result);
	return result;
}

function bash(command: string, session = SESSION, extraEnv: Record<string, string> = {}): void {
	execFileSync("/bin/bash", ["-c", command], {
		env: { ...process.env, PI_SESSION_ID: session, ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function fixture(t: TestContext) {
	resetGitObserverForTests();
	assert.equal(initializeGitObserver(SESSION), true);
	const root = mkdtempSync(join(tmpdir(), "devspec-pi-observer-test-"));
	t.after(() => {
		resetGitObserverForTests();
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

test("quiet cd and git -C commits in two repositories are both captured", (t) => {
	const root = fixture(t);
	const a = repo(root, "a");
	const b = repo(root, "b");
	stage(a, "a.txt", "a");
	stage(b, "b.txt", "b");
	const observed = prepare("tool-multi");
	bash(`${observed.prefix}cd ${JSON.stringify(a)} && git commit -q -m a && git -C ${JSON.stringify(b)} commit -q -m b`);
	const rows = drainGitObservations();
	assert.equal(rows.length, 2);
	assert.deepEqual(new Set(rows.map((row) => row.worktree)), new Set([a, b]));
	assert.deepEqual(new Set(rows.map((row) => row.sha)), new Set([git(a, "rev-parse", "HEAD"), git(b, "rev-parse", "HEAD")]));
	for (const row of rows) {
		assert.equal(row.envelope.toolCallId, "tool-multi");
		assert.equal(row.envelope.connectionId, CONNECTION);
		assert.equal(row.envelope.projectId, PROJECT);
	}
});

test("root, alias, amend and linked-worktree commits resolve from the actual worktree", (t) => {
	const root = fixture(t);
	const main = repo(root, "main");
	git(main, "config", "alias.ci", "commit");
	stage(main, "root.txt", "root");
	const first = prepare("tool-root");
	bash(`${first.prefix}git -C ${JSON.stringify(main)} ci -q -m root`);
	assert.equal(drainGitObservations()[0]?.sha, git(main, "rev-parse", "HEAD"));

	stage(main, "root.txt", "amended");
	const amend = prepare("tool-amend");
	bash(`${amend.prefix}git -C ${JSON.stringify(main)} commit -q --amend --no-edit`);
	assert.equal(drainGitObservations()[0]?.sha, git(main, "rev-parse", "HEAD"));

	const worktree = join(root, "linked");
	git(main, "worktree", "add", "-q", "-b", "linked-test", worktree);
	stage(worktree, "linked.txt", "linked");
	const linked = prepare("tool-linked");
	bash(`${linked.prefix}cd ${JSON.stringify(worktree)} && git commit -q -m linked`);
	assert.equal(drainGitObservations()[0]?.worktree, worktree);
});

test("dry-run, failed, and unsupported Git operations create no observation", (t) => {
	const root = fixture(t);
	const cwd = repo(root, "repo");
	stage(cwd, "base.txt", "base");
	git(cwd, "commit", "-q", "-m", "base");

	stage(cwd, "dry.txt", "dry");
	const dry = prepare("tool-dry");
	try { bash(`${dry.prefix}git -C ${JSON.stringify(cwd)} commit --dry-run`); } catch { /* exit varies by Git */ }
	assert.deepEqual(drainGitObservations(), []);

	git(cwd, "reset", "-q", "HEAD", "--", "dry.txt");
	const failed = prepare("tool-failed");
	try { bash(`${failed.prefix}git -C ${JSON.stringify(cwd)} commit -q -m none`); } catch { /* expected */ }
	assert.deepEqual(drainGitObservations(), []);

	const baseBranch = git(cwd, "branch", "--show-current");
	git(cwd, "checkout", "-q", "-b", "feature");
	stage(cwd, "feature.txt", "feature");
	git(cwd, "commit", "-q", "-m", "feature");
	git(cwd, "checkout", "-q", baseBranch);
	const merge = prepare("tool-merge");
	bash(`${merge.prefix}git -C ${JSON.stringify(cwd)} merge -q --ff-only feature`);
	assert.deepEqual(drainGitObservations(), []);
});

test("a concurrent commit replacing HEAD after observed Git exits is rejected by host corroboration", (t) => {
	const root = fixture(t);
	const cwd = repo(root, "repo");
	stage(cwd, "first.txt", "first");
	const prepared = prepare("tool-concurrent");
	bash(`${prepared.prefix}git -C ${JSON.stringify(cwd)} commit -q -m first`);
	stage(cwd, "second.txt", "second");
	git(cwd, "commit", "-q", "-m", "second");
	const row = drainGitObservations()[0];
	assert.ok(row);
	assert.equal(corroborateObservedCommit(row), false);
});

test("normal, amend, and initial observations reject a later amend by reflog adjacency", (t) => {
	const root = fixture(t);

	const normal = repo(root, "normal");
	stage(normal, "base.txt", "base"); git(normal, "commit", "-q", "-m", "base");
	stage(normal, "next.txt", "next");
	const normalPrepared = prepare("tool-normal-before-amend");
	bash(`${normalPrepared.prefix}git -C ${JSON.stringify(normal)} commit -q -m next`);
	stage(normal, "amend.txt", "amend"); git(normal, "commit", "-q", "--amend", "--no-edit");
	const normalRow = drainGitObservations()[0]; assert.ok(normalRow); assert.equal(corroborateObservedCommit(normalRow), false);

	const amended = repo(root, "amended");
	stage(amended, "base.txt", "base"); git(amended, "commit", "-q", "-m", "base");
	stage(amended, "first.txt", "first");
	const amendPrepared = prepare("tool-amend-before-amend");
	bash(`${amendPrepared.prefix}git -C ${JSON.stringify(amended)} commit -q --amend --no-edit`);
	stage(amended, "second.txt", "second"); git(amended, "commit", "-q", "--amend", "--no-edit");
	const amendRow = drainGitObservations()[0]; assert.ok(amendRow); assert.equal(corroborateObservedCommit(amendRow), false);

	const initial = repo(root, "initial");
	stage(initial, "root.txt", "root");
	const initialPrepared = prepare("tool-initial-before-amend");
	bash(`${initialPrepared.prefix}git -C ${JSON.stringify(initial)} commit -q -m root`);
	stage(initial, "root.txt", "amended"); git(initial, "commit", "-q", "--amend", "--no-edit");
	const initialRow = drainGitObservations()[0]; assert.ok(initialRow); assert.equal(corroborateObservedCommit(initialRow), false);
});

test("a hook-launched amend is rejected inside the shim", (t) => {
	const root = fixture(t);
	const cwd = repo(root, "repo");
	stage(cwd, "base.txt", "base"); git(cwd, "commit", "-q", "-m", "base");
	const hook = join(cwd, ".git", "hooks", "post-commit");
	writeFileSync(hook, `#!/bin/sh\nrm "$0"\ngit commit -q --amend --no-edit --no-verify\n`);
	chmodSync(hook, 0o700);
	stage(cwd, "next.txt", "next");
	const prepared = prepare("tool-hook-amend");
	bash(`${prepared.prefix}git -C ${JSON.stringify(cwd)} commit -q -m next`);
	assert.deepEqual(drainGitObservations(), []);
});

test("a post-commit hook that moves HEAD fails open rather than misattributing", (t) => {
	const root = fixture(t);
	const cwd = repo(root, "repo");
	stage(cwd, "base.txt", "base");
	git(cwd, "commit", "-q", "-m", "base");
	const prior = git(cwd, "rev-parse", "HEAD");
	const hook = join(cwd, ".git", "hooks", "post-commit");
	writeFileSync(hook, "#!/bin/sh\ngit reset --hard -q HEAD^\n");
	chmodSync(hook, 0o700);
	stage(cwd, "next.txt", "next");
	const prepared = prepare("tool-hook");
	bash(`${prepared.prefix}git -C ${JSON.stringify(cwd)} commit -q -m next`);
	assert.equal(git(cwd, "rev-parse", "HEAD"), prior);
	assert.deepEqual(drainGitObservations(), []);
});

test("host corroboration rejects a child-forged old commit observation", (t) => {
	const root = fixture(t);
	const cwd = repo(root, "repo");
	stage(cwd, "old.txt", "old");
	execFileSync("git", ["commit", "-q", "-m", "old"], {
		cwd,
		env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
	});
	const prepared = prepare("tool-forged");
	const envelope = {
		observationId: prepared.observationId,
		generation: "generation",
		piSessionId: SESSION,
		toolCallId: "tool-forged",
		connectionId: CONNECTION,
		projectId: PROJECT,
		createdAt: Date.now(),
	};
	assert.equal(corroborateObservedCommit({
		envelope,
		sha: git(cwd, "rev-parse", "HEAD"),
		branch: git(cwd, "branch", "--show-current"),
		worktree: cwd,
		previousHead: null,
		amend: false,
		observedAt: new Date().toISOString(),
	}), false);
});

test("absolute host runtime keeps Git working when node is absent from Bash PATH", (t) => {
	const root = fixture(t);
	const cwd = repo(root, "repo");
	stage(cwd, "path.txt", "path");
	const prepared = prepare("tool-no-node-path");
	bash(`${prepared.prefix}git -C ${JSON.stringify(cwd)} commit -q -m path`, SESSION, { PATH: "/definitely-no-node" });
	assert.equal(drainGitObservations()[0]?.sha, git(cwd, "rev-parse", "HEAD"));
});

test("conflicting Trace2 state and stale child session delegate Git but do not observe", (t) => {
	const root = fixture(t);
	const traced = repo(root, "traced");
	stage(traced, "trace.txt", "trace");
	const conflict = prepare("tool-trace-conflict");
	bash(`${conflict.prefix}export GIT_TRACE2_EVENT=${JSON.stringify(join(root, "caller-trace"))}; git -C ${JSON.stringify(traced)} commit -q -m trace`);
	assert.ok(git(traced, "rev-parse", "HEAD"));
	assert.deepEqual(drainGitObservations(), []);

	const stale = repo(root, "stale");
	stage(stale, "stale.txt", "stale");
	const prepared = prepare("tool-stale");
	bash(`${prepared.prefix}git -C ${JSON.stringify(stale)} commit -q -m stale`, "different-session");
	assert.ok(git(stale, "rev-parse", "HEAD"));
	assert.deepEqual(drainGitObservations(), []);
});
