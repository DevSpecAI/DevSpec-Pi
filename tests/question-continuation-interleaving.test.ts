import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as interactions from "../extensions/core/interaction-events.ts";
import { BusyWakeLatch, RuntimeOccupancyFence } from "../extensions/core/push-channel.ts";
import { remoteRunActivityPolicy } from "../extensions/core/system-notice.ts";
import { decideInteractionDelivery, waitUntil } from "../extensions/core/preempt.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
function between(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from);
	return source.slice(from, to);
}

const event: interactions.InteractionEventV1 = {
	kind: "devspec.interaction_event", version: 1,
	event_id: "11111111-1111-4111-8111-111111111111",
	response_id: "22222222-2222-4222-8222-222222222222",
	question_id: "33333333-3333-4333-8333-333333333333",
	origin_connection_id: "44444444-4444-4444-8444-444444444444",
	source_session_id: "55555555-5555-4555-8555-555555555555",
	response_kind: "text", answer: "Continue with the safe option.",
	answered_at: "2026-09-17T22:24:04.676587Z",
	claim_token: "66666666-6666-4666-8666-666666666666",
	lease_expires_at: "2026-09-17T22:24:54.583Z",
};

/** Execute the production pump event branch and apply function, not a copied policy. */
function harness(providerState: "running" | "completed", startOutcome: "started" | "blocked_by_activity" = "started") {
	let hostIdle = false;
	let clock = 0;
	let aborts = 0;
	let starts = 0;
	const releases: string[] = [];
	let settleOnAbort = true;
	const pendingBackgroundTaskIds = new Set(["dependency-install"]);
	const provider = { state: providerState, notified: providerState === "completed", receiptPersisted: false };
	const journal = new interactions.InteractionEventJournal();
	const delivery = new interactions.InteractionEventDeliveryController(journal);
	const sent: interactions.InteractionEventApplicationDetails[] = [];
	const active = {
		busy: true, stop: false, generation: 1, errors: 0,
		bond: { connectionId: event.origin_connection_id, sessionId: event.source_session_id, connectionCapability: "capability" },
		runtimeOccupancy: new RuntimeOccupancyFence(),
		pendingInteractionStarts: new Map(),
	};
	const occupancy = active.runtimeOccupancy.begin("owner");
	const ctx = { isIdle: () => hostIdle, sessionManager: { getSessionId: () => "local-session" } };
	const details = (_active: unknown, _ctx: unknown, value: typeof event, attemptId?: string) => ({
		version: 1 as const, local_session_id: "local-session", connection_id: value.origin_connection_id,
		source_session_id: value.source_session_id, event: value, ...(attemptId ? { attempt_id: attemptId } : {}),
	});
	const settleHost = () => {
		hostIdle = true;
		active.runtimeOccupancy.finish(occupancy);
		active.busy = pendingBackgroundTaskIds.size > 0;
	};
	const scope = {
		...interactions, decideInteractionDelivery, ERROR_BACKOFF_MS: 5_000,
		active, pump: active, ctx, interactionEvent: event as interactions.DirectedQuestionEventV1, preemptOwnerCached: true,
		interactionJournal: journal, interactionDelivery: delivery,
		interactionRunsByEvent: new Map(), startingInteractionRun: null,
		interactionApplicationDetails: details,
		interactionAuthorityCurrent: (authority: interactions.InteractionEventDeliveryAuthority) =>
			authority.generation === active.generation && authority.sourceSessionId === active.bond.sessionId,
		pi_appendInteractionEntry: () => {},
		interactionDeliveryPort: () => ({ append: () => {}, send: (_text: string, value: interactions.InteractionEventApplicationDetails) => sent.push(value), wake: () => {} }),
		startInteractionContinuation: async () => {
			starts++;
			return startOutcome === "started" ? { outcome: "started", attemptId: "77777777-7777-4777-8777-777777777777", sourceSessionId: event.source_session_id } : { outcome: startOutcome };
		},
		retainInteractionStartRetry: (_active: unknown, value: typeof event) => active.pendingInteractionStarts.set(value.event_id, value),
		armInteractionRetryWake: () => {},
		releaseInteractionBeforePersistence: async (_run: unknown, reason: string) => { releases.push(reason); },
		pi_abort: () => {
			aborts++;
			// Host cancellation settles the foreground, not the provider job or its
			// queued followUp receipt. This is the 22:24:24.587Z interleaving.
			if (settleOnAbort) settleHost();
		},
		waitUntil: (check: () => boolean, options: { timeoutMs: number; intervalMs: number }) => waitUntil(check, { ...options, now: () => clock, sleep: async (ms) => { clock += ms; } }),
		debug: () => {},
		setTimeout: (callback: () => void) => { callback(); },
	};
	const lap = runInNewContext(stripTypeScriptTypes(`
		${between("function interactionForegroundReady", "async function drainInteractionRetries")}
		(async () => { do { ${between("if (interactionEvent) {", "// Titles are job-generated")} } while (false); })
	`), scope) as () => Promise<void>;
	return { lap, active, provider, pendingBackgroundTaskIds, journal, sent, delivery, releases,
		starts: () => starts, aborts: () => aborts, scope, settleHost,
		delaySettle: () => { settleOnAbort = false; },
	};
}

