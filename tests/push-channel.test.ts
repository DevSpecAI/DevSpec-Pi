import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BusyWakeLatch,
	nextPushReconnectDelayMs,
	openPushChannel,
	parseSseFrame,
	PushChannelGenerationFence,
	RuntimeOccupancyFence,
	WakeGenerationGate,
	pushChannelUrl,
	PUSH_HEALTHY_MS,
	PUSH_RECONNECT_BACKOFF_MS,
} from "../extensions/core/push-channel.ts";

test("main SSE URL advertises additive capabilities only when dynamically requested", () => {
	assert.equal(
		pushChannelUrl({
			mcpUrl: "https://devspec.test/api/mcp",
			connectionId: "id with spaces",
			systemNoticeVersion: 1,
			interactionEventVersion: 1,
		}),
		"https://devspec.test/api/mcp/connection-stream?connection_id=id+with+spaces&system_notice_version=1&interaction_event_version=1",
	);
	assert.equal(
		pushChannelUrl({ mcpUrl: "https://devspec.test/api/mcp/", connectionId: "plain" }),
		"https://devspec.test/api/mcp/connection-stream?connection_id=plain",
	);
});

test("interaction-aware SSE carries the hidden exact-connection capability header", async () => {
	const originalFetch = globalThis.fetch;
	let captured: RequestInit | undefined;
	globalThis.fetch = (async (_input, init) => {
		captured = init;
		return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	try {
		await openPushChannel({
			mcpUrl: "https://devspec.test/api/mcp",
			token: "token",
			connectionId: "connection",
			connectionCapability: "capability",
			interactionEventVersion: 1,
			handlers: { onWake() {}, onEnded() {}, onClose() {} },
			signal: new AbortController().signal,
		});
		const headers = new Headers(captured?.headers);
		assert.equal(headers.get("x-devspec-connection-capability"), "capability");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

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

test("wake gate consumes the resolving signal and preserves exactly one newer burst fetch", async () => {
	const gate = new WakeGenerationGate();
	const first = gate.wait(1_000);
	gate.signal(); // resolves the existing waiter and consumes this generation
	gate.signal();
	gate.signal(); // synchronous burst coalesces as one newer pending generation
	await first;
	assert.equal(gate.hasPending(), true);
	await gate.wait(1_000);
	assert.equal(gate.hasPending(), false);
	// A genuinely newer wake after the fetch remains pending.
	gate.signal();
	assert.equal(gate.hasPending(), true);
	await gate.wait(1_000);
	assert.equal(gate.hasPending(), false);
	gate.cancel();
});

test("busy wake is replayed exactly once at the next idle boundary", () => {
	const latch = new BusyWakeLatch();
	latch.noteWake(true);
	latch.noteWake(true);
	assert.equal(latch.consumeAtIdle(false), false, "a busy boundary cannot consume the nudge");
	assert.equal(latch.consumeAtIdle(true), true, "settle receives an immediate coalesced nudge");
	assert.equal(latch.consumeAtIdle(true), false, "the nudge is one-shot");
	latch.noteWake(false);
	assert.equal(latch.consumeAtIdle(true), false, "idle wakes need no later replay");
});

test("multiple low-level starts preserve one notice run until its single settle", () => {
	const occupancy = new RuntimeOccupancyFence();
	const latch = new BusyWakeLatch();
	const notice = occupancy.begin("system_notice");
	const retry = occupancy.begin("owner"); // pending flag may already be cleared
	assert.equal(retry.kind, "system_notice", "retry/compaction start cannot reclassify the run");
	assert.ok(retry.revision > notice.revision, "every low-level start fences older settle");
	latch.noteWake(occupancy.isBusy());
	assert.equal(latch.consumeAtIdle(false), false);
	assert.equal(occupancy.finish(notice), false, "old settle captured before retry cannot finish");
	assert.equal(occupancy.finish(retry), true);
	assert.equal(occupancy.isBusy(), false);
	assert.equal(latch.consumeAtIdle(true), true, "single settle immediately replays one wake");
	assert.equal(latch.consumeAtIdle(true), false);
});

test("a genuine owner follow-up promotes an active notice run and still settles normally", () => {
	const occupancy = new RuntimeOccupancyFence();
	const notice = occupancy.begin("system_notice");
	const owner = occupancy.promote(notice, "owner");
	assert.equal(owner?.kind, "owner");
	assert.ok((owner?.revision ?? 0) > notice.revision, "promotion also fences older settle");
	assert.equal(occupancy.capture()?.kind, "owner");
	assert.equal(occupancy.finish(owner), true);
	assert.equal(occupancy.isBusy(), false);
});

test("foreground identity survives retry and input promotion but rotates after real settlement", () => {
	let generated = 0;
	const occupancy = new RuntimeOccupancyFence(() => `execution-${++generated}`);
	const first = occupancy.begin("interaction");
	const retry = occupancy.begin("owner");
	assert.equal(retry.executionId, first.executionId);
	assert.equal(retry.kind, "interaction");
	const promoted = occupancy.promote(retry, "owner");
	assert.ok(promoted);
	assert.equal(promoted.executionId, first.executionId, "changing causal input is not another native execution");
	assert.equal(occupancy.finish(first), false);
	assert.equal(occupancy.finish(retry), false);
	assert.equal(occupancy.finish(promoted), true);
	const next = occupancy.begin("owner");
	assert.notEqual(next.executionId, first.executionId);
	assert.equal(generated, 2);
});

test("an execution identity cannot be substituted even with matching kind and revision", () => {
	const occupancy = new RuntimeOccupancyFence();
	const current = occupancy.begin("owner");
	assert.match(current.executionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.equal(occupancy.finish({ ...current, executionId: "different-execution" }), false);
	assert.equal(occupancy.isBusy(), true);
	const copy = occupancy.capture()!;
	copy.executionId = "caller-mutated-copy";
	assert.equal(occupancy.capture()?.executionId, current.executionId);
	assert.equal(occupancy.finish(current), true);
});

test("dynamic SSE restart fences an already-scheduled reconnect from opening a second stream", () => {
	const fence = new PushChannelGenerationFence();
	const first = fence.begin();
	let opens = 1;
	let reconnectTimer: (() => void) | undefined = () => {
		if (fence.isCurrent(first)) opens += 1;
	};

	// Production cancels the timer and invalidates its generation before open.
	reconnectTimer = undefined;
	fence.invalidate();
	const replacement = fence.begin();
	opens += 1;
	assert.equal(fence.isCurrent(first), false);
	assert.equal(fence.isCurrent(replacement), true);
	reconnectTimer?.();
	assert.equal(opens, 2, "only the original and its one replacement opened");

	// Even if cancellation loses a race and the stale callback runs, fencing wins.
	const staleCallback = () => { if (fence.isCurrent(first)) opens += 1; };
	staleCallback();
	assert.equal(opens, 2);
});
