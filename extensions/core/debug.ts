/**
 * DevSpec Pi — debug log (shared, env-gated).
 *
 * DEVSPEC_DEBUG_REMOTE=1 appends pump/recall/lifecycle play-by-play to
 * /tmp/devspec-remote-debug.log. Cross-extension-file safe (append-only).
 */

import { appendFileSync } from "node:fs";

export function debugRemote(line: string): void {
	if (!process.env.DEVSPEC_DEBUG_REMOTE) return;
	try {
		appendFileSync("/tmp/devspec-remote-debug.log", `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* debug never breaks anything */
	}
}