for (const state of ["running", "completed"] as const) {
	test(`foreground abort settles with ${state} provider task and unconsumed receipt: exact event reaches start`, async () => {
		const h = harness(state);
		await h.lap();
		assert.equal(h.aborts(), 1);
		assert.equal(h.starts(), 1, "presence busy must not block foreground-ready exact start");
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].event.claim_token, event.claim_token);
		assert.equal(h.journal.nextAck(event.origin_connection_id, event.source_session_id), null, "host send alone is not durable JSONL proof");
		assert.equal(h.active.busy, true, "background presence was not falsely cleared");
		assert.deepEqual([...h.pendingBackgroundTaskIds], ["dependency-install"]);
		assert.equal(h.provider.state, state, "delivery must not cancel or complete provider work");
		assert.equal(h.provider.receiptPersisted, false);
	});
}

test("exact server blocked_by_activity retains claim and never persists, ACKs, or re-aborts", async () => {
	const h = harness("running", "blocked_by_activity");
	await h.lap();
	await h.lap();
	assert.equal(h.aborts(), 1);
	assert.equal(h.starts(), 2, "foreground-ready retries must reach the exact server boundary");
	assert.equal(h.sent.length, 0);
	assert.equal(h.active.pendingInteractionStarts.get(event.event_id)?.claim_token, event.claim_token);
	assert.equal(h.journal.nextAck(event.origin_connection_id, event.source_session_id), null);
	assert.equal(h.active.busy, true);
});

test("preempt-off waits for foreground settle, then tries exact input despite background presence", async () => {
	const h = harness("running", "blocked_by_activity");
	h.scope.preemptOwnerCached = false;
	await h.lap();
	assert.equal(h.aborts(), 0);
	assert.equal(h.starts(), 0);
	h.settleHost();
	await h.lap();
	assert.equal(h.starts(), 1);
	assert.equal(h.sent.length, 0);
	assert.equal(h.active.busy, true);
});

test("abort timeout never injects into occupied foreground or spends a second abort", async () => {
	const h = harness("completed");
	h.delaySettle();
	await h.lap();
	await h.lap();
	assert.equal(h.aborts(), 1);
	assert.equal(h.starts(), 0);
	h.settleHost();
	await h.lap();
	assert.equal(h.starts(), 1);
	assert.equal(h.sent.length, 1);
});

for (const change of ["owner-start", "reattach", "runtime-generation"] as const) {
	test(`exact start await crossing ${change} releases before persistence`, async () => {
		const h = harness("running");
		const start = h.scope.startInteractionContinuation;
		h.scope.startInteractionContinuation = async () => {
			const result = await start();
			if (change === "owner-start") h.active.runtimeOccupancy.begin("owner");
			if (change === "reattach") h.active.bond.sessionId = "other-room";
			if (change === "runtime-generation") h.active.generation++;
			return result;
		};
		await h.lap();
		assert.equal(h.starts(), 1);
		assert.deepEqual(h.releases, ["interaction_authority_changed_before_persistence"]);
		assert.equal(h.sent.length, 0);
		assert.equal(h.journal.nextAck(event.origin_connection_id), null);
		assert.equal(h.active.busy, true);
	});
}

test("successful exact start still requires durable custom-message proof before ACK eligibility", async () => {
	const h = harness("completed");
	await h.lap();
	const details = h.sent[0];
	assert.ok(details);
	const message = {
		role: "custom", customType: interactions.INTERACTION_EVENT_CUSTOM_TYPE,
		content: interactions.formatInteractionEventContinuation(details.event), details,
	};
	const confirm = (persistedEntries: interactions.SessionEntryLike[]) => h.delivery.confirmPersistedMessage({
		message, persistedEntries, isAuthorityCurrent: h.scope.interactionAuthorityCurrent,
		port: h.scope.interactionDeliveryPort(),
	});
	assert.equal(confirm([]), "pending", "message_end without disk append cannot ACK");
	assert.equal(h.journal.nextAck(event.origin_connection_id), null);
	assert.equal(confirm([{ type: "custom_message", customType: message.customType, content: message.content, details }]), "confirmed");
	assert.equal(h.journal.nextAck(event.origin_connection_id)?.claim_token, event.claim_token);
	assert.equal(h.provider.receiptPersisted, false, "question persistence does not consume provider receipt");
});

