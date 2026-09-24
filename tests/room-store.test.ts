import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { openRoomStore, roomPrincipalFingerprint, roomStorePath, type RoomStoreScope } from "../extensions/core/room-store.ts";
import { parseActivityIndex } from "../extensions/core/room-context.ts";
import type { PollPackage, RoomRecord } from "../extensions/core/remote-payload.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-09-24T10:00:00.000Z";
const scope: RoomStoreScope = { endpoint: "https://example.test/api/mcp", projectId: id(9000), nativeSessionId: id(9001), connectionId: id(9002), sessionId: id(9003), attachmentId: id(9004) };
const point = (n: number) => ({ sequence: n, message_id: id(n), created_at: time });
const record = (n: number): RoomRecord => ({ message_id: id(n), order: point(n), actor: { kind: "agent", user_id: null, display_name: "Other agent", agent_tool: "Other", model: null }, source_type: "external_agent", content: `message ${n}` });
function page(first: number, last: number, total = last, older = false, more = false): PollPackage {
	const records = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => record(first + i));
	return {
		changed: true, systemNotices: [], dispatchCount: 0, canonicalState: "valid",
		roomPage: { history: older, records,
			window: { policy_version: "2026-09-24.1", returned: records.length, total_known: null, source_window: { start: records[0]?.order ?? null, end: records.at(-1)?.order ?? null }, truncated: more, has_more: more, next_cursor: more ? `before-${first}` : null, fetch_id: more ? "history" : null, omission_reason: more ? "history_before_window" : null },
			room: { version: 1, messages: records.map(r => ({ message_id: r.message_id, state: "final", addressee: { kind: "room" }, attachments: [] })), coverage: { through: point(last), eligible_count: total, deleted_count: 0, open_message_ids: [] } },
		},
	};
}
const temp = () => mkdtempSync(join(tmpdir(), "pi-room-store-"));

