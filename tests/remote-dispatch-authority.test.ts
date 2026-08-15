import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
	fileURLToPath(new URL("../extensions/devspec-remote.ts", import.meta.url)),
	"utf8",
);

function bodyBetween(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
	return source.slice(from, to);
}

test("remote stop revokes dispatch authority before clearing the pump", () => {
	const stopBody = bodyBetween("async function stopPump", "/** Wake the pump's SSE waiter");
	const invalidateAt = stopBody.indexOf("active.dispatchQueue.invalidate()");
	const clearAt = stopBody.indexOf("pump = null");
	assert.ok(invalidateAt >= 0, "stop must invalidate the dispatch queue");
	assert.ok(clearAt > invalidateAt, "queue authority must be revoked before the pump is cleared");
});

test("failed asynchronous delivery schedules a local retry after the dispatch cursor advances", () => {
	const retryBody = bodyBetween("function scheduleDispatchRetry", "function enqueueDispatch");
	assert.match(retryBody, /nextDeliveryRetryDelayMs\(failures\)/);
	assert.match(retryBody, /setTimeout\(\(\) => \{[\s\S]*enqueueDispatch\(active, token, dispatch, ctx\)/);
	assert.match(source, /\(error\) => scheduleDispatchRetry\(active, key, token, dispatch, ctx, error\)/);
});

test("real dispatch hydration checkpoints authority and commits mode/send without an await gap", () => {
	const deliveryBody = bodyBetween("async function deliverDispatch", "function enqueueDispatch");
	assert.match(deliveryBody, /await callDevspec[\s\S]*assertDeliveryAuthority\(active, lease\)/);
	assert.match(deliveryBody, /loadImplementationContext\(\{[\s\S]*assertCurrent: \(\) => assertDeliveryAuthority\(active, lease\)/);
	assert.match(deliveryBody, /assertDeliveryAuthority\(active, lease\);\s*const modeInstallation = installImplementationMode/);
	const commit = deliveryBody.match(/const modeInstallation = installImplementationMode[\s\S]*?pi_send\(message,[\s\S]*?\);/u)?.[0] ?? "";
	assert.ok(commit, "mode installation and Pi delivery transaction was not found");
	assert.doesNotMatch(commit, /\bawait\b/, "stop/rebond must not interleave between mode installation and Pi send");
});
