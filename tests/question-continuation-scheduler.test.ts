import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as interactions from "../extensions/core/interaction-events.ts";
import { BusyWakeLatch, RuntimeOccupancyFence, type WakeGenerationGate } from "../extensions/core/push-channel.ts";
import { decideInteractionDelivery, waitUntil } from "../extensions/core/preempt.ts";
import { executeControlCommand, parseControlCommand } from "../extensions/core/control.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const pushSource = readFileSync(new URL("../extensions/core/push-channel.ts", import.meta.url), "utf8");
function between(text: string, start: string, end: string): string {
	const from = text.indexOf(start);
	const to = text.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `missing ${start}..${end}`);
	return text.slice(from, to);
}
const remote = (start: string, end: string) => between(source, start, end);
const event: interactions.InteractionEventV1 = {
	kind: "devspec.interaction_event", version: 1,
	event_id: "11111111-1111-4111-8111-111111111111",
	response_id: "22222222-2222-4222-8222-222222222222",
	question_id: "33333333-3333-4333-8333-333333333333",
	origin_connection_id: "44444444-4444-4444-8444-444444444444",
	source_session_id: "55555555-5555-4555-8555-555555555555",
	response_kind: "text", answer: "Continue safely.", answered_at: "2026-09-17T22:24:04.676587Z",
	claim_token: "66666666-6666-4666-8666-666666666666", lease_expires_at: "2026-09-17T22:24:54.583Z",
};

