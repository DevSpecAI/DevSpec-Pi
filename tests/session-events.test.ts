import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { advertisesSessionEvents, parseSessionEvents, type SessionEvents } from "../extensions/core/session-events.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { openRoomStore, type RoomStoreScope } from "../extensions/core/room-store.ts";
import { readLocalRoom, ROOM_READ_MAX_CHARS } from "../extensions/core/room-reader.ts";
import { RoomSync } from "../extensions/core/room-sync.ts";
import { TEST_CONNECTION, IDS } from "./canonical-ingress-fixture.ts";
import { roomPoll } from "./room-context-fixture.ts";

const options = { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true, sessionEventsNegotiated: true };
const at = "2026-09-25T14:30:01.123456+00:00";
const revision = `sha256:${"e".repeat(64)}`;
const produced = { id: "produced:one", at, kind: "task" as const, record_id: IDS.command, event: "produced" as const, actor: { kind: "person" as const, label: "Ali Price" } };
const moved = { id: "lifecycle:one", at, kind: "task" as const, record_id: IDS.command, event: "lifecycle_changed" as const, from: "open", to: "implemented" };
const section = (extra: Partial<SessionEvents> = {}): SessionEvents => ({ version: 1, advisory: true, status: "available", as_of: "2026-09-25T15:00:00Z", revision, events: [moved, produced], truncated: false, ...extra });
const scope: RoomStoreScope = { endpoint: "https://example.test/api/mcp", projectId: IDS.command, nativeSessionId: "event-test", connectionId: TEST_CONNECTION.connection_id, sessionId: TEST_CONNECTION.session_id!, attachmentId: IDS.command };
const fingerprint = "a".repeat(64);
function payload(s: unknown) {
	const p = roomPoll();
	return { ...p, ingress: { ...p.ingress, session_events: s } };
}
const pkg = (s: unknown) => parsePollPayload(payload(s), TEST_CONNECTION, options);

test("advertisement opts in independently; old room servers retain the old lane", () => {
	const c = { kind: "devspec.product.remote_ingress_contract", schema_version: 1, contract_version: "1.6.0", policy: { policy_version: "2026-09-24.1" }, activation: { room_context_negotiation_argument: "room_context_version", room_context_contract_requires: { ingress_version: 1, delegated_scope_version: 1, active_plan_projection_version: 1, system_notice_version: 1, sender_style_version: 1, room_context_version: 1 } } };
	const resource = (activation = {}) => ({ contents: [{ text: JSON.stringify({ ...c, activation: { ...c.activation, ...activation } }) }] });
	assert.equal(advertisesSessionEvents(resource()), false);
	assert.equal(advertisesSessionEvents(resource({ session_events_negotiation_argument: "session_events_version", session_events_revision_argument: "session_events_revision", session_events_requires: { room_context_version: 1, session_events_version: 1 } })), true);
	assert.equal(advertisesSessionEvents({ contents: [{ text: "bad" }] }), false);
});

test("all server variants retain exact times, actors and changes, ignoring additive fields", () => {
	const events = [produced, moved,
		{ ...produced, id: "reference", event: "referenced", message_id: IDS.command },
		{ ...produced, kind: "memory", id: "superseded", event: "superseded", by: IDS.command, actor: null },
		{ ...produced, kind: "memory", id: "retracted", event: "retracted", actor: { kind: "agent", label: "Pi · Agent" } },
		{ ...produced, kind: "artifact", id: "archived", event: "archived", actor: { kind: "platform", label: "DevSpec" } }];
	const parsed = parseSessionEvents({ ...section(), extra: "future", events: events.map(e => ({ ...e, extra: "future" })) });
	assert.equal(parsed.events.length, 6);
	assert.deepEqual(parsed.events.slice(0, 2), [produced, moved]);
	assert.equal("actor" in parsed.events[1]!, false, "never invent a lifecycle actor");
	assert.equal(parsed.events[3]!.at, at, "do not round timestamp precision");
	assert(!JSON.stringify(parsed).includes("future"));
});

test("unknown or malformed advisory events never suppress an authorized command", () => {
	for (const s of [section({ events: [produced, produced] }), { ...section(), version: 2 }, section({ status: "unchanged" }), section({ status: "unavailable" }), { ...section(), events: [{ ...moved, kind: "memory" }] }, { ...section(), events: [{ ...produced, event: "future_kind" }] }]) {
		const parsed = pkg(s);
		assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
		assert(parsed.ownerBundle);
		assert.equal(parsed.sessionEvents, null);
		assert(parsed.advisoryRejections?.includes("session_events"));
	}
	const unknown = parsePollPayload(payload(section()), TEST_CONNECTION, { ...options, sessionEventsNegotiated: false });
	assert.equal(unknown.canonicalState, "valid"); assert.equal(unknown.sessionEvents, undefined);
	const wrongIdentity = payload(section()); wrongIdentity.ingress.connection.connection_id = IDS.otherConnection;
	assert.equal(parsePollPayload(wrongIdentity, TEST_CONNECTION, options).canonicalState, "invalid");
});

