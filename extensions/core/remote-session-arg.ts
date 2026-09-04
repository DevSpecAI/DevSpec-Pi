/**
 * Parse `/devspec.remote` arguments that name a room.
 *
 * Interactive Pi auto-bonds on session_start, so by the time this command
 * runs a pump already exists. Naming a session must attach that bond — not
 * refuse with "already bonded" (item e9ff729a). Keep this parser independent
 * of the pump module so the resume/attach contract can be tested cheaply.
 */

const SESSION_ARG = /^(?:--session|-s)\s+(\S+)$/;

export type BondedRemoteAction =
	| { type: "report_already_bonded" }
	| { type: "attach"; sessionId: string };

export function namedSessionFromRemoteArg(arg: string): string | undefined {
	return arg.trim().match(SESSION_ARG)?.[1];
}

export function bondedRemoteAction(arg: string): BondedRemoteAction {
	const sessionId = namedSessionFromRemoteArg(arg);
	if (sessionId) return { type: "attach", sessionId };
	return { type: "report_already_bonded" };
}