test("dismissal shares foreground readiness without gaining owner-command identity", async () => {
	const h = harness("running");
	h.scope.interactionEvent = {
		kind: "devspec.question_dismissal_event", version: 1,
		event_id: event.event_id, question_id: event.question_id,
		origin_connection_id: event.origin_connection_id, source_session_id: event.source_session_id,
		response_kind: "text", prompt: "Choose an option", dismissed_by_user_id: event.question_id,
		dismissed_at: event.answered_at, claim_token: event.claim_token, lease_expires_at: event.lease_expires_at,
	};
	await h.lap();
	assert.equal(h.aborts(), 1);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0].event.kind, "devspec.question_dismissal_event");
	const run = h.scope.interactionRunsByEvent.get(event.event_id);
	assert.equal(run.identity.questionId, event.question_id);
	assert.equal(run.identity.responseId, undefined);
	assert.equal(run.commandTurnId, undefined);
	assert.equal(h.journal.nextAck(event.origin_connection_id), null);
});

for (const newerOwner of [false, true]) {
	test(`agent_settled preserves background presence and ${newerOwner ? "does not clear newer occupancy" : "replays foreground-ready wake"}`, async () => {
		let settle!: (_event: object, ctx: object) => Promise<void>;
		const occupancy = new RuntimeOccupancyFence();
		occupancy.begin("owner");
		const wake = new BusyWakeLatch();
		wake.noteWake(true);
		const pump = { busy: true, runtimeOccupancy: occupancy, idleBoundaryWake: wake };
		const presence: boolean[] = [];
		const completions: unknown[] = [];
		const posts: Promise<void>[] = [];
		let wakes = 0;
		const scope = {
			pi: { on: (_name: string, handler: typeof settle) => { settle = handler; } },
			lastCtx: null, pump, turn: { revision: 1, tracker: { userKind: "harness" } },
			pendingInteractionConfirmations: new Set(), pendingBackgroundTaskIds: new Set(["dependency-install"]),
			remoteRunActivityPolicy, isCommandTurnUnbound: () => false, settleTelemetry: () => null,
			beatBusy: async (busy: boolean) => { presence.push(busy); },
			signalWake: () => { wakes++; }, untitledAttached: () => false,
			trackTerminalPost: (post: Promise<void>) => { posts.push(post); }, settleTurn: async () => false,
			reportComplete: async (...args: unknown[]) => { completions.push(args); },
			systemNoticeRunActive: false,
		};
		runInNewContext(stripTypeScriptTypes(`
			${between("function interactionForegroundReady", "/**\n * Foreground-idle")}
			${between('pi.on("agent_settled"', "// ---- Turn lifecycle events")}
		`), scope);
		const settling = settle({}, { isIdle: () => !newerOwner });
		if (newerOwner) occupancy.begin("owner"); // crosses the handler's awaited persistence lap
		await settling;
		await Promise.all(posts);
		assert.equal(pump.busy, true);
		assert.equal(occupancy.isBusy(), newerOwner);
		assert.equal(wakes, newerOwner ? 0 : 1);
		assert.deepEqual(presence, newerOwner ? [] : [true]);
		assert.deepEqual(completions, [], "settle must not falsely complete owned background work");
		assert.equal(scope.pendingBackgroundTaskIds.has("dependency-install"), true);
	});
}

test("server-blocked redelivery retains the fresh claim without re-aborting or acknowledging", async () => {
	const h = harness("running", "blocked_by_activity");
	await h.lap();
	const claim = "99999999-9999-4999-8999-999999999999";
	h.scope.interactionEvent = { ...event, claim_token: claim };
	await h.lap();
	assert.equal(h.aborts(), 1);
	assert.equal(h.starts(), 2);
	assert.equal(h.active.pendingInteractionStarts.get(event.event_id)?.claim_token, claim);
	assert.equal(h.journal.eventFor(event.event_id)?.claim_token, claim);
	assert.equal(h.sent.length, 0);
	assert.equal(h.journal.nextAck(event.origin_connection_id), null);
});
