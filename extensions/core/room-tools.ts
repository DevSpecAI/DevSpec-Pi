import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBond } from "./bond-state.ts";
import { roomAccess, sameRoomScope } from "./room-access.ts";
import { resolveEndpoint, resolveToken } from "./auth-store.ts";
import { roomPrincipalFingerprint, type RoomStoreScope } from "./room-store.ts";
import { jsonSchemaToTypebox } from "./json-schema.ts";
import { noteModelToolResult } from "./context-budget.ts";
import { formatRoomUnreadNotice, noticeLocalRoom, readLocalRoom, roomScopeFromEntries, ROOM_READ_DESCRIPTION, ROOM_READ_SCHEMA, ROOM_READ_TOOL, ROOM_READ_PROMPT_METADATA, ROOM_UNREAD_CUSTOM_TYPE, type RoomReadInput, type RoomUnreadNotice } from "./room-reader.ts";

interface RoomReadScope { scope: RoomStoreScope | null; fingerprint: string; offline: boolean; current: () => boolean }
/** This conversation's attachment (live bond, else its last-known offline copy) and the fence that keeps it. */
async function roomReadScope(ctx: ExtensionContext): Promise<RoomReadScope | null> {
	const nativeSessionId = ctx.sessionManager.getSessionId();
	const auth = await resolveToken();
	if (!auth) return null;
	const endpoint = new URL(await resolveEndpoint());
	const normalizedEndpoint = `${endpoint.origin}${endpoint.pathname}`;
	const bond = getBond();
	const access = roomAccess(nativeSessionId);
	let scope: RoomStoreScope | null = null;
	if (bond?.projectId && bond.sessionId && bond.speechAttachmentId) {
		scope = { endpoint: normalizedEndpoint, projectId: bond.projectId, nativeSessionId, connectionId: bond.connectionId, sessionId: bond.sessionId, attachmentId: bond.speechAttachmentId };
	} else if (!bond) {
		scope = access ?? roomScopeFromEntries(ctx.sessionManager.getBranch());
		if (scope?.nativeSessionId !== nativeSessionId || scope?.endpoint !== normalizedEndpoint) scope = null;
	}
	if (access === null || (scope && access && !sameRoomScope(scope, access))) scope = null;
	const current = () => {
		try {
			const latestAccess = roomAccess(nativeSessionId);
			if (latestAccess === null || (scope && latestAccess && !sameRoomScope(scope, latestAccess))) return false;
			const now = getBond();
			return ctx.sessionManager.getSessionId() === nativeSessionId && (bond
				? now?.connectionId === bond.connectionId && now?.sessionId === bond.sessionId && now?.speechAttachmentId === bond.speechAttachmentId
				: now === null);
		} catch { return false; }
	};
	return { scope, fingerprint: roomPrincipalFingerprint(auth.token), offline: !bond, current };
}

export async function readRoomForContext(ctx: ExtensionContext, input: RoomReadInput = {}): Promise<Record<string, unknown>> {
	try {
		const room = await roomReadScope(ctx);
		if (!room) return { source: "local_room_snapshot", availability: "unavailable", reason: "Log in to select this conversation's saved room copy.", network_used: false };
		return await readLocalRoom(room.scope, room.fingerprint, input, { offline: room.offline, current: room.current });
	}
	catch { return { source: "local_room_snapshot", availability: "unavailable", reason: "Local room storage is unavailable. Use the existing online transcript/record tools.", network_used: false }; }
}

/** Unread counts for a wake ("always") or Pi's tool-result boundary ("fresh"); null when no copy is readable. */
export async function roomUnreadForContext(ctx: ExtensionContext, mode: "always" | "fresh"): Promise<RoomUnreadNotice | null> {
	try {
		const room = await roomReadScope(ctx);
		return room ? await noticeLocalRoom(room.scope, room.fingerprint, mode, { offline: room.offline, current: room.current }) : null;
	} catch { return null; }
}

/**
 * Pi's tool-result boundary (`turn_end`) is where the mid-turn notice goes, and
 * it doubles as the check before Pi's answer: the request that writes the final
 * message always follows either the wake notice or one of these boundaries
 * (ce1ffca1). Appended to the current turn as a hidden entry, so no earlier
 * provider message is re-rendered. Nothing new, or no tool result: nothing added.
 */
export async function roomUnreadBoundary(event: { toolResults: readonly unknown[]; outcome: string }, notice: () => Promise<RoomUnreadNotice | null>): Promise<{ entries: Array<{ type: "custom_message"; customType: string; content: string; display: boolean }> } | undefined> {
	if (event.outcome !== "completed" || event.toolResults.length === 0) return undefined;
	const unread = await notice();
	if (!unread?.fresh) return undefined;
	return { entries: [{ type: "custom_message", customType: ROOM_UNREAD_CUSTOM_TYPE, content: formatRoomUnreadNotice(unread), display: false }] };
}
export function registerRoomReader(pi: ExtensionAPI, activateFallback?: () => boolean): void {
	pi.registerTool({
		name: ROOM_READ_TOOL, label: "Read room context", description: ROOM_READ_DESCRIPTION, ...ROOM_READ_PROMPT_METADATA,
		parameters: jsonSchemaToTypebox(ROOM_READ_SCHEMA),
		async execute(_id, params, _signal, _update, ctx) {
			const details = await readRoomForContext(ctx, params as RoomReadInput);
			const coverage = details.coverage as { complete_through_cutoff?: boolean } | undefined;
			if (details.availability === "unavailable" || details.availability === "missing" || coverage?.complete_through_cutoff === false) {
				if (activateFallback?.()) details.online_fallback_tool = "get_session_transcript";
			}
			const text = JSON.stringify(details);
			noteModelToolResult(ROOM_READ_TOOL, text.length);
			return { content: [{ type: "text", text }], details };
		},
	});
}
