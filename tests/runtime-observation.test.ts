import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RuntimeObservationFrames, type ForegroundSample } from "../extensions/core/runtime-observation.ts";

const INSTANCE = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT = "22222222-2222-4222-8222-222222222222";
const EXECUTION = "33333333-3333-4333-8333-333333333333";
const active = (sample_sequence = 1): ForegroundSample => ({ state: "active", sample_sequence, execution_id: EXECUTION, revision: 1, kind: "owner" });
function ready() {
	const frames = new RuntimeObservationFrames(INSTANCE, ATTACHMENT);
	frames.observeForeground(active());
	frames.observeBackground({ state: "active", sample_sequence: 1 });
	return frames;
}

test("no missing sample is silently turned into idle", () => {
	const frames = new RuntimeObservationFrames(INSTANCE, ATTACHMENT);
	assert.equal(frames.frame(), null);
	frames.observeForeground({ state: "idle", sample_sequence: 1 });
	assert.equal(frames.frame(), null);
	frames.observeBackground({ state: "unknown", sample_sequence: 1 });
	assert.equal(frames.frame()?.background.state, "unknown");
});

test("publication/retry reads reuse the same immutable frame and sample evidence", () => {
	const frames = ready();
	const first = frames.frame()!;
	for (let i = 0; i < 10; i++) assert.equal(frames.frame(), first);
	assert.equal(first.sequence, 1);
	assert.equal(Object.isFrozen(first), true);
	assert.equal(Object.isFrozen(first.foreground), true);
	assert.equal(Object.isFrozen(first.background), true);
	assert.throws(() => { first.background.sample_sequence = 99; }, TypeError);
});

test("a new foreground sample does not mint fresh background evidence", () => {
	const frames = ready();
	const first = frames.frame()!;
	frames.observeForeground({ state: "idle", sample_sequence: 2 });
	const second = frames.frame()!;
	assert.equal(second.sequence, 2);
	assert.equal(second.foreground.sample_sequence, 2);
	assert.deepEqual(second.background, first.background);
	assert.equal(frames.observeForeground({ state: "idle", sample_sequence: 2 }), false);
	assert.equal(frames.frame(), second);
});

test("older foreground/background observations cannot close newer work", () => {
	const frames = ready(); frames.frame();
	frames.observeForeground(active(3));
	frames.observeBackground({ state: "active", sample_sequence: 3 });
	const current = frames.frame();
	assert.equal(frames.observeForeground({ state: "idle", sample_sequence: 2 }), false);
	assert.equal(frames.observeBackground({ state: "idle", sample_sequence: 2 }), false);
	assert.equal(frames.frame(), current);
});

test("reusing a sample sequence with changed contents fails rather than relabelling it", () => {
	const frames = ready();
	const current = frames.frame();
	assert.throws(() => frames.observeForeground({ state: "idle", sample_sequence: 1 }), /reused/);
	assert.throws(() => frames.observeBackground({ state: "idle", sample_sequence: 1 }), /reused/);
	assert.equal(frames.frame(), current);
});

test("projection copies only permitted scalar metadata", () => {
	const frames = new RuntimeObservationFrames(INSTANCE, ATTACHMENT);
	const sample = { state: "active" as const, sample_sequence: 1, execution_id: EXECUTION, revision: 1, kind: "owner" as const, command: "SECRET", token: "SECRET" };
	frames.observeForeground(sample);
	frames.observeBackground({ state: "idle", sample_sequence: 1, tasks: ["SECRET"] } as any);
	sample.execution_id = "caller changed its object";
	assert.equal(JSON.stringify(frames.frame()).includes("SECRET"), false);
	const foreground = frames.frame()?.foreground;
	assert.equal(foreground?.state === "active" && foreground.execution_id, EXECUTION);
});

test("disposal prevents late updates/publication after an attachment or instance change", () => {
	const frames = ready(); frames.frame(); frames.dispose();
	assert.equal(frames.observeForeground(active(2)), false);
	assert.equal(frames.observeBackground({ state: "idle", sample_sequence: 2 }), false);
	assert.equal(frames.frame(), null);
	assert.throws(() => new RuntimeObservationFrames("not-an-instance", ATTACHMENT));
});

const serverRoot = process.env.DEVSPEC_V2_ROOT;
test("actual paired server accepts frames and does not refresh a cached background sample", { skip: !serverRoot }, async () => {
	// Explicit root only: never search sibling checkouts for a convenient copy.
	const server = await import(pathToFileURL(resolve(serverRoot!, "packages/core/src/connections/runtime-observation.ts")).href);
	const frames = ready();
	const first = server.parseRuntimeObservation(frames.frame());
	assert.equal(first.ok, true);
	const accepted = server.acceptRuntimeObservation({ expectedInstanceId: INSTANCE, expectedAttachmentId: ATTACHMENT, current: null, incoming: first.value, now: 100, freshnessMs: 50 });
	assert.equal(accepted.outcome, "accepted");
	frames.observeForeground({ state: "idle", sample_sequence: 2 });
	const next = server.parseRuntimeObservation(frames.frame());
	assert.equal(next.ok, true);
	const refreshed = server.acceptRuntimeObservation({ expectedInstanceId: INSTANCE, expectedAttachmentId: ATTACHMENT, current: accepted.record, incoming: next.value, now: 151, freshnessMs: 50 });
	assert.equal(refreshed.outcome, "accepted");
	assert.equal(refreshed.record.backgroundExpiresAt, 150);
	assert.deepEqual(server.runtimeActivityView(refreshed.record, 152), { phase: "unknown", foreground: "available", background: "unknown", workingSince: null });
});
