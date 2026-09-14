import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PUSH_SAFETY_MS } from "../extensions/devspec-remote.ts";
import { WakeGenerationGate } from "../extensions/core/push-channel.ts";

// Item 7b649070: Pi presence cadence vs the shared display window.
//
// The 90s display freshness (REMOTE_AGENT_LIVE_MS) lives in DevSpecV2
// (packages/core/src/sessions/remote-control.ts) and CANNOT be imported here —
// this repo ships standalone. The value below is a deliberate cross-repo pin:
// if the server window ever changes, this test fails loudly instead of
// letting the headroom arithmetic drift silently (which is exactly how the
// old ≤60s comments lied).
const DISPLAY_FRESHNESS_MS = 90_000;

test("push safety cadence is 45s — half the display window", () => {
	assert.equal(PUSH_SAFETY_MS, 45_000);
});

test("one fully missed safety lap plus poll latency still stamps before the window", () => {
	// The design rule, not numerology: safety ≤ half the freshness window, so
	// a live agent survives a missed lap and still looks live. The old 75s
	// left 15s of nominal headroom — less than one slow auth round trip.
	assert.ok(
		PUSH_SAFETY_MS * 2 <= DISPLAY_FRESHNESS_MS,
		`PUSH_SAFETY_MS (${PUSH_SAFETY_MS}) must be at most half the ${DISPLAY_FRESHNESS_MS}ms display window`,
	);
	assert.equal(DISPLAY_FRESHNESS_MS - PUSH_SAFETY_MS, 45_000);
});

test("transport modes use distinct intervals: push waits on the gate, fallback holds the poll", () => {
	const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
	// Push mode: SSE wakes us; the lap itself is a no-hold fetch.
	assert.match(remote, /wait_ms: pushMode \? 0 : POLL_WAIT_MS/);
	// Fallback: held long-poll at its own ~25s cadence — untouched by this item.
	assert.match(remote, /const POLL_WAIT_MS = 25_000;/);
	// The pump's push-mode wait is bounded by the exported safety cadence…
	assert.match(remote, /await waitForWake\(active, PUSH_SAFETY_MS\)/);
	// …and no stale local 75s shadow remains.
	assert.doesNotMatch(remote, /const PUSH_SAFETY_MS = 75_000/);
});

test("safety timeout bounds the quiet interval when nothing wakes us", async () => {
	const gate = new WakeGenerationGate();
	const start = Date.now();
	await gate.wait(50);
	const elapsed = Date.now() - start;
	assert.ok(elapsed >= 40, `safety fired too early (${elapsed}ms)`);
	assert.ok(elapsed < 500, `safety fired too late (${elapsed}ms)`);
	gate.cancel();
});

test("a wake during the safety wait shortens the gap instead of waiting it out", async () => {
	// Models an SSE wake / explicit heartbeat landing mid-interval: observed
	// presence gaps are usually far shorter than the safety cadence.
	const gate = new WakeGenerationGate();
	const start = Date.now();
	setTimeout(() => gate.signal(), 20);
	await gate.wait(5_000);
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 1_000, `wake did not shorten the wait (${elapsed}ms)`);
	assert.equal(gate.hasPending(), false);
	gate.cancel();
});

test("a wake that lands just before the wait resolves immediately", async () => {
	const gate = new WakeGenerationGate();
	gate.signal();
	const start = Date.now();
	await gate.wait(5_000);
	assert.ok(Date.now() - start < 500, "pending wake was not consumed immediately");
	assert.equal(gate.hasPending(), false);
	gate.cancel();
});