type Retry = { event: interactions.DirectedQuestionEventV1; attempts: number; nextAt: number };
function schedulerHarness() {
	let now = 0;
	let nextTimer = 1;
	const timers = new Map<number, { at: number; callback: () => void }>();
	const setTimeout = (callback: () => void, delay: number) => {
		const id = nextTimer++;
		timers.set(id, { at: now + delay, callback });
		return id;
	};
	const clearTimeout = (id: number) => { timers.delete(id); };
	const journal = new interactions.InteractionEventJournal();
	const starts: Array<{ at: number; claim: string }> = [];
	const polls: Array<{ at: number; args: Record<string, unknown> }> = [];
	const controls: string[] = [];
	const controlAcks: string[] = [];
	let aborts = 0;
	let sends = 0;
	let startAllowed = false;
	let idle = false;
	const active = {
		generation: 1, busy: true, stop: false, errors: 0, synced: true,
		bond: { connectionId: event.origin_connection_id, connectionCapability: "capability", sessionId: event.source_session_id },
		runtimeOccupancy: new RuntimeOccupancyFence(), idleBoundaryWake: new BusyWakeLatch(),
		pendingInteractionStarts: new Map<string, Retry>(), pendingInteractionReleases: new Map(),
		wakeGate: null as WakeGenerationGate | null,
	};
	const occupancy = active.runtimeOccupancy.begin("owner");
	const ctx = { isIdle: () => idle, sessionManager: { getSessionId: () => "local-session" } };
	const emptyPayload = () => ({ session_id: event.source_session_id, interaction_event_version: 1, interaction_events: [] });
	const queuedPayloads: object[] = [{ ...emptyPayload(), interaction_events: [event] }];
	const scope = {
		...interactions, decideInteractionDelivery, waitUntil, executeControlCommand, parseControlCommand,
		Date: { now: () => now }, setTimeout, clearTimeout,
		pump: active, lastCtx: ctx, preemptOwnerCached: true,
		PUSH_SAFETY_MS: 45_000, POLL_WAIT_MS: 25_000, POLL_TIMEOUT_MS: 45_000,
		ERROR_BACKOFF_MS: 5_000, MAX_CONSECUTIVE_ERRORS: 10, AGENT_NAME: "Pi",
		interactionJournal: journal, interactionDelivery: new interactions.InteractionEventDeliveryController(journal),
		interactionRunsByEvent: new Map(), startingInteractionRun: null,
		interactionAuthorityCurrent: () => true,
		interactionDeliveryPort: () => ({ append: () => {}, send: () => { sends++; }, wake: () => {} }),
		pi_appendInteractionEntry: () => {},
		startInteractionContinuation: async (_active: unknown, value: interactions.DirectedQuestionEventV1) => {
			starts.push({ at: now, claim: value.claim_token });
			return startAllowed
				? { outcome: "started", attemptId: "77777777-7777-4777-8777-777777777777", sourceSessionId: event.source_session_id }
				: { outcome: "blocked_by_activity" };
		},
		releaseInteractionBeforePersistence: async () => { throw new Error("unexpected release"); },
		resolveToken: async () => ({ token: "token" }), resolveEndpoint: async () => "https://example.test",
		startPushChannel: () => {}, ensurePushInteractionNegotiation: () => {},
		callDevspec: async (_token: string, name: string, args: Record<string, unknown>) => {
			assert.equal(name, "poll_connection");
			polls.push({ at: now, args });
			return { details: queuedPayloads.shift() ?? emptyPayload() };
		},
		unwrapMcpResult: (value: unknown) => value,
		hasSystemNoticeBatchCapacity: () => false, runtimeAgentStats: () => ({}),
		isRealSessionTitle: () => true,
		parsePollPayload: (payload: { control?: unknown }) => ({ canonicalState: "valid", systemNotices: [], control: payload.control }),
		pi_abort: () => { aborts++; idle = true; active.runtimeOccupancy.finish(occupancy); },
		pi_setThinking: (level: string) => { controls.push(level); return level; },
		ackControl: async (_token: string, _connection: string, id: string) => { controlAcks.push(id); },
		scheduleRuntimeStamp: () => {}, debug: () => {}, notify: () => {},
	};
	// Full production pumpLoop, retry drain/retention/backoff/timer and wake gate.
	// Only transport, provider/host and unrelated payload projection are controlled.
	const api = runInNewContext(stripTypeScriptTypes(`
		${between(pushSource, "export class WakeGenerationGate", "/** Coalesces wake markers").replace("export class", "class")}
		${remote("const INTERACTION_RETRY_MS", "/** Cached so")}
		${remote("function signalWake", "/** Server attachment authority changed;")}
		${remote("function interactionApplicationDetails", "function readPersistedSessionEntries")}
		${remote("function interactionForegroundReady", "async function acknowledgeInteractionApplication")}
		${remote("function waitForWake", "/**\n * The stream dropped")}
		${remote("async function pumpLoop", "interface BondOutcome")}
		pump.wakeGate = new WakeGenerationGate();
		({ run: pumpLoop, wake: () => signalWake(pump) });
	`), scope);
	let failure: unknown;
	const running = api.run(ctx).catch((error: unknown) => { failure = error; });
	const flush = async () => {
		for (let i = 0; i < 100; i++) await Promise.resolve();
		if (failure) throw failure;
	};
	const advance = async (ms: number) => {
		now += ms;
		for (const [id, timer] of [...timers]) {
			if (timer.at > now) continue;
			timers.delete(id);
			timer.callback();
		}
		await flush();
	};
	return {
		active, journal, starts, polls, controls, controlAcks,
		aborts: () => aborts, sends: () => sends, advance, flush,
		allowStart: () => { startAllowed = true; },
		wake: async (payload?: object) => { if (payload) queuedPayloads.push(payload); api.wake(); await flush(); },
		control: () => ({ ...emptyPayload(), control: { id: "owner-control", verb: "set_thinking", issuedAt: "now", issuedByUserId: "owner", args: { thinking: "low" } } }),
		eventPayload: (claim: string) => ({ ...emptyPayload(), interaction_events: [{ ...event, claim_token: claim }] }),
		close: async () => { active.stop = true; active.wakeGate?.cancel(); for (const timer of timers.values()) timer.callback(); timers.clear(); await running; },
	};
}

function assertQuestionPending(h: ReturnType<typeof schedulerHarness>) {
	assert.equal(h.aborts(), 1);
	assert.equal(h.sends(), 0);
	assert.equal(h.journal.nextAck(event.origin_connection_id), null);
	assert.equal(h.active.busy, true);
	for (const { args } of h.polls) {
		assert.equal(args.interaction_event_ack, undefined);
		assert.equal(args.question_dismissal_event_ack, undefined);
	}
}

