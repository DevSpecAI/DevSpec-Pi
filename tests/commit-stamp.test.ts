import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	drainGitObservations,
	initializeGitObserver,
	prepareGitObservation,
	resetGitObserverForTests,
	type CommitStampScope,
} from "../extensions/core/git-observer.ts";
import { commitStampNote, commitStampScope, commitTaggingAvailable, originFingerprint } from "../extensions/core/commit-stamp.ts";
import { setBond } from "../extensions/core/bond-state.ts";
import { BASH } from "./bash-fixture.ts";
// @ts-expect-error plain ESM runtime module without types
import { planCommitStamp, readCommitMessageSource, readStampScope, stampMessage } from "../runtime/commit-stamp.mjs";

// DevSpec item df71ab6c: Pi's git stand-in tags a plain commit with the one claimed
// task, from git's own argv, and leaves every other commit exactly as it was.
const SESSION = "session-stamp-a";
const CONNECTION = "99999999-8888-4777-8666-555555555555";
const PROJECT = "11111111-2222-4333-8444-555555555555";
const OTHER_PROJECT = "22222222-2222-4333-8444-555555555555";
const TASK = "df71ab6c-9bb1-49d1-a9e7-9ea6dc867607";
const OTHER_TASK = "6aad2b46-27a1-4aad-a60a-ec8ed7203d65";
const REMOTE = "https://example.invalid/devspec/fixture.git";
const TAG = `[devspec:${TASK}]`;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(root: string, name: string, remote: string | null = REMOTE): string {
	const cwd = join(root, name);
	mkdirSync(cwd, { recursive: true });
	git(cwd, "init", "-q");
	git(cwd, "config", "user.name", "Stamp Test");
	git(cwd, "config", "user.email", "stamp@example.test");
	if (remote) git(cwd, "remote", "add", "origin", remote);
	git(cwd, "commit", "-q", "--allow-empty", "-m", "root");
	return cwd;
}

function scope(overrides: Partial<CommitStampScope> = {}): CommitStampScope {
	return { projectId: PROJECT, claimCount: 1, taskId: TASK, remoteSha256: originFingerprint(REMOTE), ...overrides };
}

function bash(command: string, stamp: CommitStampScope | null, env: Record<string, string> = {}) {
	const prepared = prepareGitObservation({
		toolCallId: `tool-${Math.random()}`, piSessionId: SESSION, connectionId: CONNECTION, projectId: PROJECT,
		connectionCapability: "fixture-host-only-capability", transport: { tokenHash: "fixture-hash", endpoint: "https://original.invalid/api/mcp" }, stamp,
	});
	assert.ok(prepared);
	execFileSync(BASH, ["-c", `${prepared.prefix}${command}`], { env: { ...process.env, PI_SESSION_ID: SESSION, ...env }, stdio: ["ignore", "pipe", "pipe"] });
	const observerDir = /DEVSPEC_PI_GIT_OBSERVER_DIR='([^']+)'/u.exec(prepared.prefix)?.[1] ?? "";
	return Object.assign(drainGitObservations(), { observerDir });
}

const message = (cwd: string, rev = "HEAD") => execFileSync("git", ["cat-file", "commit", rev], { cwd }).toString("latin1").split("\n\n").slice(1).join("\n\n");

function fixture(t: TestContext) {
	resetGitObserverForTests();
	assert.equal(initializeGitObserver(SESSION), true);
	const root = mkdtempSync(join(tmpdir(), "devspec-pi-stamp-test-"));
	t.after(() => { resetGitObserverForTests(); rmSync(root, { recursive: true, force: true }); });
	return root;
}

test("-m: the subject of the first message gets the tag; body and trailer stay as written", (t) => {
	const cwd = repo(fixture(t), "project");
	const rows = bash(`cd '${cwd}' && git commit -q --allow-empty -m "Subject one" -m "Body paragraph" -m "Co-Authored-By: A <a@example.test>"`, scope());
	assert.equal(message(cwd), `Subject one ${TAG}\n\nBody paragraph\n\nCo-Authored-By: A <a@example.test>\n`);
	assert.deepEqual(rows[0]?.stamp, { outcome: "stamped", reason: null, task: TASK, claims: 1 });
	assert.equal(git(cwd, "log", "-1", "--format=%(trailers:only)"), "Co-Authored-By: A <a@example.test>", "the trailer is still a trailer");
});

