import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBond } from "./bond-state.ts";
import { roomAccess, sameRoomScope } from "./room-access.ts";
import { resolveEndpoint, resolveToken } from "./auth-store.ts";
import { roomPrincipalFingerprint, type RoomStoreScope } from "./room-store.ts";
import { jsonSchemaToTypebox } from "./json-schema.ts";
import { noteModelToolResult } from "./context-budget.ts";
import { readLocalRoom, roomScopeFromEntries, ROOM_READ_DESCRIPTION, ROOM_READ_SCHEMA, ROOM_READ_TOOL, ROOM_READ_PROMPT_METADATA, type RoomReadInput } from "./room-reader.ts";

export async function readRoomForContext(ctx: ExtensionContext, input: RoomReadInput = {}): Promise<Record<string, unknown>> {
	const nativeSessionId = ctx.sessionManager.getSessionId();
	const auth = await resolveToken();
	if (!auth) return { source: "local_room_snapshot", availability: "unavailable", reason: "Log in to select this conversation's saved room copy.", network_used: false };
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
	try { return await readLocalRoom(scope, roomPrincipalFingerprint(auth.token), input, { offline: !bond, current }); }
	catch { return { source: "local_room_snapshot", availability: "unavailable", reason: "Local room storage is unavailable. Use the existing online transcript/record tools.", network_used: false }; }
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