test("repeated blocked retries still poll and process an owner control wake before the next retry deadline", async () => {
	const h = schedulerHarness();
	try {
		await h.wake(); // answer aborts foreground; real apply retains retry
		assert.equal(h.starts.length, 1);
		for (let i = 0; i < 3; i++) {
			const deadline = h.active.pendingInteractionStarts.get(event.event_id)!.nextAt;
			await h.advance(deadline - h.starts.at(-1)!.at);
			assert.equal(h.starts.length, i + 2);
			assert.equal(h.polls.length, i + 2, "an attempted blocked start cannot consume the poll lap");
		}
		await h.advance(1);
		const beforeWake = h.starts.length;
		await h.wake(h.control());
		assert.deepEqual(h.controls, ["low"]);
		assert.deepEqual(h.controlAcks, ["owner-control"]);
		assert.equal(h.starts.length, beforeWake, "control wake must not accelerate future retry");
		assertQuestionPending(h);
	} finally { await h.close(); }
});

test("incoming control wake is not held behind the first future interaction retry", async () => {
	const h = schedulerHarness();
	try {
		await h.wake();
		await h.advance(100); // retry remains due at 500
		await h.wake(h.control());
		assert.deepEqual(h.controls, ["low"], "control must run at t=100, not at retry deadline");
		assert.equal(h.polls.at(-1)!.at, 100);
		assert.equal(h.starts.length, 1);
		assertQuestionPending(h);
	} finally { await h.close(); }
});

test("wake bursts and refreshed claims cannot bypass capped exact-start backoff", async () => {
	const h = schedulerHarness();
	try {
		await h.wake();
		let now = 0;
		for (const delay of [500, 2_000, 5_000, 10_000, 10_000]) {
			const retry = h.active.pendingInteractionStarts.get(event.event_id)!;
			assert.equal(retry.nextAt - now, delay);
			const before = h.starts.length;
			// Even a newly polled claim must respect the retained event's backoff.
			const freshClaim = `${String(before).repeat(8)}-9999-4999-8999-999999999999`;
			for (let i = 0; i < 3; i++) await h.wake(h.eventPayload(freshClaim));
			assert.equal(h.starts.length, before);
			assert.equal(h.active.pendingInteractionStarts.get(event.event_id)!.nextAt, retry.nextAt);
			assert.equal(h.active.pendingInteractionStarts.get(event.event_id)!.event.claim_token, freshClaim);
			await h.advance(delay);
			now += delay;
			assert.equal(h.starts.length, before + 1);
			assert.equal(h.starts.at(-1)!.claim, freshClaim);
			assert.equal(h.polls.at(-1)!.at, now, "due retry still shares its lap with ordinary poll");
		}
		assertQuestionPending(h);
	} finally { await h.close(); }
});

test("successful due retry keeps following polls activity-neutral and deduplicates pending persistence", async () => {
	const h = schedulerHarness();
	try {
		await h.wake(); // first exact start is blocked and retained
		assert.equal(h.starts.length, 1);
		h.allowStart();
		await h.advance(500); // due retry now starts, but host persistence remains pending
		assert.equal(h.starts.length, 2);
		assert.equal(h.sends(), 1);
		assert.equal(h.polls.length, 2, "successful retry also continues ordinary polling");
		assert.equal(h.active.pendingInteractionStarts.size, 0);
		assert.equal(Object.hasOwn(h.polls[0].args, "busy"), true, "generic presence was permitted before exact start");
		for (let i = 0; i < 3; i++) await h.wake(h.eventPayload(event.claim_token));
		for (const { args } of h.polls.slice(1)) {
			assert.equal(Object.hasOwn(args, "busy"), false, "production activeInteractionRun suppresses generic activity mutation");
			assert.equal(args.interaction_event_ack, undefined, "no ACK before durable host persistence");
			assert.equal(args.question_dismissal_event_ack, undefined);
		}
		assert.equal(h.sends(), 1, "same exact event remains one staged custom message despite redelivery");
		assert.equal(h.aborts(), 1, "retry/redelivery cannot spend another abort");
		assert.equal(h.journal.isApplied(event.event_id), false);
		assert.equal(h.journal.nextAck(event.origin_connection_id), null);
		assert.equal(h.active.busy, true, "exact start did not clear background presence");
	} finally { await h.close(); }
});