test("events and revision commit atomically, survive restart, dedupe and retain old history", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-events-"));
	let crash = false;
	let store = await openRoomStore(scope, { root, principalFingerprint: fingerprint, crash: boundary => { if (crash && boundary === "before_commit") throw new Error("power loss"); } });
	try {
		assert.equal(store.eventsWatch().session_events_revision, null);
		crash = true; assert.throws(() => store.apply(pkg(section())), /power loss/);
		assert.equal(store.eventsWatch().session_events_revision, null);
		const failed = await readLocalRoom(scope, fingerprint, { view: "events" }, { root });
		assert.deepEqual((failed.value as any).events, []);
		crash = false; store.apply(pkg(section())); store.apply(pkg(section()));
		store.close(); store = await openRoomStore(scope, { root, principalFingerprint: fingerprint });
		assert.equal(store.eventsWatch().session_events_revision, revision);
		store.apply(pkg(section({ events: [{ ...produced, actor: null }], revision: `sha256:${"b".repeat(64)}`, truncated: true })));
		let read = await readLocalRoom(scope, fingerprint, { view: "events" }, { root });
		assert.deepEqual((read.value as any).events, [moved, produced], "a repeated id is never rewritten and missing events are never deleted");
		assert.equal((read.event_history as any).truncated, true);
		store.apply(pkg(section({ as_of: "2026-09-25T14:00:00Z", events: [{ ...produced, id: "late-old", at: "2026-09-24T01:00:00Z" }] })));
		assert.equal(store.eventsWatch().session_events_revision, `sha256:${"b".repeat(64)}`, "late recovery does not roll the revision back");
		store.apply(pkg(section({ status: "unavailable", as_of: "2026-09-25T18:00:00Z", revision: null, events: [] })));
		store.apply(pkg(section({ as_of: "2026-09-25T17:00:00Z", events: [] })));
		assert.equal(store.eventsWatch().session_events_revision, null, "older success cannot erase a newer failed read");
		store.apply(pkg(null));
		read = await readLocalRoom(scope, fingerprint, { view: "events" }, { root });
		assert.equal((read.value as any).events.length, 3);
		assert.equal((read.event_history as any).availability, "unavailable");
		assert.equal(store.eventsWatch().session_events_revision, null);
		store.apply(pkg(section({ status: "unchanged", events: [] })));
		assert.equal(store.eventsWatch().session_events_revision, null, "unchanged cannot acknowledge an unknown revision");
		assert.equal((await readLocalRoom(scope, "wrong", { view: "events" }, { root })).availability, "unavailable");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("event reader chunks losslessly, ignores observation-only changes, isolates attachment cursors", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-events-reader-"));
	const store = await openRoomStore(scope, { root, principalFingerprint: fingerprint });
	try {
		const events = Array.from({ length: 90 }, (_, n) => ({ ...produced, id: String(n).padStart(3, "0"), actor: { kind: "person" as const, label: "x".repeat(200) } }));
		store.apply(pkg(section({ events })));
		let read = await readLocalRoom(scope, fingerprint, { view: "events" }, { root });
		const cursor = String(read.next_cursor); let json = "";
		store.apply(pkg(section({ status: "unchanged", events: [], as_of: "2026-09-25T16:00:00Z" })));
		for (;;) {
			assert(JSON.stringify(read).length <= ROOM_READ_MAX_CHARS);
			json += (read.fragment as any).text;
			if (!read.next_cursor) break;
			read = await readLocalRoom(scope, fingerprint, { cursor: String(read.next_cursor) }, { root });
		}
		assert.deepEqual(JSON.parse(json).events, events);
		const other = await openRoomStore({ ...scope, attachmentId: IDS.otherConnection }, { root, principalFingerprint: fingerprint });
		try { assert.equal((await readLocalRoom(other.scope, fingerprint, { view: "events", cursor }, { root })).availability, "invalid_request"); } finally { other.close(); }
		store.apply(pkg(section({ events: [...events, { ...produced, id: "new" }] })));
		assert.equal((await readLocalRoom(scope, fingerprint, { cursor }, { root })).availability, "changed");
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("old v1 caches remain readable and acquire the event table without losing messages", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-events-upgrade-"));
	let store = await openRoomStore(scope, { root, principalFingerprint: fingerprint });
	try {
		store.apply(pkg(section())); const path = store.path; const count = store.status().records; store.close();
		const db = new DatabaseSync(path); db.exec("DROP TABLE session_events; DELETE FROM meta WHERE key='session_events_status'"); db.close();
		const old = await readLocalRoom(scope, fingerprint, { view: "events" }, { root });
		assert.equal((old.event_history as any).availability, "unavailable");
		store = await openRoomStore(scope, { root, principalFingerprint: fingerprint });
		assert.equal(store.status().records, count); store.apply(pkg(section()));
		assert.equal(((await readLocalRoom(scope, fingerprint, { view: "events" }, { root })).value as any).events.length, 2);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recovery negotiates and echoes only committed revisions; older servers get no arguments", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-events-sync-"));
	const store = await openRoomStore(scope, { root });
	let args: Record<string, unknown> | undefined;
	const sync = new RoomSync({ store, sessionEventsNegotiated: true, current: () => true, liveCursor: () => "live", wake: () => {}, onError: () => {}, fetchHistory: async a => { args = a; throw new Error("fixture"); } });
	try {
		assert.equal(sync.eventsWatch().session_events_version, 1);
		await sync.repairOnce(); assert.equal(args?.session_events_version, 1); assert.equal(args?.session_events_revision, null);
		store.apply(pkg(section())); assert.equal(sync.eventsWatch().session_events_revision, revision);
		const old = new RoomSync({ store, current: () => true, liveCursor: () => undefined, wake: () => {}, onError: () => {}, fetchHistory: async () => { throw new Error(); } });
		assert.deepEqual(old.eventsWatch(), {});
	} finally { sync.close(); rmSync(root, { recursive: true, force: true }); }
});
