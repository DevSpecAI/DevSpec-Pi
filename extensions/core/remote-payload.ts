/**
 * DevSpec Pi — remote-control payload handling (pure, unit-tested).
 *
 * Turns poll_connection responses into deliveries. Authority rules come from
 * the delivery contract (docs/REMOTE-CONTROL-DELIVERY-CONTRACT.md): act ONLY
 * on commands addressed to this connection with owner authority; advisory
 * tiers (owner_ambient, room_context) never wake or execute.
 */

export interface OwnerCommand {
	/** The owner's message text. */
	text: string;
	/** Display name of the sender, when the server provides it. */
	userName?: string;
	/** Server message id, when present (used as the poll cursor). */
	id?: string;
}

interface RawCommand {
	id?: unknown;
	content?: unknown;
	message?: unknown;
	text?: unknown;
	body?: unknown;
	user_name?: unknown;
	userName?: unknown;
	sender?: unknown;
	addressed_to?: { connection_id?: unknown } | unknown;
	authority?: { kind?: unknown } | unknown;
}

export interface PollPackage {
	changed: boolean;
	cursor?: string;
	dispatchCursor?: string;
	ownerCommands: OwnerCommand[];
	/** Count of live assignment dispatches (handled in slice 2). */
	dispatchCount: number;
}

function commandText(cmd: RawCommand): string | null {
	for (const key of ["content", "message", "text", "body"] as const) {
		const v = cmd[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return null;
}

function commandSender(cmd: RawCommand): string | undefined {
	for (const key of ["user_name", "userName", "sender"] as const) {
		const v = cmd[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

/**
 * Extract the commands this connection must act on.
 * A command counts when addressed_to.connection_id matches us AND
 * authority.kind is "owner". Missing stamps mean NOT actionable — fail closed.
 */
export function extractOwnerCommands(payload: unknown, connectionId: string): OwnerCommand[] {
	const p = payload as { commands?: RawCommand[] } | null;
	const commands = Array.isArray(p?.commands) ? (p.commands as RawCommand[]) : [];
	const out: OwnerCommand[] = [];
	for (const cmd of commands) {
		const addressed = (cmd.addressed_to as { connection_id?: unknown } | undefined)?.connection_id;
		const authority = (cmd.authority as { kind?: unknown } | undefined)?.kind;
		if (addressed !== connectionId || authority !== "owner") continue;
		const text = commandText(cmd);
		if (!text) continue;
		out.push({ text, userName: commandSender(cmd), id: typeof cmd.id === "string" ? cmd.id : undefined });
	}
	return out;
}

/** Parse a raw poll_connection payload into cursors + actionable commands. */
export function parsePollPayload(payload: unknown, connectionId: string): PollPackage {
	const p = (payload ?? {}) as {
		changed?: unknown;
		cursor?: unknown;
		dispatch_cursor?: unknown;
		dispatches?: unknown[];
	};
	return {
		changed: p.changed === true,
		cursor: typeof p.cursor === "string" ? p.cursor : undefined,
		dispatchCursor: typeof p.dispatch_cursor === "string" ? p.dispatch_cursor : undefined,
		ownerCommands: extractOwnerCommands(payload, connectionId),
		dispatchCount: Array.isArray(p.dispatches) ? p.dispatches.length : 0,
	};
}

/** Bond-derived identity the envelope stamps (item 9dcbd157). */
export interface EnvelopeContext {
	sessionId?: string;
	sessionTitle?: string;
	/** The bond owner's display name — used when the command itself carries none. */
	ownerName?: string;
}

/** Format an owner command as the user message injected into pi. */
export function formatInboundMessage(cmd: OwnerCommand, codename: string, bond?: EnvelopeContext): string {
	// Names, not roles (9dcbd157 layer 4): the command's own sender name when
	// the server provides one, else the bond owner's name learned at attach.
	const who = cmd.userName ?? bond?.ownerName ?? "owner";
	// Every envelope carries WHERE it belongs: the session id, plus the title
	// when the attach-time fetch learned it. The model never discovers its own
	// session id as a side effect again.
	const sessionStamp = bond?.sessionId
		? ` · ${bond.sessionTitle ? `“${bond.sessionTitle.length > 26 ? `${bond.sessionTitle.slice(0, 25)}…` : bond.sessionTitle}” ` : ""}(${bond.sessionId.slice(0, 8)})`
		: "";
	const header = `[DevSpec remote — message from ${who} to ${codename}${sessionStamp}]`;
	const body = cmd.text;
	// The TUI previews a queued follow-up by its FIRST line only — so line one
	// must carry content, never a bare envelope (item 2b072496: header-only
	// first lines made real queued messages indistinguishable from empty
	// "phantom" envelopes). Single-line bodies ride the header directly;
	// multiline messages lead with an excerpt of their first line.
	if (!body.includes("\n")) return `${header} ${body}`;
	const firstLine = body.split("\n", 1)[0] ?? "";
	const excerpt = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : `${firstLine} …`;
	return `${header} — “${excerpt}”\n\n${body}`;
}
