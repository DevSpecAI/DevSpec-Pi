/**
 * DevSpec-Pi commit tag stamping, inside the private git stand-in (DevSpec item
 * df71ab6c; the owner settled the reversal of 22f10809, 2c971806 and 5f9fd5dc).
 *
 * The stand-in sees git's exact argv after the shell has evaluated it, so nothing
 * here reads shell text. A plain `git commit` gets the claimed task's
 * `[devspec:<uuid>]` appended to its subject line only when every condition holds:
 * exactly one task is claimed, the repository's origin remote or project pin
 * matches that task's project, the message comes from `-m`, `-F <file>` or `-F -`,
 * none of the message-inheriting forms is used, and the message carries no
 * `[devspec:` reference already. Anything else runs exactly as before. When Pi
 * cannot tag, it says why; it never blocks a commit.
 *
 * Self-contained on purpose: the stand-in copies this file next to itself.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isatty } from "node:tty";
import { basename, dirname, join, resolve, sep } from "node:path";

export const STAMP_ENV = Object.freeze({
	project: "DEVSPEC_PI_STAMP_PROJECT",
	claims: "DEVSPEC_PI_STAMP_CLAIMS",
	task: "DEVSPEC_PI_STAMP_TASK",
	remote: "DEVSPEC_PI_STAMP_REMOTE_SHA256",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REFERENCE = /\[devspec:/iu;

/** What the host armed for this one tool call, or null when nothing may be stamped. */
export function readStampScope(env) {
	const projectId = env[STAMP_ENV.project]?.toLowerCase();
	const claims = Number.parseInt(env[STAMP_ENV.claims] ?? "", 10);
	if (!projectId || !UUID.test(projectId) || !Number.isSafeInteger(claims) || claims < 1) return null;
	const task = env[STAMP_ENV.task]?.toLowerCase() || null;
	if (claims === 1 ? !task || !UUID.test(task) : task !== null) return null;
	const remote = env[STAMP_ENV.remote]?.toLowerCase() || null;
	if (remote !== null && !SHA256.test(remote)) return null;
	return { projectId, claims, taskId: task, remoteSha256: remote };
}

export function remoteFingerprint(url) {
	return createHash("sha256").update(url.trim()).digest("hex");
}

/** The directory git runs in after its own `-C` options, or null for a git-dir override. */
export function effectiveCwd(globals, cwd) {
	let dir = cwd;
	for (let i = 0; i < globals.length; i += 1) {
		const arg = globals[i];
		if (arg === "-C") { dir = resolve(dir, globals[i + 1]); i += 1; continue; }
		if (arg.startsWith("-C")) { dir = resolve(dir, arg.slice(2)); continue; }
		if (arg === "--git-dir" || arg === "--work-tree" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) return null;
	}
	return dir;
}

const SKIP_LONG = new Map([
	["--amend", "amend"], ["--fixup", "fixup"], ["--squash", "squash"],
	["--reedit-message", "reuse_message"], ["--reuse-message", "reuse_message"],
	["--no-edit", "no_edit"], ["--edit", "edit"], ["--template", "template"],
	["--interactive", "interactive"], ["--patch", "interactive"],
	["--dry-run", "dry_run"], ["--short", "dry_run"], ["--porcelain", "dry_run"], ["--long", "dry_run"], ["--null", "dry_run"], ["--branch", "dry_run"],
]);
const FLAG_LONG = new Set([
	"--all", "--no-all", "--quiet", "--no-quiet", "--verbose", "--no-verbose", "--signoff", "--no-signoff",
	"--no-verify", "--verify", "--allow-empty", "--allow-empty-message", "--no-post-rewrite", "--post-rewrite",
	"--include", "--no-include", "--only", "--no-only", "--reset-author", "--no-reset-author",
	"--status", "--no-status", "--no-gpg-sign", "--pathspec-file-nul", "--ahead-behind", "--no-ahead-behind",
]);
const VALUE_LONG = new Set(["--author", "--date", "--cleanup", "--trailer", "--pathspec-from-file", "--unified", "--inter-hunk-context"]);
const ATTACHED_ONLY_LONG = new Set(["--gpg-sign", "--untracked-files"]);
const SHORT_FLAGS = new Set(["a", "q", "v", "s", "n", "i", "o"]);
const SHORT_SKIP = new Map([["e", "edit"], ["p", "interactive"], ["z", "dry_run"], ["c", "reuse_message"], ["C", "reuse_message"], ["t", "template"]]);
const SHORT_OPTIONAL = new Set(["u", "S"]);

