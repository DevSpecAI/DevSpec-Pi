/**
 * DevSpec Pi — project scoping via git remote.
 *
 * DevSpec tokens are account-wide; the server resolves which project a call
 * belongs to. When it can't (user has multiple projects), the call errors —
 * and passing this checkout's `git remote get-url origin` as `git_remote` is
 * the supported disambiguation. We do that reactively: first call goes out
 * bare, and only a project-resolution error triggers one retry with the
 * remote attached (keeps calls minimal and never guesses).
 *
 * The matcher is pure (unit-tested); the remote lookup is cached per cwd.
 */

import { execFile } from "node:child_process";

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
