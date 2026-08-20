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

test("remote stop revokes playbook authority before clearing the pump", () => {
	const stopBody = bodyBetween("async function stopPump", "/** Wake the pump's SSE waiter");
	const invalidateAt = stopBody.indexOf("active.playbookQueue.invalidate()");
	const clearAt = stopBody.indexOf("pump = null");
	assert.ok(invalidateAt >= 0, "stop must invalidate the playbook queue");
	assert.ok(clearAt > invalidateAt, "queue authority must be revoked before the pump is cleared");
});

test("non-playbook transport entries are inert before queueing or injection", () => {
	const enqueue = bodyBetween("function enqueuePlaybookRun", "async function pumpLoop");
	const rejectAt = enqueue.indexOf("if (!isPlaybookRunEnvelope(value)) return");
	const keyAt = enqueue.indexOf("const key = playbookRunId(value)");
	const queueAt = enqueue.indexOf("active.playbookQueue.enqueue");
	assert.ok(rejectAt >= 0 && rejectAt < keyAt && keyAt < queueAt);
	assert.doesNotMatch(enqueue.slice(0, queueAt), /pi_send|sendUserMessage|noteWork|recordActiveDelivery/);

	const delivery = bodyBetween("async function deliverPlaybookRun", "async function loadCurrentPlaybookInbox");
	assert.match(delivery, /if \(!isPlaybookRunEnvelope\(value\)\) return/);
	assert.match(delivery, /formatPlaybookRunMessage/);
	assert.doesNotMatch(delivery, /implementation|assignment|noteWork|recordActiveDelivery/);
});

test("retry re-reads the exact server-owned playbook inbox target", () => {
	const inbox = bodyBetween("async function loadCurrentPlaybookInbox", "function schedulePlaybookRetry");
	assert.match(inbox, /"get_connection_dispatch"/);
	assert.match(inbox, /connection_id: active\.bond\.connectionId, dispatch_id: key/);
	assert.match(inbox, /identityComplete: payload\.identity_complete === true && payload\.dispatch_id === key/);
	assert.doesNotMatch(inbox, /poll_connection/, "retry validation must not disturb the transport cursor");
});

test("failed playbook delivery retries only current exact server authority", () => {
	const retry = bodyBetween("function schedulePlaybookRetry", "function enqueuePlaybookRun");
	assert.match(retry, /revalidatePlaybookRunRetry\(\{/);
	assert.match(retry, /loadCurrentInbox: \(\) => loadCurrentPlaybookInbox\(active, key, token, ctx\)/);
	assert.match(retry, /identity: playbookRunId/);
	assert.match(retry, /withdrawCurrent: \(\) => active\.playbookQueue\.invalidateKey\(key\)/);
	assert.match(retry, /enqueueCurrent: \(currentRun\) => enqueuePlaybookRun\(active, token, currentRun, ctx\)/);
	assert.doesNotMatch(retry, /enqueuePlaybookRun\(active, token, value, ctx\)/, "captured envelopes are not retry authority");
});