/**
 * Where a commit's message comes from, read from `git commit`'s own argv (the
 * arguments after `commit`). Every shape this does not know is a reason to leave
 * the commit alone.
 */
export function readCommitMessageSource(rest) {
	const messages = [];
	const files = [];
	let options = true;
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (!options || arg === "-" || !arg.startsWith("-")) continue; // pathspecs
		if (arg === "--") { options = false; continue; }
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg : arg.slice(0, eq);
			if (name === "--message" || name === "--file") {
				const target = name === "--message" ? messages : files;
				if (eq !== -1) target.push({ index: i, prefix: `${name}=` });
				else if (i + 1 < rest.length) { target.push({ index: i + 1, prefix: "" }); i += 1; }
				else return { skip: "unrecognised_option" };
				continue;
			}
			if (SKIP_LONG.has(name)) return { skip: SKIP_LONG.get(name) };
			if (FLAG_LONG.has(name) && eq === -1) continue;
			if (VALUE_LONG.has(name)) {
				if (eq === -1) { if (i + 1 >= rest.length) return { skip: "unrecognised_option" }; i += 1; }
				continue;
			}
			if (ATTACHED_ONLY_LONG.has(name)) continue;
			return { skip: "unrecognised_option" };
		}
		for (let j = 1; j < arg.length; j += 1) {
			const c = arg[j];
			if (SHORT_FLAGS.has(c)) continue;
			if (SHORT_SKIP.has(c)) return { skip: SHORT_SKIP.get(c) };
			if (SHORT_OPTIONAL.has(c)) break; // the rest of the cluster is its value
			if (c === "m" || c === "F" || c === "U") {
				const target = c === "m" ? messages : c === "F" ? files : null;
				if (j + 1 < arg.length) target?.push({ index: i, prefix: arg.slice(0, j + 1) });
				else if (i + 1 < rest.length) { target?.push({ index: i + 1, prefix: "" }); i += 1; }
				else return { skip: "unrecognised_option" };
				break;
			}
			return { skip: "unrecognised_option" };
		}
	}
	if (messages.length > 0 && files.length > 0) return { skip: "conflicting_messages" };
	if (files.length > 1) return { skip: "conflicting_messages" };
	if (messages.length > 0) {
		return { source: "message", first: messages[0], values: messages.map((entry) => rest[entry.index].slice(entry.prefix.length)) };
	}
	if (files.length === 1) {
		const value = rest[files[0].index].slice(files[0].prefix.length);
		return value === "-" ? { source: "stdin" } : { source: "file", entry: files[0], path: value };
	}
	return { skip: "editor" };
}

/**
 * The message with the tag at the end of its first line that has text and is not
 * a `#` comment: the subject for every ordinary message, never after a trailer.
 * Null when there is no such line. Works on a latin1 view, so every byte of a
 * file or stdin round-trips exactly.
 */
export function stampMessage(text, taskId) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.trim() === "" || line.startsWith("#")) continue;
		const cr = line.endsWith("\r");
		lines[i] = `${cr ? line.slice(0, -1) : line} [devspec:${taskId}]${cr ? "\r" : ""}`;
		return lines.join("\n");
	}
	return null;
}

export function stampMessageBytes(bytes, taskId) {
	const stamped = stampMessage(bytes.toString("latin1"), taskId);
	return stamped === null ? null : Buffer.from(stamped, "latin1");
}

export function carriesReference(value) {
	return REFERENCE.test(Buffer.isBuffer(value) ? value.toString("latin1") : value);
}

function readPin(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, ".devspec", "project.json"), "utf8"));
		const id = parsed && typeof parsed === "object" ? parsed.project_id : null;
		return typeof id === "string" && id.trim() ? id.trim().toLowerCase() : null;
	} catch {
		return null;
	}
}

/**
 * Whether the commit's repository belongs to the claimed task's project: its
 * origin remote is the one the host verified, or its nearest pin (walking up to
 * the worktree root, then the main worktree) names that project.
 */
