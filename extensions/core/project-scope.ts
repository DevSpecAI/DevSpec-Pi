/**
 * DevSpec Pi — project scoping via git remote, or a folder pin when there is no repo.
 *
 * DevSpec tokens are account-wide; the server resolves which project a call
 * belongs to. Hosts send folder facts — this checkout's `git remote get-url origin`
 * as `git_remote`, and/or `.devspec/project.json` as `pinned_project_id` — and
 * the SERVER ranks them. The client never decides precedence and never guesses.
 *
 * When the caller passes `cwd`, those facts go on the first request (Claude-shaped),
 * so a multi-project token can auto-bond without a round-trip that asks which
 * project. If the first call was still unscoped and the server asks, one retry
 * attaches the same facts — same client, extra args, not a reconnect.
 *
 * A folder with NO repo has no remote to send. The greenfield case — a project
 * planned in DevSpec before its code exists — names the project with a pin file:
 * `.devspec/project.json` holding `{ "project_id": "<uuid>" }`.
 *
 * The pin is sent as `pinned_project_id`, NEVER as `project_id`. They are not
 * interchangeable: `project_id` is an explicit override that outranks a verified
 * git remote, whereas the pin is only a local assertion and the server deliberately
 * ranks it BELOW a remote it can verify — so a pin copied in with a template
 * self-corrects instead of hijacking the folder. Both signals go together when
 * both exist; the SERVER arbitrates.
 *
 * Remote and pin identity are read fresh; only server-verified jurisdiction results
 * receive bounded endpoint/token/repository-aware caching in the nudge layer.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Does this server error mean "tell me which project this checkout is"? */
export function needsProjectScope(message: string): boolean {
	return /multiple (accessible )?projects|could not (resolve|determine).*project|unable to (resolve|determine).*project|no project.*(resolved|context)|project.*ambiguous|needs a project|more than one|pass (project_id|git_remote)/i.test(
		message,
	);
}

/** Credential-free bounded remote suitable for DevSpec transport, or null. */
export function sanitizeGitRemoteForTransport(remote: string | null): string | null {
	if (!remote) return null;
	const value = remote.trim();
	if (!value || value.length > 512 || /[\s?#\u0000-\u001f\u007f]/u.test(value)) return null;
	const scp = /^([^/@:]+)@([^/:]+):(.+)$/u.exec(value);
	if (scp && scp[1] !== "git") return null;
	if (/^https?:\/\//iu.test(value)) {
		try {
			const parsed = new URL(value);
			if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
		} catch { return null; }
	} else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
		try {
			const parsed = new URL(value);
			const safeSshUser = parsed.protocol.endsWith("ssh:") && parsed.username === "git";
			if (parsed.password || parsed.search || parsed.hash || (parsed.username && !safeSshUser)) return null;
		} catch { return null; }
	}
	return value;
}

/** This checkout's credential-free `origin` URL, or null. */
export function resolveGitRemote(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["remote", "get-url", "origin"],
			{ cwd, timeout: 3000 },
			(err, stdout) => {
				const url = !err && stdout ? stdout.trim() : null;
				resolve(sanitizeGitRemoteForTransport(url));
			},
		);
	});
}

/** Test hook. */
export function clearGitRemoteCache(): void {
	// Compatibility test hook. Repository identity is intentionally read fresh.
}

/** Run one bounded Git metadata query. Every unavailable/error state is null. */
function gitOutput(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((done) => {
		execFile("git", args, { cwd, timeout: 3000 }, (err, stdout) => {
			done(!err && stdout ? stdout : null);
		});
	});
}

/**
 * The repository's main working tree, shared by every linked worktree, or null.
 *
 * Git's absolute common directory identifies the repository. Its porcelain
 * worktree metadata then names the actual main checkout without guessing that
 * the common directory must be `<main-worktree>/.git` — an assumption that is
 * false for bare repositories and `--separate-git-dir` layouts.
 */
