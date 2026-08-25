import assert from "node:assert/strict";
import { test } from "node:test";
import {
	capturePumpAuthority,
	isPumpAuthorityCurrent,
	planRecoveredConnectionScope,
} from "../extensions/core/bond-recovery.ts";

test("same-row revival preserves every exactly-once clock and generation", () => {
	const planned = planRecoveredConnectionScope({
		currentConnectionId: "connection-1",
		nextConnectionId: "connection-1",
		generation: 7,
		nextGeneration: 8,
		cursor: "conversation-cursor",
		dispatchCursor: "dispatch-cursor",
		systemNoticeCursor: "notice-cursor",
		synced: true,
		agentName: "Pi",
		codename: "Mighty Bobcat",
	});
	assert.equal(planned.changedConnection, false);
	assert.equal(planned.generation, 7);
	assert.equal(planned.cursor, "conversation-cursor");
	assert.equal(planned.dispatchCursor, "dispatch-cursor");
	assert.equal(planned.systemNoticeCursor, "notice-cursor");
	assert.equal(planned.synced, true);
	assert.equal(planned.connectionIdentity.connection_id, "connection-1");
});

test("different-row revival rotates authority and clears connection-scoped clocks", () => {
	const planned = planRecoveredConnectionScope({
		currentConnectionId: "connection-old",
		nextConnectionId: "connection-new",
		generation: 7,
		nextGeneration: 8,
		cursor: "conversation-cursor",
		dispatchCursor: "dispatch-cursor",
		systemNoticeCursor: "notice-cursor",
		synced: true,
		agentName: "Pi",
		codename: "Mighty Bobcat",
	});
	assert.equal(planned.changedConnection, true);
	assert.equal(planned.generation, 8);
	assert.equal(planned.cursor, undefined);
	assert.equal(planned.dispatchCursor, undefined);
	assert.equal(planned.systemNoticeCursor, undefined);
	assert.equal(planned.synced, false);
	assert.deepEqual(planned.connectionIdentity, {
		connection_id: "connection-new",
		agent_name: "Pi",
		codename: "Mighty Bobcat",
		label: "Pi · Mighty Bobcat",
	});
});

test("an awaited old-connection writer becomes stale after different-row revival", () => {
	const captured = capturePumpAuthority({ generation: 7, connectionId: "connection-old" });
	assert.equal(isPumpAuthorityCurrent(captured, { generation: 7, connectionId: "connection-old" }), true);
	assert.equal(isPumpAuthorityCurrent(captured, { generation: 8, connectionId: "connection-new" }), false);
	assert.equal(isPumpAuthorityCurrent(captured, { generation: 8, connectionId: "connection-old" }), false);
});
