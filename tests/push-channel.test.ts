import assert from "node:assert/strict";
import { test } from "node:test";
import {
	nextPushReconnectDelayMs,
	parseSseFrame,
	PUSH_HEALTHY_MS,
	PUSH_RECONNECT_BACKOFF_MS,
} from "../extensions/core/push-channel.ts";

test("parseSseFrame parses event + data", () => {
	assert.deepEqual(parseSseFrame('event: wake\ndata: {"at":"x"}'), { event: "wake", data: '{"at":"x"}' });
});

test("parseSseFrame defaults event to message", () => {
	assert.deepEqual(parseSseFrame('data: {"a":1}'), { event: "message", data: '{"a":1}' });
});

test("parseSseFrame ignores comments/keepalives", () => {
	assert.equal(parseSseFrame(":ka 123"), null);
});

test("parseSseFrame joins multi-line data", () => {
	assert.deepEqual(parseSseFrame("event: x\ndata: one\ndata: two"), { event: "x", data: "one\ntwo" });
});

test("parseSseFrame returns null for frames without data", () => {
	assert.equal(parseSseFrame("event: wake"), null);
});

test("nextPushReconnectDelayMs walks the backoff schedule then settles to fallback", () => {
	const openedAt = 1_000;
	const now = openedAt + 500; // short-lived stream (500ms < healthy)
	assert.equal(nextPushReconnectDelayMs(0, openedAt, now), PUSH_RECONNECT_BACKOFF_MS[0]);
	assert.equal(nextPushReconnectDelayMs(1, openedAt, now), PUSH_RECONNECT_BACKOFF_MS[1]);
	assert.equal(nextPushReconnectDelayMs(2, openedAt, now), PUSH_RECONNECT_BACKOFF_MS[2]);
	assert.equal(nextPushReconnectDelayMs(3, openedAt, now), null); // exhausted → long-poll
	assert.equal(nextPushReconnectDelayMs(10, openedAt, now), null);
});

test("nextPushReconnectDelayMs restarts backoff when the dropped stream was healthy", () => {
	const openedAt = 1_000;
	const now = openedAt + PUSH_HEALTHY_MS + 1;
	// Even after prior short-lived failures, a healthy-then-dropped stream retries fast.
	assert.equal(nextPushReconnectDelayMs(2, openedAt, now), PUSH_RECONNECT_BACKOFF_MS[0]);
	// Exactly at the healthy boundary still counts as short-lived.
	assert.equal(
		nextPushReconnectDelayMs(2, openedAt, openedAt + PUSH_HEALTHY_MS),
		PUSH_RECONNECT_BACKOFF_MS[2],
	);
});

test("nextPushReconnectDelayMs without an open timestamp trusts the attempt count", () => {
	assert.equal(nextPushReconnectDelayMs(0, undefined, 5_000), PUSH_RECONNECT_BACKOFF_MS[0]);
	assert.equal(nextPushReconnectDelayMs(3, undefined, 5_000), null);
});