async function resolveRepositoryMainWorktree(cwd: string): Promise<string | null> {
	const commonDirectory = await gitOutput(cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (!commonDirectory?.trim()) return null;
	const absoluteCommonDirectory = resolve(commonDirectory.trim());
	if (basename(absoluteCommonDirectory) !== ".git") return null;

	const listing = await gitOutput(cwd, ["worktree", "list", "--porcelain", "-z"]);
	if (!listing) return null;

	const firstRecord = listing.split("\0\0", 1)[0];
	if (!firstRecord) return null;
	const fields = firstRecord.split("\0");
	if (fields.includes("bare")) return null;
	const worktree = fields.find((field) => field.startsWith("worktree "));
	if (!worktree) return null;
	const mainWorktree = resolve(worktree.slice("worktree ".length));
	return mainWorktree === dirname(absoluteCommonDirectory) ? mainWorktree : null;
}

/** Read one directory's pin. Null for every failure mode — see resolveProjectPin. */
function readPinAt(dir: string): Promise<string | null> {
	return readFile(join(dir, ".devspec", "project.json"), "utf8")
		.then((raw) => {
			const parsed: unknown = JSON.parse(raw);
			const id =
				parsed && typeof parsed === "object"
					? (parsed as { project_id?: unknown }).project_id
					: undefined;
			return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
		})
		.catch(() => null);
}

/**
 * The directories to check, nearest first (ADR dd0c1cff D12).
 *
 * We walk UP because "workspace root" and "current directory" are the same folder right
 * up until someone launches an agent from a subdirectory — routine in a monorepo. A pin
 * that works from the root and silently fails one level down is worse than no pin,
 * because the user believes the folder is anchored.
 *
 * Two bounds, and neither is an arbitrary depth cap — each is a real boundary:
 *   - the git repository root (inclusive): a repo is one tree with one identity, and a
 *     pin must never resolve from outside the repository that contains it;
 *   - $HOME (exclusive): `~/.devspec` is the MACHINE-state directory — connections,
 *     bonds, poller pids. A project.json at or above home would silently capture every
 *     folder the user owns, which is exactly the guessing 01892cce forbids.
 */
function isAtOrAbove(dir: string, boundary: string): boolean {
	const fromDir = relative(resolve(dir), resolve(boundary));
	return (
		fromDir === "" ||
		(fromDir !== ".." && !fromDir.startsWith(`..${sep}`) && !isAbsolute(fromDir))
	);
}

function pinSearchDirs(cwd: string, home: string): string[] {
	const dirs: string[] = [];
	let dir = resolve(cwd);
	const stopAbove = resolve(home);

	for (;;) {
		// Never read AT or above home — that is where machine state lives, not projects.
		// A checkout outside home (/srv/app) never meets this and stops at .git or /.
		if (dir === stopAbove) break;

		dirs.push(dir);

		// A repository root is the outermost directory a pin may come from.
		if (existsSync(join(dir, ".git"))) break;

		const parent = dirname(dir);
		if (parent === dir) break; // filesystem root
		dir = parent;
	}

	return dirs;
}

/**
 * This folder's DevSpec project pin — the nearest `.devspec/project.json`'s `project_id`
 * walking up from `cwd`, or null. Cached per cwd, like the remote.
 *
 * Every failure mode is a plain null: no file, unreadable, malformed JSON, or a
 * `project_id` that isn't a non-empty string. A pin is a convenience for resolving a
 * folder that has no repo; a broken one must never surface as an error on an unrelated
 * call, and must never be sent as a guess.
 */
export interface ProjectPinFile { path: string; projectId: string }

export async function resolveProjectPin(cwd: string, home: string = homedir()): Promise<string | null> {
	return (await resolveProjectPinFile(cwd, home))?.projectId ?? null;
}

/** Return the effective file as well as its value, so management never guesses a path. */
export function resolveProjectPinFile(
	cwd: string,
	home: string = homedir(),
): Promise<ProjectPinFile | null> {
	const dirs = pinSearchDirs(cwd, home);

	// Nearest wins, so an inner folder can deliberately override an outer one.
	// A linked worktree's cwd chain ends at its `.git` pointer, not at the main
	// checkout. Add the repository's main working tree as the final candidate so
	// repository-local jurisdiction follows Git identity across every worktree.
	const walk = async (): Promise<ProjectPinFile | null> => {
		for (const dir of dirs) {
			const id = await readPinAt(dir);
			if (id) return { path: join(dir, ".devspec", "project.json"), projectId: id };
		}

		const repositoryRoot = await resolveRepositoryMainWorktree(cwd);
		if (
			repositoryRoot &&
			!dirs.includes(repositoryRoot) &&
			!isAtOrAbove(repositoryRoot, home) &&
			pinSearchDirs(repositoryRoot, home)[0] === repositoryRoot
		) {
			const id = await readPinAt(repositoryRoot);
			return id ? { path: join(repositoryRoot, ".devspec", "project.json"), projectId: id } : null;
		}
		return null;
	};

	return walk();
}

/** True when the caller already named a project (explicit, remote, or pin). */
export function argsHaveProjectScope(args: Record<string, unknown>): boolean {
	return Boolean(args.git_remote || args.pinned_project_id || args.project_id);
}

/**
 * Folder facts for one MCP call. Server ranks them; never send the pin as `project_id`.
 */
export async function folderScopeArgs(cwd: string): Promise<{
	git_remote?: string;
	pinned_project_id?: string;
}> {
	const [remote, pin] = await Promise.all([
		resolveGitRemote(cwd),
		resolveProjectPin(cwd),
	]);
	return {
		...(remote ? { git_remote: remote } : {}),
		...(pin ? { pinned_project_id: pin } : {}),
	};
}

/** Remove only the effective default the human confirmed, never a newly changed value. */
export async function forgetProjectPin(pin: ProjectPinFile): Promise<void> {
	const current = await readPinAt(dirname(dirname(pin.path)));
	if (current !== pin.projectId) throw new Error("The folder default changed. Review it again before forgetting it.");
	await unlink(pin.path);
}

/** Test hook. */
export function clearProjectPinCache(): void {
	// Compatibility test hook. Pins are intentionally read fresh.
}

/** What a pin write did, so the caller can tell the user precisely what changed. */
export interface PinWriteResult {
	/** Absolute path of the file written. */
	path: string;
	/** The project id now pinned. */
	projectId: string;
	/** The id this replaced, when the folder was already pinned to something else. */
	replaced: string | null;
}

/**
 * Where a pin BELONGS for this folder (ADR dd0c1cff D13) — the mirror of the read walk.
 *
 * Inside a git repo it is the repository ROOT, because that is the only location the read
 * walk reaches from every subdirectory (it stops at the root), and it is where a
 * *committed* pin belongs — the whole teammate-onboarding benefit. Writing at the current
 * directory instead would leave a stray `.devspec/` halfway up the tree that resolves for
 * one subtree and not its siblings.
 *
 * With no repo — the greenfield case this exists for — the working directory IS the
 * project folder, so that is the target.
 */
export function pinTargetDir(cwd: string, home: string = homedir()): string {
	const dirs = pinSearchDirs(cwd, home);
	if (dirs.length === 0) return resolve(cwd);

	const outermost = dirs[dirs.length - 1] as string;
	// pinSearchDirs stops AT a repository root, so the last entry is the repo root when
	// there is one. Otherwise it is wherever the walk ran out, and cwd is the honest
	// answer — we must not pin a parent we only passed through.
	return existsSync(join(outermost, ".git")) ? outermost : resolve(cwd);
}

/**
 * Write this folder's pin. Returns what changed; throws only if the filesystem does.
 *
 * Deliberately does NOT decide whether writing is appropriate — that is the caller's job,
 * and the rules are in D9/D13/D14: explicit association or remember consent only,
 * never as a side effect of connecting, and a re-pin is stated before it happens. This
 * function reports `replaced` so the caller can say what it is about to overwrite rather
 * than repointing a whole team's committed folder on one person's say-so.
 *
 * `projectName` is written for human legibility only and is explicitly NON-authoritative —
 * readers ignore it (see readPinAt, which reads `project_id` alone). It exists so someone
 * reviewing the diff knows what the uuid is. Nothing else may go in this file: no path, no
 * hostname, no user, no token, no timestamp. That rule is what keeps the pin safe to
 * commit by construction (D10).
 */
export async function writeProjectPin(
	cwd: string,
	projectId: string,
	projectName?: string,
	home: string = homedir(),
): Promise<PinWriteResult> {
	const id = projectId.trim();
	if (!id) throw new Error("writeProjectPin: projectId is required");

	const dir = pinTargetDir(cwd, home);
	const replaced = await readPinAt(dir);

	const body: { project_id: string; project_name?: string } = { project_id: id };
	const name = projectName?.trim();
	if (name) body.project_name = name;

	await mkdir(join(dir, ".devspec"), { recursive: true });
	const path = join(dir, ".devspec", "project.json");
	await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");

	return { path, projectId: id, replaced: replaced === id ? null : replaced };
}
