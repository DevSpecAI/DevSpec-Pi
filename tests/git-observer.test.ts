import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { BASH, withEnv } from "./bash-fixture.ts";
import { corroborateObservedCommit } from "../extensions/devspec-commit-ledger.ts";
import { STAND_IN_MARKER, isMarkedStandIn, loopStoppedText } from "../runtime/git-stand-in.mjs";
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
		connectionCapability: "fixture-host-only-capability",
		transport: { tokenHash: "fixture-host-only-token-hash", endpoint: "https://original.invalid/api/mcp" },
	});
	assert.ok(result);
	assert.equal(result.prefix.includes("fixture-host-only"), false, "credentials and their hashes stay outside the child environment");
	assert.equal(result.prefix.includes("original.invalid"), false, "the transport endpoint stays host-side");
	return result;
}

function bash(command: string, session = SESSION, extraEnv: Record<string, string> = {}): void {
	execFileSync(BASH, ["-c", command], {
		env: withEnv({ PI_SESSION_ID: session, ...extraEnv }),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function fixture(t: TestContext) {
	resetGitObserverForTests();
	assert.equal(initializeGitObserver(SESSION), true);
	// The canonical long path: Windows hands out 8.3 short temp paths (RUNNER~1),
	// while the stand-in reports the repository's real path.
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "devspec-pi-observer-test-")));
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
		assert.equal(row.envelope.connectionCapability, "fixture-host-only-capability");
		assert.deepEqual(row.envelope.transport, { tokenHash: "fixture-host-only-token-hash", endpoint: "https://original.invalid/api/mcp" });
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

test("secondary nested-repository Trace2 events cannot replace the parent repo", (t) => {
	const root = fixture(t);
	const parent = repo(root, "parent");
	const nested = join(parent, "nested");
	mkdirSync(nested);
	git(nested, "init", "-q");
	git(nested, "config", "user.name", "Nested Test");
	git(nested, "config", "user.email", "nested@example.test");
	stage(nested, "nested.txt", "nested");
	git(nested, "commit", "-q", "-m", "nested");
	git(parent, "add", "nested");
	stage(parent, "base.txt", "base");
	git(parent, "commit", "-q", "-m", "base");
	// Dirty the embedded repo so Git inspects it and may emit repo:2 def_repo.
	writeFileSync(join(nested, "dirty.txt"), "dirty");
	stage(parent, "parent.txt", "parent");
	const prepared = prepare("tool-nested-repo");
	bash(`${prepared.prefix}git -C ${JSON.stringify(parent)} commit -q -m parent`);
	const row = drainGitObservations()[0];
	assert.ok(row);
	assert.equal(row.worktree, parent);
	assert.equal(row.sha, git(parent, "rev-parse", "HEAD"));
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

// Item 8729992e: a stale shim dir on PATH once made findRealGit resolve a shim
// as "the real git"; delegation then self-spawned without bound (>1,100
// processes, 12G swap, machine lockup). Both layers of the guard are pinned:
// the shim refuses a shim as its real Git, and install skips shim dirs on PATH.

test("shim refuses to delegate into another observer shim (fork-bomb guard)", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "devspec-pi-git-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fakeShim = join(dir, "git");
	writeFileSync(fakeShim, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const shimModule = fileURLToPath(new URL("../runtime/git-observer-shim.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [shimModule, "rev-parse", "--show-toplevel"], {
		env: { ...process.env, DEVSPEC_PI_REAL_GIT: fakeShim },
		encoding: "utf8",
		timeout: 15_000,
	});
	assert.notEqual(result.error?.code, "ETIMEDOUT", "a shim chain must fail fast, never recurse");
	assert.equal(result.status, 126, "a shim pointed at another shim refuses the call");
});

test("install resolves real Git past a stale shim dir on PATH", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "devspec-pi-git-"));
	const originalPath = process.env.PATH;
	t.after(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		resetGitObserverForTests();
		rmSync(dir, { recursive: true, force: true });
	});
	writeFileSync(join(dir, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
	resetGitObserverForTests();
	assert.equal(initializeGitObserver("session-poisoned-path"), true);
	const prepared = prepareGitObservation({
		toolCallId: "tool-poisoned-path",
		piSessionId: "session-poisoned-path",
		connectionId: CONNECTION,
		projectId: PROJECT,
	});
	assert.ok(prepared);
	assert.ok(!prepared.prefix.includes(dir), `real Git must not resolve into a shim dir, got prefix: ${prepared.prefix}`);
});

// Item 80bceb2c: on 2026-10-30 a Claude Code agent ran this suite, and Pi's stand-in
// and Claude Code's each took the other for git, starting processes back and forth
// until the machine ran out of memory. Every DevSpec stand-in now carries a shared
// marker, skips any git that does, and goes no deeper than the plugins agree.

const POSIX_ONLY = process.platform === "win32" ? "the other-plugin fixtures are POSIX shell scripts" : false;
// The git these run is the one git itself reports, never this process's PATH, which
// for an agent running this suite already holds that agent's own stand-in.
const REAL_GIT_DIR = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();

/** Another plugin's stand-in that follows the shared rules: marked, one level deeper, skips marked gits. */
const FOLLOWS_RULES = [
	"#!/bin/sh",
	`${STAND_IN_MARKER}: a fixture for another DevSpec plugin's stand-in`,
	"DEVSPEC_GIT_STAND_IN_DEPTH=$(( ${DEVSPEC_GIT_STAND_IN_DEPTH:-0} + 1 )); export DEVSPEC_GIT_STAND_IN_DEPTH",
	"IFS=:",
	"for dir in $PATH; do",
	"  [ -f \"$dir/git\" ] && [ -x \"$dir/git\" ] || continue",
	`  head -c 256 "$dir/git" | grep -qF '${STAND_IN_MARKER}' && continue`,
	"  unset IFS; exec \"$dir/git\" \"$@\"",
	"done",
	"exit 127",
	"",
].join("\n");

/** An older stand-in that follows none of them: it runs the first other git on PATH. */
const FOLLOWS_NONE = [
	"#!/bin/sh",
	"self=$(cd \"$(dirname \"$0\")\" && pwd -P)",
	"IFS=:",
	"for dir in $PATH; do",
	"  [ \"$(cd \"$dir\" 2>/dev/null && pwd -P)\" = \"$self\" ] && continue",
	"  [ -f \"$dir/git\" ] && [ -x \"$dir/git\" ] || continue",
	"  unset IFS; exec \"$dir/git\" \"$@\"",
	"done",
	"exit 127",
	"",
].join("\n");

/** Pi started with `script` as another plugin's stand-in ahead of the real git, as from that agent's shell. */
function besideAnotherStandIn(t: TestContext, script: string): { root: string; other: string } {
	const originalPath = process.env.PATH;
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "devspec-pi-observer-test-")));
	const other = join(root, "other-plugin");
	mkdirSync(other);
	writeFileSync(join(other, "git"), script, { mode: 0o755 });
	process.env.PATH = [other, REAL_GIT_DIR, "/usr/bin", "/bin"].join(delimiter);
	t.after(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		resetGitObserverForTests();
		rmSync(root, { recursive: true, force: true });
	});
	resetGitObserverForTests();
	assert.equal(initializeGitObserver(SESSION), true);
	return { root, other };
}