export function repositoryInProject(run, worktree, cwd, scope) {
	if (scope.remoteSha256) {
		const remote = run(["-C", worktree, "remote", "get-url", "origin"]);
		if (remote.status === 0 && remote.stdout.trim() && remoteFingerprint(remote.stdout) === scope.remoteSha256) return true;
	}
	const root = resolve(worktree);
	let dir = resolve(cwd ?? worktree);
	try { dir = realpathSync(dir); } catch { /* a missing directory has no pin */ }
	if (dir === root || dir.startsWith(`${root}${sep}`)) {
		for (;;) {
			const pin = readPin(dir);
			if (pin !== null) return pin === scope.projectId;
			if (dir === root) break;
			dir = dirname(dir);
		}
	}
	const common = run(["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const commonDir = common.status === 0 ? common.stdout.trim() : "";
	if (commonDir && basename(commonDir) === ".git") {
		const pin = readPin(dirname(commonDir));
		if (pin !== null) return pin === scope.projectId;
	}
	return false;
}

/** Read all of stdin. `complete` is false when a read failed part-way. */
export function readAllStdin(fd = 0) {
	const chunks = [];
	const buffer = Buffer.alloc(64 * 1024);
	for (;;) {
		let read;
		try {
			read = readSync(fd, buffer, 0, buffer.length, null);
		} catch (error) {
			if (error && error.code === "EAGAIN") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; }
			if (error && error.code === "EOF") return { bytes: Buffer.concat(chunks), complete: true };
			return { bytes: Buffer.concat(chunks), complete: false };
		}
		if (read === 0) return { bytes: Buffer.concat(chunks), complete: true };
		chunks.push(Buffer.from(buffer.subarray(0, read)));
	}
}

function report(scope, outcome, reason) {
	return { v: 1, outcome, reason, task: scope.taskId, claims: scope.claims };
}

/** Why a commit that never reached the stamping step was left alone. */
export function unplannedReport(scope, inProject) {
	if (!inProject) return report(scope, "skipped", "outside_project");
	if (scope.claims !== 1) return report(scope, "skipped", "several_claims");
	return report(scope, "skipped", "not_plain_commit");
}

/**
 * Decide, for one `git commit` invocation, whether and how to tag it. Returns the
 * report to journal and, when stamping, the replacement argv, stdin or private
 * message file. The person's own message file is never written.
 */
export function planCommitStamp({ args, commandIndex, globals, cwd, worktree, scope, run, privateDir, stdinIsTerminal = () => isatty(0), readStdin = readAllStdin }) {
	const dir = effectiveCwd(globals, cwd);
	if (dir === null) return { report: report(scope, "skipped", repositoryInProject(run, worktree, null, scope) ? "not_plain_commit" : "outside_project") };
	if (!repositoryInProject(run, worktree, dir, scope)) return { report: report(scope, "skipped", "outside_project") };
	if (scope.claims !== 1 || !scope.taskId) return { report: report(scope, "skipped", "several_claims") };
	const rest = args.slice(commandIndex + 1);
	const source = readCommitMessageSource(rest);
	if (source.skip) return { report: report(scope, "skipped", source.skip) };
	const taskId = scope.taskId;
	if (source.source === "message") {
		if (source.values.some((value) => carriesReference(value))) return { report: report(scope, "skipped", "has_reference") };
		const stamped = stampMessage(source.values[0], taskId);
		if (stamped === null) return { report: report(scope, "skipped", "no_subject") };
		const next = [...args];
		next[commandIndex + 1 + source.first.index] = `${source.first.prefix}${stamped}`;
		return { report: report(scope, "stamped", null), args: next };
	}
	if (source.source === "file") {
		let bytes;
		try { bytes = readFileSync(resolve(dir, source.path)); } catch { return { report: report(scope, "skipped", "message_file_unreadable") }; }
		if (carriesReference(bytes)) return { report: report(scope, "skipped", "has_reference") };
		const stamped = stampMessageBytes(bytes, taskId);
		if (stamped === null) return { report: report(scope, "skipped", "no_subject") };
		const copy = join(privateDir, `message-${randomUUID()}.txt`);
		try { writeFileSync(copy, stamped, { mode: 0o600, flag: "wx" }); } catch { return { report: report(scope, "skipped", "message_file_unreadable") }; }
		const next = [...args];
		next[commandIndex + 1 + source.entry.index] = `${source.entry.prefix}${copy}`;
		return { report: report(scope, "stamped", null), args: next, privateFile: copy };
	}
	// `-F -`: git would read all of stdin anyway. Whatever is read reaches git
	// exactly as it was unless it is tagged; a failed read hands over what was read
	// and then the rest of stdin untouched.
	if (stdinIsTerminal()) return { report: report(scope, "skipped", "terminal_stdin") };
	const { bytes, complete } = readStdin();
	if (!complete) return { report: report(scope, "skipped", "message_unreadable"), stdin: bytes, stdinRest: true };
	if (carriesReference(bytes)) return { report: report(scope, "skipped", "has_reference"), stdin: bytes };
	const stamped = stampMessageBytes(bytes, taskId);
	if (stamped === null) return { report: report(scope, "skipped", "no_subject"), stdin: bytes };
	return { report: report(scope, "stamped", null), stdin: stamped };
}
