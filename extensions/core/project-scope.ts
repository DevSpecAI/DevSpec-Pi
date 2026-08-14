/**
 * DevSpec Pi — project scoping via git remote, or a folder pin when there is no repo.
 *
 * DevSpec tokens are account-wide; the server resolves which project a call
 * belongs to. When it can't (user has multiple projects), the call errors —
 * and passing this checkout's `git remote get-url origin` as `git_remote` is
 * the supported disambiguation. We do that reactively: first call goes out
 * bare, and only a project-resolution error triggers one retry with the
 * remote attached (keeps calls minimal and never guesses).
 *
 * A folder with NO repo has no remote to send, which used to make that retry
 * useless — the greenfield case, where a project is planned in DevSpec before its
 * code exists. Such a folder names its project with a pin file instead:
 * `.devspec/project.json` holding `{ "project_id": "<uuid>" }`.
 *
 * The pin is sent as `pinned_project_id`, NEVER as `project_id`. They are not
 * interchangeable: `project_id` is an explicit override that outranks a verified
 * git remote, whereas the pin is only a local assertion and the server deliberately
 * ranks it BELOW a remote it can verify — so a pin copied in with a template
 * self-corrects instead of hijacking the folder. Both signals go on the retry when
 * both exist; the SERVER arbitrates. Never decide precedence here.
 *
 * The matcher is pure (unit-tested); remote and pin lookups are cached per cwd.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Does this server error mean "tell me which project this checkout is"? */
export function needsProjectScope(message: string): boolean {
	return /multiple (accessible )?projects|could not (resolve|determine).*project|unable to (resolve|determine).*project|no project.*(resolved|context)|project.*ambiguous|needs a project|more than one|pass (project_id|git_remote)/i.test(
		message,
	);
}

const remoteCache = new Map<string, string | null>();

/** This checkout's `origin` URL, or null outside a git repo. Cached per cwd. */
export function resolveGitRemote(cwd: string): Promise<string | null> {
	const hit = remoteCache.get(cwd);
	if (hit !== undefined) return Promise.resolve(hit);

	return new Promise((resolve) => {
		execFile(
			"git",
			["remote", "get-url", "origin"],
			{ cwd, timeout: 3000 },
			(err, stdout) => {
				const url = !err && stdout ? stdout.trim() : null;
				remoteCache.set(cwd, url && url.length > 0 ? url : null);
				resolve(remoteCache.get(cwd) ?? null);
			},
		);
	});
}

/** Test hook. */
export function clearGitRemoteCache(): void {
	remoteCache.clear();
}

const pinCache = new Map<string, string | null>();

/**
 * This folder's DevSpec project pin — `.devspec/project.json`'s `project_id`, or null.
 * Cached per cwd, like the remote.
 *
 * Every failure mode is a plain null: no file, unreadable, malformed JSON, or a
 * `project_id` that isn't a non-empty string. A pin is a convenience for resolving a
 * folder that has no repo; a broken one must never surface as an error on an unrelated
 * call, and must never be sent as a guess.
 */
export function resolveProjectPin(cwd: string): Promise<string | null> {
	const hit = pinCache.get(cwd);
	if (hit !== undefined) return Promise.resolve(hit);

	return readFile(join(cwd, ".devspec", "project.json"), "utf8")
		.then((raw) => {
			const parsed: unknown = JSON.parse(raw);
			const id =
				parsed && typeof parsed === "object"
					? (parsed as { project_id?: unknown }).project_id
					: undefined;
			return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
		})
		.catch(() => null)
		.then((id) => {
			pinCache.set(cwd, id);
			return id;
		});
}

/** Test hook. */
export function clearProjectPinCache(): void {
	pinCache.clear();
}
