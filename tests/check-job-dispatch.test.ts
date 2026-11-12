/**
 * Check jobs on the wake channel (DevSpec item 55d71b0c, Pi item d28fb9f1;
 * version 2: 1d89fe56): the validator union, the wake line, how the wake
 * classifies as a turn, and the negotiation every poll and the stream carry.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import {
	CHECK_JOB_VERSION,
	automationRunId,
	describeCheckJob,
	dispatchId,
	formatAutomationRunMessage,
	formatCheckJobMessage,
	isAutomationRunEnvelope,
	isCheckJobEnvelope,
	isDispatchEnvelope,
	shouldDeliverQueuedCheckJob,
} from "../extensions/core/dispatch.ts";
import { DeliveryQueue, StaleDeliveryError, nextDeliveryRetryDelayMs } from "../extensions/core/delivery-queue.ts";
import { revalidateAutomationRunRetry } from "../extensions/core/automation-run-retry.ts";
import { capturePumpAuthority, isPumpAuthorityCurrent } from "../extensions/core/bond-recovery.ts";
import { unwrapMcpResult } from "../extensions/core/result.ts";
import { CHECK_JOB_PREFIX, classifyUserKind, isHarnessOrigin, TurnTracker } from "../extensions/core/turn-lifecycle.ts";
import { buildBondedInstructions } from "../extensions/devspec-context.ts";
import { setBond } from "../extensions/core/bond-state.ts";

const automation = {
	id: "run-1",
	kind: "automation_run",
	run_id: "run-1",
	automation_id: "automation-1",
	automation_name: "Deploy recovery",
	trigger_kind: "scheduled",
	owner: { user_id: "owner-1", display_name: "Ali Price" },
	permission: "can_commit",
	queued_at: "2026-08-20T12:00:00.000Z",
	delivery_connection_id: "conn-1",
	requester: null,
};

const JOB_ID = "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11";
const checkJob = {
	id: JOB_ID,
	kind: "check_job",
	check_job_id: JOB_ID,
	check_kind: "conflict_decisions",
	record: { type: "task", id: "9b2d6c1e-1111-4222-8333-444455556666", title: "Ship the export button" },
	entries: 3,
	yours: true,
	offered_at: "2026-11-04T02:00:00.000Z",
	delivery_connection_id: "conn-1",
};

test("an automation run is still accepted exactly as before", () => {
	assert.equal(isAutomationRunEnvelope(automation), true);
	assert.equal(isDispatchEnvelope(automation), true);
	assert.equal(isCheckJobEnvelope(automation), false);
	assert.equal(dispatchId(automation), "run-1");
	assert.equal(automationRunId(automation), "run-1");
	assert.equal(isDispatchEnvelope({ ...automation, instruction: "old payload" }), false);
});

test("a check job in its exact shape is accepted and keyed by its id", () => {
	assert.equal(isCheckJobEnvelope(checkJob), true);
	assert.equal(isDispatchEnvelope(checkJob), true);
	assert.equal(isAutomationRunEnvelope(checkJob), false);
	assert.equal(dispatchId(checkJob), JOB_ID);
	assert.equal(automationRunId(checkJob), undefined, "a check job is never an automation run");
	for (const check_kind of ["conflict", "conflict_decisions", "duplicate", "staleness"]) {
		assert.equal(isCheckJobEnvelope({ ...checkJob, check_kind }), true, check_kind);
	}
	for (const type of ["task", "memory", "artifact", "proposal"]) {
		assert.equal(isCheckJobEnvelope({ ...checkJob, record: { ...checkJob.record, type } }), true, type);
	}
	// A record with no stored title still arrives (the server sends "").
	assert.equal(isCheckJobEnvelope({ ...checkJob, record: { ...checkJob.record, title: "" } }), true);
	assert.equal(isCheckJobEnvelope({ ...checkJob, entries: 0, yours: false }), true);
});

test("version 2's three records arrive as out-of-date checks, and only as those", () => {
	for (const type of ["discussion_point", "goal", "backlog_scan"]) {
		const job = { ...checkJob, check_kind: "staleness", record: { ...checkJob.record, type } };
		assert.equal(isCheckJobEnvelope(job), true, type);
		assert.equal(dispatchId(job), JOB_ID, type);
		// The served contract: each is a staleness check ruled with the out-of-date verdicts.
		for (const check_kind of ["conflict", "conflict_decisions", "duplicate"]) {
			assert.equal(isCheckJobEnvelope({ ...job, check_kind }), false, `${type} as ${check_kind}`);
		}
	}
});

test("a version-1 envelope is refused: version 2 never sends high_risk", () => {
	assert.equal(isCheckJobEnvelope({ ...checkJob, high_risk: 1 }), false);
	assert.equal(isCheckJobEnvelope({ ...checkJob, high_risk: 0 }), false);
	assert.equal(isDispatchEnvelope({ ...checkJob, high_risk: 0 }), false);
	assert.equal(dispatchId({ ...checkJob, high_risk: 0 }), undefined);
});

test("unknown shapes and near-miss check jobs are rejected", () => {
	const { yours: _dropped, ...missingKey } = checkJob;
	const rejected: Array<[string, unknown]> = [
		["legacy assignment", { id: "legacy-envelope", kind: "assignment", members: [{ task_id: "item-1" }] }],
		["null", null],
		["array", [checkJob]],
		["extra key", { ...checkJob, body: "record text" }],
		["missing key", missingKey],
		["id differs from check_job_id", { ...checkJob, check_job_id: "another-job" }],
		["blank id", { ...checkJob, id: " ", check_job_id: " " }],
		["wrong kind", { ...checkJob, kind: "automation_run" }],
		["unknown check kind", { ...checkJob, check_kind: "spelling" }],
		["record extra key", { ...checkJob, record: { ...checkJob.record, text: "the whole record" } }],
		["record missing title", { ...checkJob, record: { type: "task", id: checkJob.record.id } }],
		["unknown record type", { ...checkJob, check_kind: "staleness", record: { ...checkJob.record, type: "outcome" } }],
		["a Goal as a conflict check", { ...checkJob, record: { ...checkJob.record, type: "goal" } }],
		["record id blank", { ...checkJob, record: { ...checkJob.record, id: "" } }],
		["fractional entries", { ...checkJob, entries: 1.5 }],
		["negative entries", { ...checkJob, entries: -1 }],
		["entries as text", { ...checkJob, entries: "3" }],
		["yours as text", { ...checkJob, yours: "true" }],
		["blank offered_at", { ...checkJob, offered_at: "" }],
		["no delivery connection", { ...checkJob, delivery_connection_id: null }],
	];
	for (const [label, value] of rejected) {
		assert.equal(isDispatchEnvelope(value), false, label);
		assert.equal(dispatchId(value), undefined, label);
	}
});

test("a batch with one bad item keeps the bad item inert and the rest deliverable, as before", () => {
	const batch = [automation, { ...checkJob, extra: true }, checkJob, { kind: "assignment", id: "x" }];
	assert.deepEqual(batch.filter(isDispatchEnvelope).map(dispatchId), ["run-1", JOB_ID]);
});

test("the wake is the contract's one line plus the envelope that carries the job id", () => {
	const message = formatCheckJobMessage(checkJob, "Wary Wolf");
	const lines = message.split("\n");
	assert.equal(lines[0], `${CHECK_JOB_PREFIX} to Wary Wolf]`);
	assert.equal(lines[1], "A check is waiting on Ship the export button: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.");
	assert.match(message, /Check job envelope:/);
	assert.ok(message.includes(`"check_job_id": "${JOB_ID}"`));
	assert.doesNotMatch(message, /automation run|claim_automation_run|work dispatch|been dispatched/i);
	// No stored title: name the record by its type and id instead.
	const untitled = formatCheckJobMessage({ ...checkJob, record: { ...checkJob.record, title: "  " } }, "Wary Wolf");
	assert.match(untitled.split("\n")[1]!, /^A check is waiting on task 9b2d6c1e-1111-4222-8333-444455556666: take it with claim_check_job/);
	assert.throws(() => formatCheckJobMessage({ ...checkJob, kind: "check" }, "Wary Wolf"), /check job envelope required/);
	assert.throws(() => formatCheckJobMessage(automation, "Wary Wolf"), /check job envelope required/);
});

test("the wake line says what a version-2 record is", () => {
	const job = (type: string, title: string) => ({ ...checkJob, check_kind: "staleness", record: { type, id: "5c1d2e3f-1111-4222-8333-444455556666", title } });
	assert.equal(describeCheckJob(job("discussion_point", "Who rules checks")), "An out-of-date check is waiting on the settled discussion point “Who rules checks”");
	assert.equal(describeCheckJob(job("goal", "Launch to customers")), "An out-of-date check is waiting on the Goal “Launch to customers”");
	assert.equal(describeCheckJob(job("backlog_scan", "Out-of-date scan, 7 Nov")), "The whole-backlog out-of-date scan “Out-of-date scan, 7 Nov” is waiting");
	// No stored title: the point and the Goal fall back to their id; the scan to its kind.
	assert.equal(describeCheckJob(job("discussion_point", "")), "An out-of-date check is waiting on the settled discussion point 5c1d2e3f-1111-4222-8333-444455556666");
	assert.equal(describeCheckJob(job("goal", " ")), "An out-of-date check is waiting on the Goal 5c1d2e3f-1111-4222-8333-444455556666");
	assert.equal(describeCheckJob(job("backlog_scan", "")), "The whole-backlog out-of-date scan is waiting");
	const lines = formatCheckJobMessage(job("goal", "Launch to customers"), "Wary Wolf").split("\n");
	assert.equal(lines[1], "An out-of-date check is waiting on the Goal “Launch to customers”: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.");
	// Earlier records read exactly as before.
	assert.equal(describeCheckJob(checkJob), "A check is waiting on Ship the export button");
	assert.doesNotMatch(formatCheckJobMessage(checkJob, "Wary Wolf"), /high.risk/i);
});

test("a check-job wake is DevSpec's input: never harness, never the person's typed prompt, never mirrored", () => {
	const message = formatCheckJobMessage(checkJob, "Wary Wolf");
	assert.equal(classifyUserKind(message), "check_job");
	assert.equal(isHarnessOrigin(message), false);
	const tracker = new TurnTracker();
	tracker.userMessage(message);
	assert.equal(tracker.userKind, "check_job");
	assert.equal(tracker.shouldMirrorPrompt, false);
	// Like an automation run, it starts its own segment after a harness wake.
	const afterHarness = new TurnTracker();
	afterHarness.userMessage("[bg completed] Isolated lint (abc123)");
	assert.equal(afterHarness.userKind, "harness");
	afterHarness.userMessage(message);
	assert.equal(afterHarness.userKind, "check_job");
});

const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");

test("every poll that reads or records the inbox says it reads check jobs, version 2", () => {
	assert.equal(CHECK_JOB_VERSION, 2);
	const calls = [...remote.matchAll(/callDevspec\(\s*[\w.]+,\s*"poll_connection",/g)];
	assert.equal(calls.length, 4, "main pump, room history, interaction ACK and control ACK");
	let controlAcks = 0;
	for (const call of calls) {
		// The argument object opens right after the tool name; each one is short of
		// 2,500 characters before the transport options begin.
		const args = remote.slice(call.index!, call.index! + 2_500);
		const end = args.search(/\}, \{ timeoutMs|\},\n\t*\{ timeoutMs/);
		assert.ok(end > 0, `could not isolate poll arguments at ${call.index}`);
		const body = args.slice(0, end);
		if (/control_ack_only: true/.test(body)) {
			// DevSpec answers an ACK-only poll before any negotiation: it neither
			// needs nor clears the version, and stays non-consuming.
			controlAcks += 1;
			assert.doesNotMatch(body, /check_job_version/);
			continue;
		}
		// Any other poll without it would clear it on the connection.
		assert.match(body, /check_job_version: CHECK_JOB_VERSION/, `poll at ${call.index} omits check_job_version`);
	}
	assert.equal(controlAcks, 1);
});

test("the connection stream is opened with the check-job version too", () => {
	const open = remote.slice(remote.indexOf("void openPushChannel({"), remote.indexOf("handlers: {", remote.indexOf("void openPushChannel({")));
	assert.match(open, /checkJobVersion: CHECK_JOB_VERSION/);
});

test("a check-job segment is nobody's request and gets no sessionless automation trail", () => {
	const branch = remote.slice(remote.indexOf('} else if (userKind === "check_job") {'), remote.indexOf('} else if (userKind !== "local") {'));
	assert.match(branch, /kind = "none";/);
	assert.match(branch, /chain\?\.arriveNobody\(\);/);
	assert.match(remote, /if \(!turn && segmentKind === "automation"\) ensureTurn\(\);/);
});

test("bonded instructions say to resolve a duplicate of a task the agent wrote on the spot, pointing at the served contract for how", () => {
	setBond({ connectionId: "11111111-1111-4111-8111-111111111111", codename: "Amber Hawk" });
	try {
		const lines = buildBondedInstructions()!.split("\n").filter((line) => line.includes("duplicates an existing one"));
		assert.equal(lines.length, 1, "one line, in the bonded block");
		const line = lines[0]!;
		assert.match(line, /resolve it then and there instead of leaving it as a flag, as the served contract's core\.resolve-duplicates-on-the-spot says/);
		assert.match(line, /whether the room hears about it is semantics\.notice_audience\.$/);
		// a868f41f: whose task it is, when to ask first and who is told are the served
		// contract's to say; a restatement here contradicted it the moment it changed.
		assert.doesNotMatch(line, /requester's own|may change|someone else's|tell them|owner's OK/);
		// Decision e9556b5c: no wording scripts.
		assert.doesNotMatch(line, /\bcite\b|citation|say to|word(?:ing)? it/i);
	} finally {
		setBond(null);
	}
});

test("bonded instructions point at the served contract for what stays out of the room, never restating it (a868f41f)", () => {
	setBond({ connectionId: "11111111-1111-4111-8111-111111111111", codename: "Amber Hawk" });
	try {
		const lines = buildBondedInstructions()!.split("\n").filter((line) => line.includes("delivered to the DevSpec session mechanically"));
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /A run woken by a check job, or only by notices DevSpec labels for the record, posts nothing there \(the served contract's check_job\.room and semantics\.notice_audience\) unless one of its writes comes back carrying tell_person\./);
		// Nothing asks an agent to post about ruling a check, or to report what happened after one.
		assert.doesNotMatch(buildBondedInstructions()!, /post what happened|post (?:about|a summary of) (?:the )?(?:check|ruling)/i);
	} finally {
		setBond(null);
	}
});

test("bonded instructions say how to take and rule a check job, behaviour only", () => {
	setBond({ connectionId: "11111111-1111-4111-8111-111111111111", codename: "Amber Hawk" });
	try {
		const lines = buildBondedInstructions()!.split("\n").filter((line) => line.includes("claim_check_job"));
		assert.equal(lines.length, 1, "one line, in the bonded block");
		const line = lines[0]!;
		assert.match(line, /^DevSpec sends every check on a change — your own changes included — as a check job on your wake channel/);
		assert.match(line, /Take it with claim_check_job, rule every entry with record_check_rulings using the definition it carries \(read any linked supporting document or uploaded file in full with get_resource first\), then carry on with what you were doing or act on what it found\. If you cannot rule it, hand it back\.$/);
		// Decision e9556b5c: no wording scripts, no citation requirement.
		assert.doesNotMatch(line, /\bcite\b|citation|tell (?:the|your) person|say to|word(?:ing)? it/i);
	} finally {
		setBond(null);
	}
});

test("shouldDeliverQueuedCheckJob skips settled check jobs and fails open on pending or transient errors", async () => {
	assert.equal(
		await shouldDeliverQueuedCheckJob({
			key: JOB_ID,
			loadCurrentInbox: async () => ({ dispatches: [], identityComplete: true }),
			identity: dispatchId,
		}),
		false,
		"empty dispatches array confirms the queued check job is already settled",
	);

	assert.equal(
		await shouldDeliverQueuedCheckJob({
			key: JOB_ID,
			loadCurrentInbox: async () => ({ dispatches: [automation], identityComplete: true }),
			identity: dispatchId,
		}),
		false,
		"exact-id lookup returning only another dispatch confirms target check job is settled",
	);

	assert.equal(
		await shouldDeliverQueuedCheckJob({
			key: JOB_ID,
			loadCurrentInbox: async () => ({ dispatches: [automation], identityComplete: false }),
			identity: dispatchId,
		}),
		true,
		"unconfirmed capped window fails open rather than dropping a pending check job",
	);

	assert.equal(
		await shouldDeliverQueuedCheckJob({
			key: JOB_ID,
			loadCurrentInbox: async () => ({ dispatches: [checkJob], identityComplete: true }),
			identity: dispatchId,
		}),
		true,
		"still-pending check job is delivered",
	);

	assert.equal(
		await shouldDeliverQueuedCheckJob({
			key: JOB_ID,
			loadCurrentInbox: async () => {
				throw new Error("MCP HTTP 503: upstream unavailable");
			},
			identity: dispatchId,
		}),
		true,
		"transient lookup failure fails open so real check jobs are delivered",
	);
});

test("real enqueueDispatch waits for foreground idle, skips already-settled check jobs without sending a prompt turn, and delivers on transient lookup failure", async () => {
	const dispatchSlice = remote.slice(
		remote.indexOf("function automationRecord("),
		remote.indexOf("/**\n * Revive a recoverably-ended server bond in place"),
	);
	assert.ok(dispatchSlice.includes("async function deliverCheckJob("), "isolated real check-job delivery slice");

	const settledId = "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11";
	const transientFailId = "4f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e22";
	const settledJob = { ...checkJob, id: settledId, check_job_id: settledId };
	const transientFailJob = { ...checkJob, id: transientFailId, check_job_id: transientFailId };

	const sent: Array<{ message: string; mode: string }> = [];
	const notices: string[] = [];
	const lookups: string[] = [];
	let idle = false;
	let activeRun = true;

	const active = {
		generation: 1,
		stop: false,
		bond: { connectionId: "conn-1", codename: "Wary Wolf" },
		runtimeOccupancy: { isBusy: () => activeRun },
		automationQueue: new DeliveryQueue(),
		automationRetryAttempts: new Map<string, number>(),
		automationRetryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
	};

	const sandbox: Record<string, unknown> = {
		setTimeout,
		clearTimeout,
		Date,
		Math,
		Promise,
		Set,
		Error,
		StaleDeliveryError,
		nextDeliveryRetryDelayMs,
		revalidateAutomationRunRetry,
		capturePumpAuthority,
		isPumpAuthorityCurrent,
		unwrapMcpResult,
		isAutomationRunEnvelope,
		isCheckJobEnvelope,
		isDispatchEnvelope,
		dispatchId,
		formatAutomationRunMessage,
		formatCheckJobMessage,
		shouldDeliverQueuedCheckJob,
		MODEL_TIMEOUT_MS: 5_000,
		pump: active,
		get runActive() {
			return activeRun;
		},
		noteAutomation() {},
		paintStatus() {},
		notify: (_ctx: unknown, msg: string) => notices.push(msg),
		currentPumpToken: async (_active: unknown, held: string) => held,
		pi_send: (message: string, mode: string) => {
			sent.push({ message, mode });
			// Starting a turn marks Pi occupied until that run settles.
			idle = false;
			activeRun = true;
		},
		callDevspec: async (_token: string, name: string, args: Record<string, unknown>) => {
			assert.equal(name, "get_connection_dispatch");
			const id = String(args.dispatch_id);
			lookups.push(id);
			if (id === settledId) {
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								connection_id: "conn-1",
								dispatches: [],
								count: 0,
								dispatch_id: id,
								identity_complete: true,
							}),
						},
					],
				};
			}
			throw new Error("MCP HTTP 503: upstream unavailable");
		},
	};

	const compiled = stripTypeScriptTypes(
		`${dispatchSlice}\n;globalThis.__api = { enqueueDispatch, notifyCheckJobIdleWaiters };`,
	);
	runInNewContext(compiled, sandbox);
	const api = sandbox.__api as {
		enqueueDispatch: (a: unknown, token: string, value: unknown, ctx: unknown) => void;
		notifyCheckJobIdleWaiters: () => void;
	};
	const ctx = {
		cwd: "/tmp",
		isIdle: () => idle,
		hasPendingMessages: () => false,
	};

	// Enqueue both check jobs while Pi is busy running an active foreground turn.
	api.enqueueDispatch(active, "tok-1", settledJob, ctx);
	api.enqueueDispatch(active, "tok-1", transientFailJob, ctx);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(sent.length, 0, "busy Pi does not push queued check jobs into followUp ahead of settle");
	assert.deepEqual(lookups, [], "revalidation waits until delivery time");

	// Settle the foreground turn: settledJob is skipped without sending a prompt turn,
	// and transientFailJob immediately fails open and delivers as a fresh 'now' turn!
	idle = true;
	activeRun = false;
	api.notifyCheckJobIdleWaiters();
	await active.automationQueue.idle();

	assert.deepEqual(lookups, [settledId, transientFailId]);
	assert.equal(sent.length, 1, "settled check job sent no prompt turn; transient failure still delivered");
	assert.equal(sent[0]!.mode, "now");
	assert.ok(sent[0]!.message.includes(transientFailId));
	assert.ok(!sent[0]!.message.includes(settledId));
	assert.deepEqual(notices, ["DevSpec remote: check job delivered."], "skipped check job emits no delivered toast");
});