test("-m \"$(cat <<'EOF' …)\" and -F - heredocs: tagged on the subject line, every other byte intact", (t) => {
	const cwd = repo(fixture(t), "project");
	bash(`cd '${cwd}' && git commit -q --allow-empty -m "$(cat <<'EOF'\nSubject two\n\nBody line\n\nCo-Authored-By: A <a@example.test>\nEOF\n)"`, scope());
	assert.equal(message(cwd), `Subject two ${TAG}\n\nBody line\n\nCo-Authored-By: A <a@example.test>\n`);
	const rows = bash(`cd '${cwd}' && git commit -q --allow-empty -F - <<'EOF'\nSubject three\n\nBody line\nEOF`, scope());
	assert.equal(message(cwd), `Subject three ${TAG}\n\nBody line\n`);
	assert.equal(rows[0]?.stamp?.outcome, "stamped");
});

test("-F <file>: resolved the way git does after -C, tagged through a private copy, the person's file untouched", (t) => {
	const root = fixture(t);
	const cwd = repo(root, "project");
	mkdirSync(join(cwd, "notes"));
	const original = Buffer.from("Caf\xe9 subject\r\n\r\nLatin-1 body\r\n", "latin1");
	writeFileSync(join(cwd, "notes", "msg.txt"), original);
	const rows = bash(`cd '${root}' && git -C project commit -q --allow-empty --cleanup=verbatim -F notes/msg.txt`, scope());
	assert.deepEqual(readFileSync(join(cwd, "notes", "msg.txt")), original, "the person's file is never written");
	// Git itself re-encodes a message that is not UTF-8; the same file committed
	// without stamping shows exactly what git keeps, so only the tag may differ.
	const plain = repo(root, "plain", null);
	git(plain, "commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", join(cwd, "notes", "msg.txt"));
	assert.equal(message(cwd), message(plain).replace("subject\r\n", `subject ${TAG}\r\n`));
	assert.notEqual(message(plain), message(cwd));
	assert.equal(rows[0]?.stamp?.outcome, "stamped");
	assert.ok(rows.observerDir);
	assert.equal(readdirSync(rows.observerDir).some((name) => name.startsWith("message-")), false, "the private copy is removed");
});

test("-F - that cannot be tagged reaches git as the exact original bytes", (t) => {
	const cwd = repo(fixture(t), "project");
	const rows = bash(`cd '${cwd}' && printf 'Mine [devspec:${OTHER_TASK}]  \\n\\n\\n#kept\\n' | git commit -q --allow-empty --cleanup=verbatim -F -`, scope());
	assert.equal(message(cwd), `Mine [devspec:${OTHER_TASK}]  \n\n\n#kept\n`);
	assert.deepEqual(rows[0]?.stamp, { outcome: "skipped", reason: "has_reference", task: TASK, claims: 1 });
	bash(`cd '${cwd}' && printf '\\n#only a comment\\n' | git commit -q --allow-empty --allow-empty-message --cleanup=verbatim -F -`, scope());
	assert.equal(message(cwd), "\n#only a comment\n", "no line to tag: passed through byte for byte");
});

test("an existing reference, a different task's reference or a malformed one is never replaced", (t) => {
	const cwd = repo(fixture(t), "project");
	for (const subject of [`Own ${TAG}`, `Other [devspec:${OTHER_TASK}]`, "Broken [devspec:abc]"]) {
		const rows = bash(`cd '${cwd}' && git commit -q --allow-empty -m '${subject}'`, scope());
		assert.equal(message(cwd), `${subject}\n`);
		assert.equal(rows[0]?.stamp?.reason, "has_reference");
	}
});

test("amend, fixup, squash, -c/-C/--reuse-message, --no-edit and aliases are left alone", (t) => {
	const cwd = repo(fixture(t), "project");
	git(cwd, "config", "alias.ci", "commit");
	const cases: Array<[string, string, string | null]> = [
		[`git commit -q --allow-empty --amend -m 'Amended'`, "amend", "Amended\n"],
		[`git commit -q --allow-empty --amend --no-edit`, "amend", null],
		[`git commit -q --allow-empty --fixup HEAD`, "fixup", null],
		[`git commit -q --allow-empty --squash=HEAD -m 'Squash note'`, "squash", null],
		[`git commit -q --allow-empty -C HEAD`, "reuse_message", null],
		[`git commit -q --allow-empty --reuse-message=HEAD`, "reuse_message", null],
		[`git ci -q --allow-empty -m 'Via alias'`, "not_plain_commit", "Via alias\n"],
	];
	for (const [command, reason, expected] of cases) {
		const before = message(cwd);
		const rows = bash(`cd '${cwd}' && ${command}`, scope());
		const after = message(cwd);
		assert.equal(after.includes("[devspec:"), false, command);
		if (expected) assert.equal(after, expected, command);
		else if (!command.includes("--fixup") && !command.includes("--squash")) assert.equal(after, before, command);
		// An amend that changes nothing in the same second makes the same object: no new commit to report.
		if (rows.length > 0 || !command.includes("--no-edit")) assert.equal(rows.at(-1)?.stamp?.reason, reason, command);
	}
});