/**
 * A Bash call in its own process group, killed whole if it outlives the bound: a
 * regression here is a runaway, and must fail the test rather than take the machine.
 */
function bounded(command: string, ms = 20_000): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; group: number; elapsed: number }> {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const child = spawn(BASH, ["-c", command], { env: withEnv({ PI_SESSION_ID: SESSION }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		const timer = setTimeout(() => {
			try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
		}, ms);
		child.once("close", (status, signal) => {
			clearTimeout(timer);
			resolve({ status, signal, stdout, stderr, group: child.pid!, elapsed: Date.now() - startedAt });
		});
	});
}

function nothingLeft(group: number): void {
	assert.throws(() => process.kill(-group, 0), { code: "ESRCH" }, "no process of the command is still running");
}

test("Pi's stand-in carries the shared marker, so the other plugins can tell it from git", { skip: POSIX_ONLY }, (t) => {
	fixture(t);
	const prepared = prepare("tool-marker");
	const dir = /export PATH='([^']+)'/u.exec(prepared.prefix)?.[1];
	assert.ok(dir, prepared.prefix);
	assert.equal(isMarkedStandIn(join(dir, "git")), true);
	assert.equal(isMarkedStandIn(join(REAL_GIT_DIR, "git")), false);
});

test("install looks past another plugin's marked stand-in, and a commit through Pi is observed as usual", { skip: POSIX_ONLY }, async (t) => {
	const { root, other } = besideAnotherStandIn(t, FOLLOWS_RULES);
	const cwd = repo(root, "beside");
	stage(cwd, "a.txt", "a");
	const prepared = prepare("tool-beside");
	assert.equal(prepared.prefix.includes(other), false, `Pi took the other plugin's stand-in for git: ${prepared.prefix}`);
	const made = await bounded(`${prepared.prefix}cd ${JSON.stringify(cwd)} && git commit -q -m beside`);
	assert.equal(made.status, 0, made.stderr);
	assert.deepEqual(drainGitObservations().map((row) => row.sha), [git(cwd, "rev-parse", "HEAD")]);
	nothingLeft(made.group);
	// The other plugin's agent puts its stand-in in front for its own commands: it
	// must reach git too, without Pi taking the commit as this session's.
	const theirs = await bounded(`${prepare("tool-theirs").prefix}export PATH=${JSON.stringify(other)}:"$PATH"; cd ${JSON.stringify(cwd)} && git commit -q --allow-empty -m theirs`);
	assert.equal(theirs.status, 0, theirs.stderr);
	assert.equal(git(cwd, "log", "-1", "--format=%s"), "theirs");
	assert.deepEqual(drainGitObservations(), []);
	nothingLeft(theirs.group);
});

test("a loop with an older stand-in that follows none of the rules stops at once, and leaves nothing running", { skip: POSIX_ONLY }, async (t) => {
	const { root } = besideAnotherStandIn(t, FOLLOWS_NONE);
	const cwd = repo(root, "looped");
	stage(cwd, "a.txt", "a");
	const looped = await bounded(`${prepare("tool-loop").prefix}cd ${JSON.stringify(cwd)} && git commit -q -m looped`);
	assert.equal(looped.signal, null, `killed after ${looped.elapsed} ms: the loop was not stopped`);
	assert.equal(looped.status, 126, looped.stderr);
	assert.ok(looped.stderr.includes(loopStoppedText()), looped.stderr);
	assert.throws(() => git(cwd, "rev-parse", "--verify", "HEAD"), "nothing was committed");
	assert.deepEqual(drainGitObservations(), []);
	nothingLeft(looped.group);
});

test("nested as deep as the plugins allow, Pi's stand-in refuses before starting anything", { skip: POSIX_ONLY }, async (t) => {
	const { root } = besideAnotherStandIn(t, FOLLOWS_RULES);
	const cwd = repo(root, "deep");
	const refused = await bounded(`${prepare("tool-deep").prefix}cd ${JSON.stringify(cwd)} && DEVSPEC_GIT_STAND_IN_DEPTH=8 git status --short`);
	assert.equal(refused.status, 126);
	assert.equal(refused.stdout, "");
	assert.equal(refused.stderr.trim(), loopStoppedText());
});
