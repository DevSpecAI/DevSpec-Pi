import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomSync } from "../extensions/core/room-sync.ts";
import { openRoomStore } from "../extensions/core/room-store.ts";
import { parsePollPayload, type PollPackage } from "../extensions/core/remote-payload.ts";
import { roomPoll } from "./room-context-fixture.ts";
import { IDS, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";
const scope = { endpoint: "https://example.test", nativeSessionId: IDS.owner, connectionId: IDS.connection, projectId: IDS.project, sessionId: IDS.plan, attachmentId: IDS.step };
const parsed = (history = true) => parsePollPayload(roomPoll(history ? { wakeKind: "history_reseed", deliveryState: "replay" } : {}), TEST_CONNECTION, { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true });

test("recovery requires a live cursor and only calls the inactive catch-up lane", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-room-sync-")); const store = await openRoomStore(scope, { root });
	let cursor: string | undefined; const calls: Record<string, unknown>[] = []; let wakes = 0;
	const sync = new RoomSync({ store, current: () => true, liveCursor: () => cursor, intervalMs: 60_000, fetchHistory: async args => { calls.push(args); return parsed(); }, wake: () => wakes++, onError: () => assert.fail("unexpected error") });
	try {
		await sync.repairOnce(); assert.equal(calls.length, 0);
		cursor = "opaque-live-cursor"; await sync.repairOnce();
		assert.equal(calls.length, 1); assert.equal(calls[0]?.catch_up, true); assert.equal(calls[0]?.cursor_v2, cursor);
		assert.equal(calls[0]?.interaction_event_version, undefined); assert.equal(calls[0]?.busy, undefined);
		assert.equal(store.status().records, 4); assert.equal(wakes, 0);
	} finally { sync.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a supposedly historical response containing an active command is not stored/applied", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-room-sync-")); const store = await openRoomStore(scope, { root }); let errors = 0;
	const sync = new RoomSync({ store, current: () => true, liveCursor: () => "cursor", intervalMs: 60_000, fetchHistory: async () => parsed(false), wake: () => assert.fail("no wake"), onError: () => errors++ });
	try {
		await sync.repairOnce(); assert.equal(errors, 1); assert.equal(store.status().records, 0);
	} finally { sync.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a late repair callback cannot recreate a revoked cache", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-room-sync-")); let current = true;
	const store = await openRoomStore(scope, { root, current: () => current });
	let resolve!: (pkg: PollPackage) => void;
	const sync = new RoomSync({ store, current: () => current, liveCursor: () => "cursor", intervalMs: 60_000, fetchHistory: () => new Promise(r => { resolve = r; }), wake: () => assert.fail("no wake"), onError: () => assert.fail("stale callbacks stay silent") });
	try {
		const pending = sync.repairOnce(); current = false; sync.close(true); resolve(parsed()); await pending;
		const replacement = await openRoomStore({ ...scope, attachmentId: IDS.step2 }, { root });
		assert.equal(replacement.status().records, 0); replacement.close();
	} finally { sync.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ambient history is retained without a model wake and failed reads retain the checkpoint", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-room-sync-")); const store = await openRoomStore(scope, { root }); let errors = 0;
	const sync = new RoomSync({ store, current: () => true, liveCursor: () => "cursor", intervalMs: 60_000, fetchHistory: async () => { throw new Error("network down"); }, wake: () => assert.fail("ambient data cannot wake"), onError: () => errors++ });
	try {
		sync.observe(parsed()); assert.equal(store.status().records, 4);
		const before = store.status().through;
		store.markBehind(); await sync.repairOnce(); assert.equal(errors, 1);
		assert.deepEqual(store.status().through, before); assert.equal(store.status().online, false);
	} finally { sync.close(); rmSync(root, { recursive: true, force: true }); }
});
