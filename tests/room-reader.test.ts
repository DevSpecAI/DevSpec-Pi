import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRoomStore, roomPrincipalFingerprint, type RoomStoreScope } from "../extensions/core/room-store.ts";
import { readLocalRoom, compactRoomAwareness, ROOM_READ_MAX_CHARS, roomScopeFromEntries } from "../extensions/core/room-reader.ts";
import type { PollPackage } from "../extensions/core/remote-payload.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-09-24T10:00:00.000Z";
const point = (n: number) => ({ sequence: n, created_at: at, message_id: id(n) });
const scope: RoomStoreScope = { endpoint: "https://fixture.invalid", projectId: id(1000), nativeSessionId: id(1001), connectionId: id(1002), sessionId: id(1003), attachmentId: id(1004) };
const fp = roomPrincipalFingerprint("fixture-token");
function packet(n: number): PollPackage {
	const records = Array.from({ length: n }, (_, i) => ({ message_id: id(i + 1), order: point(i + 1), actor: { kind: "agent" as const, user_id: null, display_name: "Other agent", agent_tool: "Other", model: null }, source_type: "external_agent", content: `message ${i + 1}` }));
	return { changed: true, canonicalState: "valid", systemNotices: [], dispatchCount: 0, roomPage: { history: false, records, window: { policy_version: "2026-09-24.1", returned: n, total_known: null, source_window: { start: point(1), end: point(n) }, truncated: false, has_more: false, next_cursor: null, fetch_id: null, omission_reason: null }, room: { version: 1, messages: records.map(r => ({ message_id: r.message_id, state: "final", addressee: { kind: "connection", connection_id: id(2000), label: "Another agent" }, attachments: [] })), coverage: { through: point(n), eligible_count: n, deleted_count: 0, open_message_ids: [] } } } };
}
async function fixture(n: number) {
	const root = mkdtempSync(join(tmpdir(), "pi-room-reader-"));
	const store = await openRoomStore(scope, { root, principalFingerprint: fp });
	store.apply(packet(n));
	return { root, store, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const result = (r: Record<string, unknown>) => r as any;

test("bounded newest-first history continues by stable cursor without a network", async () => {
	const f = await fixture(130);
	const oldFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("network forbidden"); };
	try {
		const seen = new Set<string>(); let cursor: string | undefined;
		do {
			const r = result(await readLocalRoom(scope, fp, { view: "history", limit: 20, cursor }, { root: f.root, offline: true }));
			assert.equal(r.network_used, false); assert.equal(r.access, "last_known_offline");
			assert(JSON.stringify(r).length <= ROOM_READ_MAX_CHARS);
			for (const row of r.records) { assert(!seen.has(row.message_id)); seen.add(row.message_id); }
			cursor = r.next_cursor ?? undefined;
		} while (cursor);
		assert.equal(seen.size, 130);
		const anchored = result(await readLocalRoom(scope, fp, { message_id: id(40), limit: 1 }, { root: f.root }));
		assert.equal(anchored.records[0].message_id, id(40));
	} finally { globalThis.fetch = oldFetch; f.close(); }
});

test("long exact messages are lossless bounded fragments; references stay references", async () => {
	const f = await fixture(1);
	try {
		const p = packet(1); const text = '\u0000🦎 " </data> ``` quoted history\n'.repeat(4000);
		p.roomPage!.records[0]!.content = text;
		p.roomPage!.room.messages[0]!.attachments = [{ materialization: "metadata", filename: "other.png", type: "image", mime_type: "image/png", resource_id: id(3000), size_bytes: 1_000_000_000 }];
		f.store.apply(p);
		let r = result(await readLocalRoom(scope, fp, { view: "message", message_id: id(1) }, { root: f.root }));
		let json = "";
		while (true) {
			assert(JSON.stringify(r).length <= ROOM_READ_MAX_CHARS);
			json += r.fragment.text;
			if (!r.next_cursor) break;
			r = result(await readLocalRoom(scope, fp, { cursor: r.next_cursor }, { root: f.root }));
		}
		const full = JSON.parse(json); assert.equal(full.content, text); assert.equal(full.attachments[0].resource_id, id(3000));
		assert.equal(full.authority, undefined); assert.equal(full.delivery, undefined);
	} finally { f.close(); }
});

test("deletion between fragments rejects the stale continuation rather than mixing bodies", async () => {
	const f = await fixture(1);
	try {
		const p = packet(1); p.roomPage!.records[0]!.content = "long ".repeat(4000); f.store.apply(p);
		const first = result(await readLocalRoom(scope, fp, { view: "message", message_id: id(1) }, { root: f.root }));
		p.roomPage!.room.messages[0]!.state = "deleted"; p.roomPage!.room.coverage!.deleted_count = 1; f.store.apply(p);
		const next = result(await readLocalRoom(scope, fp, { cursor: first.next_cursor }, { root: f.root }));
		assert.equal(next.availability, "changed"); assert.equal(next.fragment, undefined);
		const removed = result(await readLocalRoom(scope, fp, { view: "message", message_id: id(1) }, { root: f.root }));
		assert.equal(removed.value.state, "deleted"); assert.equal(removed.value.content, "");
	} finally { f.close(); }
});

test("search finds older matches across the cache without model-driven scanning", async () => {
	const f = await fixture(130);
	try {
		const p = packet(130); p.roomPage!.records[0]!.content = "old needle"; f.store.apply(p);
		const first = result(await readLocalRoom(scope, fp, { view: "search", query: "needle" }, { root: f.root }));
		assert.equal(first.records.length, 1); assert.equal(first.records[0].message_id, id(1));
		assert.equal(first.next_cursor, null);
	} finally { f.close(); }
});

test("checkpoint navigation, changed scopes and changed credentials are explicit", async () => {
	const f = await fixture(10);
	try {
		const initial = result(await readLocalRoom(scope, fp, { view: "status" }, { root: f.root }));
		f.store.apply(packet(20));
		const newer = result(await readLocalRoom(scope, fp, { since: initial.checkpoint }, { root: f.root }));
		assert.equal(newer.records.length, 10); assert(newer.records.every((r: any) => r.sequence > 10));
		assert.equal(result(await readLocalRoom(scope, "wrong", {}, { root: f.root })).availability, "unavailable");
		assert.equal(result(await readLocalRoom({ ...scope, attachmentId: id(9999) }, fp, { cursor: newer.next_cursor }, { root: f.root })).availability, "unavailable");
		assert.equal(result(await readLocalRoom(scope, fp, { cursor: "not-a-cursor" }, { root: f.root })).availability, "invalid_request");
		assert.equal(result(await readLocalRoom(scope, fp, {}, { root: f.root, current: () => false })).availability, "unavailable");
	} finally { f.close(); }
});

test("state remains an ID-only observed inventory and awareness is compact data", async () => {
	const f = await fixture(1);
	try {
		const p = packet(1); p.sessionActivity = { version: 1, status: "available", as_of: at, truncated: false, entries: [{ kind: "memory", id: id(5000), relation: "referenced" }] }; f.store.apply(p);
		const state = result(await readLocalRoom(scope, fp, { view: "state" }, { root: f.root }));
		assert.deepEqual(state.value.snapshots.activity.value.entries, [{ kind: "memory", id: id(5000), relation: "referenced" }]);
		const status = await readLocalRoom(scope, fp, { view: "status" }, { root: f.root });
		const awareness = compactRoomAwareness(status);
		assert(awareness.length < 1200); assert(awareness.includes("read_room_context")); assert(!awareness.includes("message 1"));
		assert.equal(roomScopeFromEntries([{ type: "custom", customType: "devspec-room-scope-v1", data: { version: 1, scope } }]), scope);
		assert.equal(roomScopeFromEntries([{ type: "custom", customType: "devspec-room-scope-v1", data: { version: 1, scope } }, { type: "custom", customType: "devspec-room-scope-v1", data: { version: 1, scope: null } }]), null);
	} finally { f.close(); }
});
