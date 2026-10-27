/** Cross-extension read availability, not server/execution authority. */
import type { RoomStoreScope } from "./room-store.ts";
const KEY = Symbol.for("devspec.pi.room-read-access.v1");
function entries(): Map<string, RoomStoreScope | null> {
	const root = globalThis as typeof globalThis & { [KEY]?: Map<string, RoomStoreScope | null> };
	return root[KEY] ??= new Map();
}
export function observeRoomAccess(nativeSessionId: string, scope: RoomStoreScope | null): void { entries().set(nativeSessionId, scope); }
export function roomAccess(nativeSessionId: string): RoomStoreScope | null | undefined { return entries().get(nativeSessionId); }
export function sameRoomScope(a: RoomStoreScope, b: RoomStoreScope): boolean {
	return a.endpoint === b.endpoint && a.projectId === b.projectId && a.nativeSessionId === b.nativeSessionId && a.connectionId === b.connectionId && a.sessionId === b.sessionId && a.attachmentId === b.attachmentId;
}