test("a repository outside the project stays untouched; a pin naming the project counts without a remote", (t) => {
	const root = fixture(t);
	const fixtureRepo = repo(root, "fixture", "https://example.invalid/someone/else.git");
	const rows = bash(`cd '${fixtureRepo}' && git commit -q --allow-empty -F - <<'EOF'\nFixture subject\nEOF`, scope());
	assert.equal(message(fixtureRepo), "Fixture subject\n");
	assert.equal(rows[0]?.stamp?.reason, "outside_project");
	const unpinned = repo(root, "no-remote", null);
	bash(`cd '${unpinned}' && git commit -q --allow-empty -m 'No remote'`, scope());
	assert.equal(message(unpinned), "No remote\n");
	const pinned = repo(root, "pinned", null);
	mkdirSync(join(pinned, ".devspec"));
	writeFileSync(join(pinned, ".devspec", "project.json"), JSON.stringify({ project_id: PROJECT }));
	bash(`cd '${pinned}' && git commit -q --allow-empty -m 'Pinned'`, scope({ remoteSha256: null }));
	assert.equal(message(pinned), `Pinned ${TAG}\n`);
	writeFileSync(join(pinned, ".devspec", "project.json"), JSON.stringify({ project_id: OTHER_PROJECT }));
	bash(`cd '${pinned}' && git commit -q --allow-empty -m 'Pinned elsewhere'`, scope({ remoteSha256: null }));
	assert.equal(message(pinned), "Pinned elsewhere\n");
	// A linked worktree of the project's repository shares its remote.
	const project = repo(root, "project");
	git(project, "worktree", "add", "-q", "-b", "topic", join(root, "linked"));
	bash(`cd '${join(root, "linked")}' && git commit -q --allow-empty -m 'From the worktree'`, scope());
	assert.equal(message(join(root, "linked")), `From the worktree ${TAG}\n`);
});

test("several claims, no stamping armed, or a value inherited from an enclosing session never tags", (t) => {
	const cwd = repo(fixture(t), "project");
	const rows = bash(`cd '${cwd}' && git commit -q --allow-empty -m 'Two claims'`, scope({ claimCount: 2, taskId: null }));
	assert.equal(message(cwd), "Two claims\n");
	assert.deepEqual(rows[0]?.stamp, { outcome: "skipped", reason: "several_claims", task: null, claims: 2 });
	const inherited = { DEVSPEC_PI_STAMP_PROJECT: PROJECT, DEVSPEC_PI_STAMP_CLAIMS: "1", DEVSPEC_PI_STAMP_TASK: TASK, DEVSPEC_PI_STAMP_REMOTE_SHA256: originFingerprint(REMOTE) };
	const unarmed = bash(`cd '${cwd}' && git commit -q --allow-empty -m 'Not armed'`, null, inherited);
	assert.equal(message(cwd), "Not armed\n");
	assert.equal(unarmed[0]?.stamp, undefined);
});