test("recognized corruption rebuilds, but an unknown future format is never deleted", async () => {
	const root = temp(); let store = await openRoomStore(scope, { root });
	try {
		store.apply(page(1, 1)); const path = store.path; store.close();
		writeFileSync(path, "not a sqlite database");
		store = await openRoomStore(scope, { root });
		assert.equal(store.status().records, 0); assert.equal(store.status().complete, false); store.close();
		const future = new DatabaseSync(path); future.exec("PRAGMA user_version=2"); future.close();
		const bytes = readFileSync(path);
		await assert.rejects(openRoomStore(scope, { root }), /future/);
		assert.deepEqual(readFileSync(path), bytes);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("private namespace cleanup expires only old attachments and rejects symlinked database paths", async () => {
	const root = temp(); const old = await openRoomStore(scope, { root });
	const other = await openRoomStore({ ...scope, nativeSessionId: id(9998) }, { root });
	try {
		const oldPath = old.path, otherPath = other.path; old.close(); other.close();
		const expired = new Date(Date.now() - 31 * 86400000);
		utimesSync(oldPath, expired, expired); utimesSync(otherPath, expired, expired);
		const next = await openRoomStore({ ...scope, attachmentId: id(9997) }, { root });
		assert.equal(existsSync(oldPath), false); assert.equal(existsSync(otherPath), true);
		if (process.platform !== "win32") {
			assert.equal(statSync(dirname(next.path)).mode & 0o777, 0o700);
			const alias = roomStorePath({ ...scope, attachmentId: id(9996) }, root);
			symlinkSync(otherPath, alias);
			await assert.rejects(openRoomStore({ ...scope, attachmentId: id(9996) }, { root }), /unsafe/);
			assert.equal(existsSync(otherPath), true);
		}
		next.close();
	} finally { old.close(); other.close(); rmSync(root, { recursive: true, force: true }); }
});

test("offline principal selection stores an irreversible hint, never the credential", async () => {
	const root = temp(); const token = "fixture-token-not-a-real-credential";
	const store = await openRoomStore(scope, { root, principalFingerprint: roomPrincipalFingerprint(token) });
	try {
		store.apply(page(1, 1));
		assert.equal(readFileSync(store.path).includes(Buffer.from(token)), false);
		assert.equal(JSON.stringify(store.state()).includes(roomPrincipalFingerprint(token)), false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("older pages and >500 live records remain complete, unique, private and durable", async () => {
	const root = temp(); let store = await openRoomStore(scope, { root });
	try {
		store.apply(page(81, 140, 140, false, true));
		assert.equal(store.status().complete, false);
		assert.deepEqual(store.nextRepair(), { kind: "older", before: "before-81" });
		store.apply(page(21, 80, 80, true, true), "older");
		store.close(); store = await openRoomStore(scope, { root });
		assert.equal(store.status().online, false);
		assert.deepEqual(store.nextRepair(), { kind: "older", before: "before-21" });
		// The repeated initial tail must not reset the committed older frontier.
		store.apply(page(81, 140, 140, false, true));
		assert.deepEqual(store.nextRepair(), { kind: "older", before: "before-21" });
		store.apply(page(1, 20, 20, true), "older");
		assert.equal(store.status().complete, true);
		store.apply(page(141, 640)); store.apply(page(641, 741));
		store.apply(page(641, 741));
		assert.equal(store.status().records, 741);
		assert.equal(store.status().complete, true);
		assert.equal(store.read()[0]?.content, "message 741");
		if (process.platform !== "win32") assert.equal(statSync(store.path).mode & 0o777, 0o600);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("restart fills a newer gap independently of a pending older frontier", async () => {
	const root = temp(); let store = await openRoomStore(scope, { root });
	try {
		store.apply(page(81, 140, 140, false, true));
		store.apply(page(21, 80, 80, true, true), "older");
		store.close(); store = await openRoomStore(scope, { root });
		store.apply(page(201, 260, 260, false, true));
		assert.deepEqual(store.nextRepair(), { kind: "repair", before: "before-201" });
		store.apply(page(141, 200, 200, true, true), "repair");
		assert.deepEqual(store.nextRepair(), { kind: "older", before: "before-21" });
		store.apply(page(1, 20, 20, true), "older");
		assert.equal(store.status().records, 260);
		assert.equal(store.status().complete, true);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const boundary of ["after_records", "before_commit", "after_commit"] as const) {
	test(`SQLite reopen at ${boundary} never splits records from checkpoints`, async () => {
		const root = temp(); let armed = false;
		let store = await openRoomStore(scope, { root, crash: step => { if (armed && step === boundary) throw new Error("crash"); } });
		try {
			store.apply(page(1, 1)); armed = true;
			assert.throws(() => store.apply(page(2, 2)));
			store.close(); store = await openRoomStore(scope, { root });
			assert.equal(store.status().records, boundary === "after_commit" ? 2 : 1);
			assert.equal(store.status().through?.sequence, boundary === "after_commit" ? 2 : 1);
		} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
	});
}

for (const boundary of ["after_records", "before_commit", "after_commit"] as const) {
	test(`abrupt child-process death at ${boundary} recovers the SQLite journal`, async () => {
		const root = temp(); let store = await openRoomStore(scope, { root });
		try {
			store.apply(page(1, 1)); store.close();
			const moduleUrl = new URL("../extensions/core/room-store.ts", import.meta.url).href;
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
				import { openRoomStore } from ${JSON.stringify(moduleUrl)};
				const [scope, root, packet, boundary] = process.argv.slice(1);
				const store = await openRoomStore(JSON.parse(scope), { root, crash: step => { if (step === boundary) process.kill(process.pid, 'SIGKILL'); } });
				store.apply(JSON.parse(packet));
				throw new Error('crash boundary not reached');
			`, JSON.stringify(scope), root, JSON.stringify(page(2, 2)), boundary], { timeout: 10_000, encoding: "utf8" });
			assert.equal(child.signal, "SIGKILL", child.stderr);
			store = await openRoomStore(scope, { root });
			assert.equal(store.status().records, boundary === "after_commit" ? 2 : 1);
			assert.equal(store.status().through?.sequence, boundary === "after_commit" ? 2 : 1);
		} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
	});
}

test("501 tombstones resume, erase text, and defeat stale pages and checks", async () => {
	const root = temp(); let store = await openRoomStore(scope, { root });
	try {
		store.apply(page(1, 500)); store.apply(page(501, 501));
		const deletion = page(502, 501);
		deletion.roomPage!.room.coverage!.deleted_count = 501;
		deletion.roomPage!.room.deletions = { message_ids: Array.from({ length: 500 }, (_, i) => id(i + 1)), truncated: true, total: 501, seen: { through: { deleted_at: time, message_id: id(500) }, total: null } };
		store.apply(deletion);
		assert.equal(store.status().complete, false);
		assert.equal(store.watch().room_deletions_seen?.total, null);
		store.close(); store = await openRoomStore(scope, { root });
		deletion.roomPage!.room.deletions = { message_ids: [id(501)], truncated: false, total: 501, seen: { through: { deleted_at: time, message_id: id(501) }, total: 501 } };
		store.apply(deletion); assert.equal(store.status().complete, true);
		store.apply(page(501, 501));
		const delayed = page(502, 501);
		delayed.roomPage!.room.coverage = null;
		delayed.roomPage!.room.open_check = [{ message_id: id(501), state: "final", entry: { ...record(501), advisory: true, relationship: "before_window" } }];
		store.apply(delayed);
		assert.equal(store.read()[0]?.state, "deleted");
		assert.equal(store.read()[0]?.content, "");
		assert.equal(readFileSync(store.path).includes(Buffer.from("message 501")), false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an observed excess row rebuilds once rather than looping on an impossible count", async () => {
	const root = temp(); const store = await openRoomStore(scope, { root });
	try {
		store.apply(page(1, 3));
		const changed = page(4, 3, 2); store.apply(changed);
		assert.equal(store.status().records, 0); assert.equal(store.status().complete, false);
		assert.deepEqual(store.nextRepair(), { kind: "repair" });
		const rebuilt = page(1, 3, 2, true);
		rebuilt.roomPage!.records = rebuilt.roomPage!.records.filter(r => r.message_id !== id(2));
		rebuilt.roomPage!.room.messages = rebuilt.roomPage!.room.messages.filter(r => r.message_id !== id(2));
		store.apply(rebuilt, "repair");
		assert.equal(store.status().records, 2); assert.equal(store.status().complete, true);
		assert.equal(store.nextRepair(), null);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("late deletion persists a relist request instead of acknowledging missing data", async () => {
	const root = temp(); const store = await openRoomStore(scope, { root });
	try {
		store.apply(page(1, 2)); const p = page(3, 2);
		p.roomPage!.room.deletions = { message_ids: [id(2)], total: 1, truncated: false, seen: { through: { deleted_at: time, message_id: id(2) }, total: 1 } };
		p.roomPage!.room.coverage!.deleted_count = 1; store.apply(p);
		p.roomPage!.room.deletions = { message_ids: [], total: 2, truncated: false, seen: { through: { deleted_at: time, message_id: id(2) }, total: 2 } };
		p.roomPage!.room.coverage!.deleted_count = 2; store.apply(p);
		assert.equal(store.watch().room_deletions_seen, null);
		assert.equal(store.status().complete, false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("activity is ID-only; failed reads retain a stale snapshot, explicit empty clears it", async () => {
	const root = temp(); const store = await openRoomStore(scope, { root });
	try {
		const p = page(1, 1);
		p.sessionActivity = parseActivityIndex({ version: 1, advisory: true, status: "available", as_of: time, truncated: false, entries: [{ kind: "memory", id: id(10), relation: "produced", title: "stale title", status: "superseded", body: "sensitive body", creator: { label: "old name" } }] });
		store.apply(p, "live", time);
		assert.deepEqual(store.activity()?.value?.entries, [{ kind: "memory", id: id(10), relation: "produced" }]);
		p.sessionActivity = null; store.apply(p, "live", "2026-09-24T11:00:00Z");
		assert.equal(store.activity()?.availability, "unavailable");
		assert.equal(store.activity()?.observedAt, time);
		assert.equal(store.activity()?.value?.entries.length, 1);
		p.sessionActivity = { version: 1, status: "available", as_of: time, truncated: false, entries: [] }; store.apply(p);
		assert.deepEqual(store.activity()?.value?.entries, []);
		for (const secret of ["stale title", "superseded", "sensitive body", "old name"]) assert.equal(readFileSync(store.path).includes(Buffer.from(secret)), false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a quiet history-only start initializes the index, but older recovery cannot undo a newer empty index", async () => {
	const root = temp(); const store = await openRoomStore(scope, { root });
	try {
		const p = page(1, 1, 1, true);
		p.sessionActivity = { version: 1, status: "available", as_of: time, truncated: false, entries: [{ kind: "action_item", id: id(10), relation: "produced" }] };
		store.apply(p, "repair"); assert.equal(store.activity()?.value?.entries.length, 1);
		const newer = page(1, 1);
		newer.sessionActivity = { version: 1, status: "available", as_of: "2026-09-24T11:00:00Z", truncated: false, entries: [] };
		store.apply(newer); store.apply(p, "repair");
		assert.deepEqual(store.activity()?.value?.entries, []);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("long text and another agent's file reference survive without materialization or transport secrets", async () => {
	const root = temp(); const store = await openRoomStore(scope, { root });
	try {
		const p = page(1, 1); const text = "Long exact text 🦎\\n".repeat(2000);
		p.roomPage!.records[0]!.content = text;
		p.roomPage!.room.messages[0]!.addressee = { kind: "connection", connection_id: id(13), label: "Other agent" };
		p.roomPage!.room.messages[0]!.attachments = [{ materialization: "metadata", filename: "other.png", mime_type: "image/png", type: "image", size_bytes: 10, resource_id: id(14) }];
		Object.assign(p, { connection_capability: "TRANSPORT-CAPABILITY-SENTINEL", signed_url: "SIGNED-DOWNLOAD-SENTINEL" });
		store.apply(p); const row = store.read()[0]!;
		assert.equal(row.content, text); assert.equal(row.attachments[0]?.resource_id, id(14));
		assert.deepEqual(row.addressee, { kind: "connection", connection_id: id(13), label: "Other agent" });
		for (const secret of ["TRANSPORT-CAPABILITY-SENTINEL", "SIGNED-DOWNLOAD-SENTINEL"]) assert.equal(readFileSync(store.path).includes(Buffer.from(secret)), false);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("attachment and native-session scopes cannot mix; late callbacks cannot commit", async () => {
	const root = temp(); let current = true;
	const a = await openRoomStore(scope, { root, current: () => current });
	const b = await openRoomStore({ ...scope, nativeSessionId: id(9999) }, { root });
	try {
		a.apply(page(1, 1)); assert.equal(b.status().records, 0); assert.notEqual(a.path, b.path);
		current = false; assert.throws(() => a.apply(page(2, 2))); assert.throws(() => a.read());
		a.close(true); assert.equal(b.status().records, 0);
	} finally { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});
