/**
 * DevSpec Pi — the bonded session's display identity (item 9dcbd157).
 *
 * After an attach, Pi reads the room's transcript only to learn its title for
 * the status line. Conversational and model context arrive exclusively through
 * negotiated canonical ingress; the transcript never becomes model context here.
 * (The attach-time tail and agenda block this module used to build had no caller
 * left and clipped what it showed, so it was removed: DevSpec item 5a9eaa57.)
 */

import { isRealSessionTitle } from "./status-line.ts";

export interface SessionIdentity {
	sessionId: string;
	title: string | null;
}

/** The session's real title, or null for a brand-new room whose title is not generated yet. */
export function shapeTranscript(sessionId: string, raw: unknown): SessionIdentity {
	const t = (raw ?? {}) as { title?: unknown };
	return {
		sessionId,
		title: isRealSessionTitle(t.title) ? t.title.trim() : null,
	};
}
