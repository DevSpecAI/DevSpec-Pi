/**
 * Pi says which room command it has started (item 7b693c1b).
 *
 * DevSpec no longer treats a busy report as starting a delivered command: a busy
 * sampled while the previous turn was ending marked the next command started, and
 * that turn's late finish closed it before the agent saw it (DevSpecV2 6d767a58).
 * So the host must say which command it started. These run the REAL message_start
 * hook and the REAL reportCommandPickup from the extension in a sandbox.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { capturePumpAuthority, isPumpAuthorityCurrent } from "../extensions/core/bond-recovery.ts";
import { remoteRunActivityPolicy, transitionToRealUserActivity } from "../extensions/core/system-notice.ts";
import { isDeliveryBoundary, isBetweenStepDelivery, TurnTracker } from "../extensions/core/turn-lifecycle.ts";
import { extractText } from "../extensions/core/trail.ts";
import { PendingWorkSubjects, TURN_LIFECYCLE_REQUEST_TIMEOUT_MS, isNonCommandWorkSubject, terminalWorkSubject, workSubjectEquals, workSubjectForCommand, workSubjectForNotices, workSubjectFromWakeText } from "../extensions/core/work-subject.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
function slice(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
	return source.slice(from, to);
}
const pickup = slice("async function reportCommandPickup(", "async function reportComplete(");
const messageStartHook = slice('\tpi.on("message_start"', '\tpi.on("message_update"');

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const COMMAND = { turnId: "22222222-2222-4222-8222-222222222222", commandMessageId: "33333333-3333-4333-8333-333333333333" };

type Call = { name: string; args: Record<string, unknown>; opts: Record<string, unknown> };

function rig(options: { binding?: typeof COMMAND | null; completionNeutral?: boolean; callFails?: boolean } = {}) {
	const calls: Call[] = [];
	const hooks: Record<string, (event: any, ctx: any) => Promise<unknown> | unknown> = {};
	const active = { generation: 1, stop: false, busy: false, workSubject: null, workSubjectNeedsClear: false, bond: { connectionId: CONNECTION, sessionId: "room", connectionCapability: "cap" },
		runtimeOccupancy: { promote: () => null } };
	const turn: Record<string, unknown> = { revision: 1, tracker: new TurnTracker(), completionNeutral: options.completionNeutral ?? false,
		receiptBatch: { reset() {} }, canPost: () => true };
	const sandbox: Record<string, any> = {
		Error, Promise,
		pump: active, turn, lastCtx: null, nextTurnRevision: 2,
		systemNoticeTurnPending: false, systemNoticeRunActive: false, activeCommandTurnIdentity: null,
		pendingSystemNoticeWorkSubject: null, parkedWorkSubject: null,
		pendingWorkSubjects: new PendingWorkSubjects(),
		TURN_LIFECYCLE_REQUEST_TIMEOUT_MS,
		isNonCommandWorkSubject, terminalWorkSubject, workSubjectEquals, workSubjectForCommand, workSubjectForNotices, workSubjectFromWakeText,
		setPumpWorkSubject: (a: Record<string, unknown>, s: unknown) => { a.workSubject = s; a.workSubjectNeedsClear = s === null; },
		SYSTEM_NOTICE_CUSTOM_TYPE: "devspec-system-notice",
		capturePumpAuthority, isPumpAuthorityCurrent, remoteRunActivityPolicy, transitionToRealUserActivity,
		isDeliveryBoundary, isBetweenStepDelivery, extractText,
		DevspecToolError: Error,
		resolveToken: async () => ({ token: "bearer" }),
		callDevspec: async (_token: string, name: string, args: Record<string, unknown>, opts: Record<string, unknown>) => {
			(opts.beforeSend as (() => void) | undefined)?.();
			calls.push({ name, args, opts });
			if (options.callFails) throw new Error("network down");
			return { content: [{ type: "text", text: JSON.stringify({ connection_id: CONNECTION, phase: "working", outcome: "picked_up" }) }] };
		},
		noteProgressEvent() {}, noteBetweenStepDelivered() {}, debug() {},
		isHarnessOrigin: () => false,
		commandTurnBindings: { take: () => options.binding === null ? undefined : (options.binding ?? COMMAND) },
		bindSegmentForMessage: () => (options.binding === null ? "typed" : "command"),
		ensureTurn() {},
		captureNoticeReply() {},
		splitTurnAtBoundary() {},
		isCommandTurnUnbound: () => false,
		trackTerminalPost() {},
		completeTurnActivity: async () => true,
		reportTerminalError: async () => true,
		pi_backgroundInputPending() {},
		retireInteractionForeground() {},
		beatBusy: async (busy: boolean) => { calls.push({ name: "beatBusy", args: { busy }, opts: {} }); },
		isSubagentAsyncNotification: () => false,
		reconcileSubagentFleetOwnership: async () => {},
		backgroundTaskNotificationId: () => null,
		pi_refreshBackgroundWork: async () => {},
		adoptParkedCommandIdentity() {},
		isClosedAnswerBoundary: () => false,
		pi: { on: (name: string, fn: (event: any, ctx: any) => unknown) => { hooks[name] = fn; } },
	};
	runInNewContext(stripTypeScriptTypes(`${pickup}\n${messageStartHook}`), sandbox);
	const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
	return {
		calls, sandbox, settle,
		say: async (text: string) => { await hooks.message_start!({ message: { role: "user", content: text } }, { cwd: "/tmp" }); await settle(); },
		pickups: () => calls.filter((c) => c.name === "report_pickup"),
	};
}

test("a room command that starts a segment is reported as started, naming exactly that command", async () => {
	const r = rig();
	await r.say("[DevSpec remote — message from Ali] fix the export");
	assert.equal(r.pickups().length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(r.pickups()[0]!.args)), { connection_id: CONNECTION, command_turn_id: COMMAND.turnId, command_message_id: COMMAND.commandMessageId });
	assert.equal(r.pickups()[0]!.opts.lane, "pump");
	assert.equal(r.pickups()[0]!.opts.retry, "never");
});

test("each command segment is reported once, and a follow-up names its own command", async () => {
	const r = rig();
	await r.say("[DevSpec remote — message from Ali] first");
	const followUp = { turnId: COMMAND.turnId, commandMessageId: "44444444-4444-4444-8444-444444444444" };
	r.sandbox.commandTurnBindings.take = () => followUp;
	await r.say("[DevSpec remote — message from Ali] and also this");
	assert.deepEqual(r.pickups().map((c) => c.args.command_message_id), [COMMAND.commandMessageId, followUp.commandMessageId]);
});

test("a prompt typed at the terminal sends no command pickup", async () => {
	const r = rig({ binding: null });
	await r.say("what does this function do?");
	assert.equal(r.pickups().length, 0);
});

test("a failed pickup never fails the message", async () => {
	const r = rig({ callFails: true });
	await assert.doesNotReject(r.say("[DevSpec remote — message from Ali] fix the export"));
	assert.equal(r.pickups().length, 1);
});

test("a pickup whose segment was replaced before it could be sent is not sent", async () => {
	const r = rig();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	r.sandbox.resolveToken = async () => { await gate; return { token: "bearer" }; };
	const first = r.say("[DevSpec remote — message from Ali] first");
	// A newer command takes the segment before the first pickup resolves its token.
	(r.sandbox.turn as Record<string, unknown>).commandMessageId = "55555555-5555-4555-8555-555555555555";
	release();
	await first;
	assert.equal(r.pickups().length, 0);
});

test("a stopped connection sends no pickup", async () => {
	const r = rig();
	r.sandbox.pump.stop = true;
	await r.say("[DevSpec remote — message from Ali] fix the export");
	assert.equal(r.pickups().length, 0);
});