test("the argv reader finds the message source in every form git accepts and refuses what it does not know", () => {
	const source = (args: string[]) => readCommitMessageSource(args);
	assert.equal(source(["-m", "x"]).values[0], "x");
	assert.equal(source(["-amx"]).values[0], "x");
	assert.equal(source(["-qa", "-m", "x", "--", "file"]).values[0], "x");
	assert.equal(source(["--message=x", "-m", "y"]).first.prefix, "--message=");
	assert.equal(source(["--author", "A <a@b>", "--message", "x"]).values[0], "x");
	assert.equal(source(["-F", "-"]).source, "stdin");
	assert.equal(source(["--file=msg"]).path, "msg");
	assert.equal(source(["-Fmsg"]).path, "msg");
	assert.equal(source(["-S", "-m", "x"]).values[0], "x");
	assert.equal(source([]).skip, "editor");
	assert.equal(source(["-e", "-m", "x"]).skip, "edit");
	assert.equal(source(["-m", "x", "-F", "y"]).skip, "conflicting_messages");
	assert.equal(source(["--mess=x"]).skip, "unrecognised_option", "an abbreviation is not read");
	assert.equal(source(["-t", "tpl", "-m", "x"]).skip, "template");
	assert.equal(stampMessage("\n# comment\nSubject\n\nBody", "t"), "\n# comment\nSubject [devspec:t]\n\nBody");
	assert.equal(stampMessage("  \n#\n", "t"), null);
	assert.equal(readStampScope({ DEVSPEC_PI_STAMP_PROJECT: PROJECT, DEVSPEC_PI_STAMP_CLAIMS: "2", DEVSPEC_PI_STAMP_TASK: TASK }), null, "a task id with several claims is refused");
	assert.equal(readStampScope({ DEVSPEC_PI_STAMP_PROJECT: PROJECT, DEVSPEC_PI_STAMP_CLAIMS: "1" }), null);
});

test("the host arms the task only with exactly one claim and the remote only when the directory is verified", async () => {
	const claim = (taskId: string, projectId?: string) => ({ sessionId: SESSION, taskId, ...(projectId ? { projectId } : {}), observedAt: 1 });
	const deps = (claims: ReturnType<typeof claim>[], resolved: string | null = PROJECT) => ({
		claims: () => claims, originUrl: async () => `${REMOTE}\n`, resolveProject: async () => resolved,
	});
	const input = { sessionId: SESSION, projectId: PROJECT, cwd: "/repo" };
	assert.equal(await commitStampScope(input, deps([])), null);
	assert.deepEqual(await commitStampScope(input, deps([claim(TASK, PROJECT)])), { projectId: PROJECT, claimCount: 1, taskId: TASK, remoteSha256: originFingerprint(REMOTE) });
	assert.deepEqual(await commitStampScope(input, deps([claim(TASK, PROJECT), claim(OTHER_TASK)])), { projectId: PROJECT, claimCount: 2, taskId: null, remoteSha256: originFingerprint(REMOTE) });
	assert.equal((await commitStampScope(input, deps([claim(TASK, PROJECT), claim(OTHER_TASK, OTHER_PROJECT)])))?.taskId, TASK, "a claim in another project does not count");
	assert.equal((await commitStampScope(input, deps([claim(TASK)], OTHER_PROJECT)))?.remoteSha256, null);
	assert.equal((await commitStampScope(input, { ...deps([claim(TASK)]), resolveProject: async () => { throw new Error("offline"); } }))?.remoteSha256, null);
});

