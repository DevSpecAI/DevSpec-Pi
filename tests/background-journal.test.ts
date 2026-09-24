import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_WORK_ENTRY, backgroundScopeKey, backgroundWorkEntry, restoreBackgroundWork, type BackgroundWorkScope } from "../extensions/core/background-journal.ts";
import type { ObservedTaskState } from "../extensions/core/background-observer.ts";
const scope: BackgroundWorkScope = { nativeSessionId: "native-A", connectionId: "connection-A", sessionId: "room-A", attachmentId: "attachment-A" };
const row = (id: string, state: ObservedTaskState, startTime = 1, at = scope) => ({ type: "custom", customType: BACKGROUND_WORK_ENTRY, data: backgroundWorkEntry(at, { id, state, startTime }) });

test("only explicit unresolved identities restore; prior running becomes unknown", () => {
	const entries = [row("a", "running"), row("b", "unknown"), row("c", "running"), row("c", "completed")];
	assert.deepEqual(restoreBackgroundWork(entries, scope), [{ id: "a", startTime: 1, state: "unknown" }, { id: "b", startTime: 1, state: "unknown" }]);
	assert.deepEqual(restoreBackgroundWork([], scope), [], "no guessing from raw launch text or provider inventory");
});

test("native session, connection, room and attachment all fence restoration", () => {
	for (const field of Object.keys(scope) as (keyof BackgroundWorkScope)[]) {
		const other = { ...scope, [field]: "other" };
		assert.notEqual(backgroundScopeKey(other), backgroundScopeKey(scope));
		assert.deepEqual(restoreBackgroundWork([row("foreign", "running", 1, other)], scope), []);
	}
});

test("terminal observations are monotonic and a conflicting id cannot overwrite ownership", () => {
	assert.deepEqual(restoreBackgroundWork([row("a", "running"), row("a", "killed"), row("a", "running")], scope), []);
	assert.deepEqual(restoreBackgroundWork([row("a", "running"), row("a", "completed", 99)], scope), [{ id: "a", startTime: 1, state: "unknown" }]);
});

test("journal serialization strips extra fields and parsing refuses unknown shapes", () => {
	const entry = backgroundWorkEntry({ ...scope, secret: "SECRET" } as any, { id: "a", startTime: 1, state: "running", command: "SECRET" } as any);
	assert.equal(JSON.stringify(entry).includes("SECRET"), false);
	const valid = row("a", "running");
	for (const bad of [
		{ ...valid, type: "custom_message" },
		{ ...valid, data: { ...valid.data, version: 2 } },
		{ ...valid, data: { ...valid.data, command: "untrusted" } },
		{ ...valid, data: { ...valid.data, task: { ...valid.data.task, state: "missing" } } },
		{ ...valid, data: { ...valid.data, scope: { ...scope, nativeSessionId: "" } } },
	]) assert.deepEqual(restoreBackgroundWork([bad], scope), []);
});
