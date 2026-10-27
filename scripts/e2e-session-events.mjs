/** Opt-in staging read qualification. No model calls or record mutations.
 * node scripts/e2e-session-events.mjs --session <room-uuid> [--claude-room <room.json>]
 * Optional --claude-module <room-transcript.mjs> compares both actual store implementations,
 * using disposable stores fed the same live payload (not a second live Claude host).
 * Uses a disposable connection; never borrows a working agent's capability/cursor.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveToken, resolveEndpoint } from "../extensions/core/auth-store.ts";
import { callDevspec, readDevspecResource } from "../extensions/core/client.ts";
import { unwrapMcpResult } from "../extensions/core/result.ts";
import { connectionCapabilityFromResult } from "../extensions/core/bond-state.ts";
import { advertisesSessionEvents } from "../extensions/core/session-events.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { openRoomStore, roomPrincipalFingerprint } from "../extensions/core/room-store.ts";
import { readLocalRoom } from "../extensions/core/room-reader.ts";
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const session = process.argv.includes("--session") ? arg("--session") : null;
assert(session && /^[a-f0-9-]{36}$/.test(session), "Pass an explicit room UUID");
const endpoint = await resolveEndpoint();
assert(new URL(endpoint).hostname === "api.devspecstaging.com", "This qualification is staging-only");
const auth = await resolveToken(); assert(auth, "Log in first");
const cwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "pi-live-events-"));
const nativeSessionId = `event-qualification-${randomUUID()}`;
let connectionId, capability, store;
const call = async (name, args) => callDevspec(auth.token, name, args, { cwd, ...(capability ? { connectionCapability: capability } : {}) });
try {
	assert(advertisesSessionEvents(await readDevspecResource(auth.token, "devspec://product/remote-ingress-contract")));
	const raw = await call("register_connection", { local_id: nativeSessionId, agent_name: "Pi", cwd, connection_capability_version: 1 });
	const registered = unwrapMcpResult(raw).details;
	connectionId = registered.connection_id; capability = connectionCapabilityFromResult(raw);
	assert(connectionId && capability, "Disposable registration failed");
	await call("attach_connection", { connection_id: connectionId, session_id: session });
	const args = { connection_id: connectionId, ingress_version: 1, delegated_scope_version: 1, active_plan_projection_version: 1, system_notice_version: 2, sender_style_version: 1, room_context_version: 1, session_events_version: 1, wait_ms: 0 };
	const response = unwrapMcpResult(await call("poll_connection", args)).details;
	const identity = response.ingress?.connection; assert(identity, "No initial history envelope");
	const options = { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true, sessionEventsNegotiated: true };
	const parsed = parsePollPayload(response, identity, options);
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	assert.equal(parsed.ownerBundle, undefined, "History must not authorize execution");
	assert.equal(parsed.sessionEvents?.status, "available");
	const scope = { endpoint, projectId: registered.project_id, nativeSessionId, connectionId, sessionId: session, attachmentId: response.speech_attachment_id };
	const fingerprint = roomPrincipalFingerprint(auth.token);
	store = await openRoomStore(scope, { root, principalFingerprint: fingerprint });
	store.apply(parsed); store.apply(parsed); store.close();
	store = await openRoomStore(scope, { root, principalFingerprint: fingerprint });
	let read = await readLocalRoom(scope, fingerprint, { view: "events" }, { root });
	let value = read.value;
	if (!value) {
		let json = "";
		for (;;) {
			assert(read.fragment, "Reader continuation failed"); json += read.fragment.text;
			if (!read.next_cursor) break;
			read = await readLocalRoom(scope, fingerprint, { cursor: read.next_cursor }, { root });
		}
		value = JSON.parse(json);
	}
	const byId = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
	assert.deepEqual(byId(value.events), byId(response.ingress.session_events.events));
	const echoed = unwrapMcpResult(await call("poll_connection", { ...args, ...store.eventsWatch(), cursor_v2: response.cursor_v2, catch_up: true })).details;
	const echoPkg = parsePollPayload(echoed, identity, options);
	assert.equal(echoPkg.canonicalState, "valid", echoPkg.canonicalError);
	assert.equal(echoPkg.sessionEvents?.status, "unchanged", "Room changed during qualification; rerun against a settled revision");
	assert.deepEqual(echoPkg.sessionEvents.events, []);
	store.apply(echoPkg, "repair");
	let parity = null;
	if (process.argv.includes("--claude-room")) {
		const claude = JSON.parse(readFileSync(arg("--claude-room"), "utf8"));
		assert.equal(claude.session_id, session, "Claude copy belongs to a different room");
		const history = claude.session_activity?.events;
		assert(Array.isArray(history), "Claude copy has no event history");
		const pi = new Map(value.events.map(e => [e.id, e]));
		for (const event of history) assert.deepEqual(pi.get(event.id), event, `Shared event differs: ${event.id}`);
		parity = { exactSharedEvents: history.length, piEvents: value.events.length, identicalInventory: history.length === value.events.length };
	}
	if (process.argv.includes("--claude-module")) {
		const claude = await import(pathToFileURL(resolve(arg("--claude-module"))).href);
		const copy = claude.createTranscriptStore(randomUUID(), session);
		claude.observeSessionActivity(copy, response.ingress.session_activity);
		claude.observeSessionEvents(copy, response.ingress.session_events);
		claude.observeSessionEvents(copy, response.ingress.session_events);
		const dir = join(root, "claude");
		assert(claude.persistTranscriptStore(copy, { dir }));
		const restored = claude.loadTranscriptStore(copy.connectionId, session, { dir });
		const history = claude.sessionActivityView(restored)?.events;
		assert(Array.isArray(history), "Claude implementation did not preserve history");
		assert.deepEqual(byId(history), byId(value.events));
		parity = { mode: "actual plugin stores, same live payload, not a second Claude host", exactEvents: history.length, restarted: true };
	}
	console.log(JSON.stringify({ result: "PASS", source: "deployed staging", events: value.events.length, lifecycleEvents: value.events.filter(e => e.event === "lifecycle_changed").length, exactServerEquality: true, duplicateDelivery: "deduplicated", restart: "preserved", revisionEcho: "unchanged", nativeReaderFunction: true, claudeParity: parity, modelCalls: 0 }));
} finally {
	store?.close(); rmSync(root, { recursive: true, force: true });
	if (connectionId) await call("heartbeat_connection", { connection_id: connectionId, status: "offline", end_reason: "local_stop" });
}
process.exit(0);