test("the model is told what happened to each commit's tag, and nothing for a commit outside the project", () => {
	const sha = "0123456789abcdef0123456789abcdef01234567";
	assert.equal(commitStampNote({ sha, stamp: { outcome: "stamped", reason: null, task: TASK, claims: 1 } }), `DevSpec: Pi added ${TAG} to the message of commit 0123456, for the one task claimed in this conversation.`);
	assert.match(commitStampNote({ sha, stamp: { outcome: "skipped", reason: "several_claims", task: null, claims: 2 } })!, /2 tasks are claimed in this conversation, so it cannot tell which one this commit is for\. Write the right task's \[devspec:<full-uuid>\] into the message yourself\./);
	assert.equal(commitStampNote({ sha, stamp: { outcome: "skipped", reason: "amend", task: TASK, claims: 1 } }), `DevSpec: Pi did not add ${TAG} to commit 0123456, because it amends an earlier commit. If this commit is for that task, write the tag into its message yourself.`);
	assert.equal(commitStampNote({ sha, stamp: { outcome: "skipped", reason: "outside_project", task: TASK, claims: 1 } }), null);
	assert.equal(commitStampNote({ sha, stamp: { outcome: "skipped", reason: "has_reference", task: TASK, claims: 1 } }), null);
	assert.equal(commitStampNote({ sha }), null);
});

test("-F - from a terminal is never read, and a failed read hands git what was read and the rest of stdin", () => {
	const inProject = () => ({ status: 0, stdout: `${REMOTE}\n` });
	const base = { args: ["commit", "-F", "-"], commandIndex: 0, globals: [], cwd: tmpdir(), worktree: tmpdir(), scope: { projectId: PROJECT, claims: 1, taskId: TASK, remoteSha256: originFingerprint(REMOTE) }, run: inProject, privateDir: tmpdir() };
	let reads = 0;
	const terminal = planCommitStamp({ ...base, stdinIsTerminal: () => true, readStdin: () => { reads += 1; return { bytes: Buffer.alloc(0), complete: true }; } });
	assert.deepEqual(terminal, { report: { v: 1, outcome: "skipped", reason: "terminal_stdin", task: TASK, claims: 1 } });
	assert.equal(reads, 0, "a terminal is left for git to read");
	const partial = planCommitStamp({ ...base, stdinIsTerminal: () => false, readStdin: () => ({ bytes: Buffer.from("Subj"), complete: false }) });
	assert.equal(partial.report.reason, "message_unreadable");
	assert.deepEqual(partial.stdin, Buffer.from("Subj"));
	assert.equal(partial.stdinRest, true, "the unread rest still reaches git");
	const stamped = planCommitStamp({ ...base, stdinIsTerminal: () => false, readStdin: () => ({ bytes: Buffer.from("Subject\n\nBody\n"), complete: true }) });
	assert.equal(stamped.stdin.toString(), `Subject ${TAG}\n\nBody\n`);
	assert.equal(stamped.args, undefined, "argv is unchanged for -F -");
});

test("Pi says it tags commits only where a working stand-in and a bonded connection exist (c4b14794)", (t) => {
	fixture(t);
	setBond(null as never);
	assert.equal(commitTaggingAvailable(), false, "no bond: nothing arms the stand-in");
	setBond({ projectId: PROJECT, connectionId: CONNECTION, connectionCapability: "fixture-capability" } as never);
	assert.equal(commitTaggingAvailable(), true, "a working stand-in, on POSIX and native Windows alike");
	resetGitObserverForTests();
	assert.equal(commitTaggingAvailable(), false, "no stand-in: the model writes the tag itself");
	setBond(null as never);
});

test("the stand-in, the repository and the message file may all sit under paths with spaces, named in either path style (c4b14794)", (t) => {
	// The stand-in's own directory comes from the temp directory: put a space in it,
	// and make it deep enough that a Trace2 socket path could not fit (git then
	// writes its events to files instead, as it always does on Windows).
	const spaced = realpathSync.native(mkdtempSync(join(tmpdir(), "devspec pi spaced ")));
	const temp = join(spaced, `temp dir ${"deep".repeat(15)}`);
	mkdirSync(temp);
	const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
	process.env.TMPDIR = temp; process.env.TMP = temp; process.env.TEMP = temp;
	resetGitObserverForTests();
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		resetGitObserverForTests();
		rmSync(spaced, { recursive: true, force: true });
	});
	assert.equal(initializeGitObserver(SESSION), true);
	const cwd = repo(spaced, "my project repo");
	mkdirSync(join(cwd, ".devspec"));
	writeFileSync(join(cwd, ".devspec", "project.json"), JSON.stringify({ project_id: PROJECT }));
	writeFileSync(join(cwd, "my message.txt"), "Message from a spaced file\n");
	// Native style everywhere, and on Windows also the POSIX form Git Bash prints.
	const posix = process.platform === "win32" ? `"$(/usr/bin/cygpath -u '${cwd}')"` : `'${cwd}'`;
	const pinned = scope({ remoteSha256: null });
	let rows = bash(`cd '${cwd}' && git commit -q --allow-empty -m 'Native style'`, pinned);
	assert.equal(message(cwd), `Native style ${TAG}\n`);
	assert.equal(rows[0]?.stamp?.outcome, "stamped");
	assert.ok(rows.observerDir.includes(" "), "the stand-in itself ran from a path with spaces");
	rows = bash(`cd ${posix} && git commit -q --allow-empty -F 'my message.txt'`, pinned);
	assert.equal(message(cwd), `Message from a spaced file ${TAG}\n`);
	assert.equal(readFileSync(join(cwd, "my message.txt"), "utf8"), "Message from a spaced file\n");
	rows = bash(`git -C ${posix} commit -q --allow-empty -F - <<'EOF'\nPOSIX style through -C\nEOF`, pinned);
	assert.equal(message(cwd), `POSIX style through -C ${TAG}\n`);
	assert.equal(rows[0]?.worktree, cwd);
});
