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

test("remote stop revokes automation authority before clearing the pump", () => {
	const stopBody = bodyBetween("async function stopPump", "/** Wake the pump's SSE waiter");
	const invalidateAt = stopBody.indexOf("active.automationQueue.invalidate()");
	const clearAt = stopBody.indexOf("pump = null");
	assert.ok(invalidateAt >= 0, "stop must invalidate the automation queue");
	assert.ok(clearAt > invalidateAt, "queue authority must be revoked before the pump is cleared");
});

test("transport entries that are neither an automation run nor a check job are inert before queueing or injection", () => {
	const enqueue = bodyBetween("function enqueueDispatch", "async function pumpLoop");
	const rejectAt = enqueue.indexOf("if (!isDispatchEnvelope(value)) return");
	const keyAt = enqueue.indexOf("const key = dispatchId(value)");
	const queueAt = enqueue.indexOf("active.automationQueue.enqueue");
	assert.ok(rejectAt >= 0 && rejectAt < keyAt && keyAt < queueAt);
	assert.doesNotMatch(enqueue.slice(0, queueAt), /pi_send|sendUserMessage|noteWork|recordActiveDelivery/);

	const delivery = bodyBetween("async function deliverAutomationRun", "async function deliverCheckJob");
	assert.match(delivery, /if \(!isAutomationRunEnvelope\(value\)\) return/);
	assert.match(delivery, /formatAutomationRunMessage/);
	assert.doesNotMatch(delivery, /implementation|assignment|noteWork|recordActiveDelivery/);

	// A check job (55d71b0c) wakes the agent and nothing else: no work, no automation state.
	const checkJob = bodyBetween("async function deliverCheckJob", "async function loadCurrentAutomationInbox");
	assert.match(checkJob, /if \(!isCheckJobEnvelope\(value\)\) return/);
	assert.match(checkJob, /formatCheckJobMessage/);
	assert.doesNotMatch(checkJob, /implementation|assignment|noteWork|noteAutomation|recordActiveDelivery/);
});

test("every dispatches[] batch is routed item by item through the one validator (55d71b0c)", () => {
	// A bad item stays inert on its own, exactly as before check jobs: the rest of
	// the batch is still delivered. Both poll sites go through enqueueDispatch.
	const loops = source.match(/for \(const dispatch of dispatches\) (\w+)\(active, token, dispatch, ctx\);/g) ?? [];
	assert.equal(loops.length, 2);
	for (const loop of loops) assert.match(loop, /enqueueDispatch/);
	assert.doesNotMatch(source, /enqueueAutomationRun/);
});

test("retry re-reads the exact server-owned automation inbox target", () => {
	const inbox = bodyBetween("async function loadCurrentAutomationInbox", "function scheduleAutomationRetry");
	assert.match(inbox, /"get_connection_dispatch"/);
	assert.match(inbox, /connection_id: active\.bond\.connectionId, dispatch_id: key/);
	assert.match(inbox, /identityComplete: payload\.identity_complete === true && payload\.dispatch_id === key/);
	assert.doesNotMatch(inbox, /poll_connection/, "retry validation must not disturb the transport cursor");
});

test("failed automation delivery retries only current exact server authority", () => {
	const retry = bodyBetween("function scheduleAutomationRetry", "function enqueueDispatch");
	assert.match(retry, /revalidateAutomationRunRetry\(\{/);
	assert.match(retry, /loadCurrentInbox: \(\) => loadCurrentAutomationInbox\(active, key, token, ctx\)/);
	assert.match(retry, /identity: dispatchId/);
	assert.match(retry, /withdrawCurrent: \(\) => active\.automationQueue\.invalidateKey\(key\)/);
	assert.match(retry, /enqueueCurrent: \(currentRun\) => enqueueDispatch\(active, token, currentRun, ctx\)/);
	assert.doesNotMatch(retry, /enqueueDispatch\(active, token, value, ctx\)/, "captured envelopes are not retry authority");
});
