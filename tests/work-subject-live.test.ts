/**
 * Task 2145bd84: mechanical live working state, wake subject (`work_subject`),
 * 24-hour staleness alignment, owned background work persistence, and granular
 * live `phase: "trail"` streaming across notice, check-job, automation,
 * terminal, and room-command turns.
 *
 * Covers both pure unit contracts and end-to-end execution of the real
 * `extensions/devspec-remote.ts` against a scripted DevSpec server.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DevspecToolError, resetClientCache, setLaneClientFactoryForTests, type LaneClient } from "../extensions/core/client.ts";
import { getBond, setBond } from "../extensions/core/bond-state.ts";
import { saveLogin } from "../extensions/core/auth-store.ts";
import { parsePostSessionReceipt, TrailDeliveryState } from "../extensions/core/post-session-receipt.ts";
import { projectTrailArgs, projectTrailResult } from "../extensions/core/trail-projection.ts";
import { resetSystemNoticeStateForTests } from "../extensions/core/system-notice.ts";
import {
	ACTIVITY_PROGRESS_STALENESS_HOURS,
	PendingWorkSubjects,
	isNonChatWorkSubject,
	isNonCommandWorkSubject,
	terminalWorkSubject,
	workSubjectForAutomationRun,
	workSubjectForCheckJobs,
	workSubjectForCommand,
	workSubjectForNotices,
	workSubjectFromWakeText,
	workSubjectWireField,
} from "../extensions/core/work-subject.ts";
import { canonicalPoll, IDS, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";

const PROJECT = {
	id: IDS.project,
	name: "Website",
	organization: { id: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd", name: "Agency" },
};
const CONNECTION = IDS.connection;
const ROOM_SESSION = "session-1";
const SERVER_NOTICE_ID = "17171717-1717-4171-8171-171717171717";
const SYSTEM_NOTICE_ID = "18181818-1818-4181-8181-181818181818";
const CHECK_JOB_ID = "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11";
const AUTOMATION_RUN_ID = "4a1b2c3d-1111-4222-8333-444455556666";
const HOUR = 60 * 60 * 1000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, withinMs: number, what: string): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > withinMs) assert.fail(`timed out waiting for ${what}`);
		await delay(10);
	}
}

function textResult(data: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

// ---- Pure contract tests --------------------------------------------------

test("work_subject shapes match DevSpecV2 strict wire schema and 24-hour staleness rule", () => {
	assert.equal(ACTIVITY_PROGRESS_STALENESS_HOURS, 24);
	assert.deepEqual(terminalWorkSubject(), { kind: "terminal" });
	assert.equal("id" in terminalWorkSubject(), false, "terminal work_subject must have no id field");
	assert.deepEqual(workSubjectForCommand(IDS.command.toUpperCase()), { kind: "command", id: IDS.command });
	assert.equal(workSubjectForCommand("not-a-uuid"), null);
	assert.deepEqual(workSubjectForAutomationRun({ run_id: AUTOMATION_RUN_ID }), { kind: "automation_run", id: AUTOMATION_RUN_ID });
	assert.deepEqual(workSubjectForCheckJobs([{ id: CHECK_JOB_ID, envelope: { check_job_id: CHECK_JOB_ID } }]), { kind: "check_job", id: CHECK_JOB_ID });

	// Mixed notice batches prefer server_notice over system_notice and skip invalid ids.
	const mixed = [
		{ kind: "unlinked_commit_item_review", notice_id: SYSTEM_NOTICE_ID },
		{ kind: "server_notice", notice_id: SERVER_NOTICE_ID },
	];
	assert.deepEqual(workSubjectForNotices(mixed), { kind: "server_notice", id: SERVER_NOTICE_ID });
	assert.deepEqual(workSubjectForNotices([{ kind: "unlinked_commit_item_review", notice_id: SYSTEM_NOTICE_ID }]), { kind: "system_notice", id: SYSTEM_NOTICE_ID });
	assert.equal(workSubjectForNotices([{ kind: "server_notice", notice_id: "bad" }]), null);

	assert.equal(isNonCommandWorkSubject({ kind: "command", id: IDS.command }), false);
	assert.equal(isNonCommandWorkSubject({ kind: "server_notice", id: SERVER_NOTICE_ID }), true);
	assert.equal(isNonCommandWorkSubject({ kind: "terminal" }), true);
	assert.equal(isNonChatWorkSubject({ kind: "terminal" }), false);
	assert.equal(isNonChatWorkSubject({ kind: "check_job", id: CHECK_JOB_ID }), true);

	assert.deepEqual(workSubjectWireField(true, { kind: "check_job", id: CHECK_JOB_ID }, false), { work_subject: { kind: "check_job", id: CHECK_JOB_ID } });
	assert.deepEqual(workSubjectWireField(true, null, false), {});
	assert.deepEqual(workSubjectWireField(false, null, true), { work_subject: null });
	assert.deepEqual(workSubjectWireField(false, null, false), {});

	assert.deepEqual(workSubjectFromWakeText("check_job", `"check_job_id": "${CHECK_JOB_ID}"`), { kind: "check_job", id: CHECK_JOB_ID });
	assert.deepEqual(workSubjectFromWakeText("automation", `"run_id": "${AUTOMATION_RUN_ID}"`), { kind: "automation_run", id: AUTOMATION_RUN_ID });

	const pending = new PendingWorkSubjects();
	pending.remember("wake-a", { kind: "check_job", id: CHECK_JOB_ID });
	assert.deepEqual(pending.peek("wake-a"), { kind: "check_job", id: CHECK_JOB_ID });
	assert.deepEqual(pending.take("wake-a"), { kind: "check_job", id: CHECK_JOB_ID });
	assert.equal(pending.take("wake-a"), undefined);

	// No arbitrary 128-entry silent oldest-eviction (requirements 3c5147a7 & 91d7b47c).
	for (let i = 0; i < 150; i += 1) {
		pending.remember(`wake-${i}`, { kind: "check_job", id: CHECK_JOB_ID });
	}
	assert.deepEqual(pending.take("wake-0"), { kind: "check_job", id: CHECK_JOB_ID }, "oldest entry must not be silently evicted");
	assert.deepEqual(pending.take("wake-149"), { kind: "check_job", id: CHECK_JOB_ID });
	pending.clear();
});

test("parsePostSessionReceipt accepts attempt-backed phase:'trail' receipts for BOTH ordinary room commands (diagnostics_only:false) and diagnostics_only:true without freezing TrailDeliveryState", () => {
	const attemptId = "99999999-9999-4999-8999-999999999999";
	// Bold Zebra's staging regression: ordinary room-command phase:'trail' receipt returns
	// diagnostics_only: false + attempt_id + delivery:{status:'stored', message_id:attempt_id}
	// with NO top-level message_id. Must succeed across consecutive updates without blocking!
	const roomCommandTrail = textResult({
		delivery: { status: "stored", message_id: attemptId },
		session_id: ROOM_SESSION,
		connection_id: CONNECTION,
		attempt_id: attemptId,
		phase: "trail",
		diagnostics_only: false,
		work_trail_chars: 42,
	});
	const delivery = new TrailDeliveryState();
	delivery.markDirty();
	const snap1 = delivery.begin();
	assert.notEqual(snap1, null);
	const receipt1 = parsePostSessionReceipt(roomCommandTrail, { connectionId: CONNECTION, sessionId: ROOM_SESSION, phase: "trail" });
	assert.deepEqual(receipt1, { status: "stored", messageId: attemptId, diagnosticsOnly: true });
	delivery.finish(snap1!, receipt1.status === "stored");
	assert.equal(delivery.blocked, false, "first ordinary room-command trail receipt must NOT freeze TrailDeliveryState");

	// Second consecutive update stays unblocked and succeeds too.
	delivery.markDirty();
	const snap2 = delivery.begin();
	assert.notEqual(snap2, null, "second update must be allowed after first attempt-backed receipt");
	const receipt2 = parsePostSessionReceipt(roomCommandTrail, { connectionId: CONNECTION, sessionId: ROOM_SESSION, phase: "trail" });
	assert.deepEqual(receipt2, { status: "stored", messageId: attemptId, diagnosticsOnly: true });
	delivery.finish(snap2!, receipt2.status === "stored");
	assert.equal(delivery.blocked, false);

	const raw = textResult({
		delivery: { status: "stored", message_id: attemptId },
		session_id: ROOM_SESSION,
		connection_id: CONNECTION,
		attempt_id: attemptId,
		phase: "trail",
		diagnostics_only: true,
		work_trail_chars: 42,
	});
	assert.deepEqual(
		parsePostSessionReceipt(raw, { connectionId: CONNECTION, sessionId: ROOM_SESSION, phase: "trail" }),
		{ status: "stored", messageId: attemptId, diagnosticsOnly: true },
	);
	assert.deepEqual(
		parsePostSessionReceipt(raw, { connectionId: CONNECTION, sessionId: ROOM_SESSION, phase: "answer" }),
		{ status: "malformed" },
	);
	const wrongAttempt = textResult({
		delivery: { status: "stored", message_id: "other" },
		session_id: ROOM_SESSION,
		connection_id: CONNECTION,
		attempt_id: attemptId,
		phase: "trail",
		diagnostics_only: true,
	});
	assert.deepEqual(
		parsePostSessionReceipt(wrongAttempt, { connectionId: CONNECTION, sessionId: ROOM_SESSION, phase: "trail" }),
		{ status: "malformed" },
	);

	// Full structured refusal payload is preserved unmodified across parsePostSessionReceipt,
	// DevspecToolError.raw, and TrailDeliveryState.refusal (requirement 4e32d1a5, zero slicing).
	const refusalPayload = {
		attempt_id: attemptId,
		outcome: "already_finalized",
		reason: "attempt_finalized",
		terminal: true,
		retryable: false,
		awaiting_input: false,
		blocking_context: { kind: "turn", id: attemptId },
		delivery: { status: "rejected", outcome: "already_finalized", reason: "attempt_finalized", terminal: true, retryable: false },
		error: "Turn already finalized",
	};
	const refused = { ...textResult(refusalPayload), isError: true };
	const toolErr = new DevspecToolError("Turn already finalized", refused);
	const parsedRefusal = parsePostSessionReceipt(toolErr.raw, { connectionId: CONNECTION, sessionId: ROOM_SESSION, phase: "trail" });
	assert.deepEqual(parsedRefusal, { status: "rejected", refusal: refusalPayload });
	const refusedDelivery = new TrailDeliveryState();
	refusedDelivery.markDirty();
	const snap = refusedDelivery.begin();
	assert.notEqual(snap, null);
	refusedDelivery.finish(snap!, false, parsedRefusal.status === "rejected" ? parsedRefusal.refusal : undefined);
	assert.equal(refusedDelivery.blocked, true);
	assert.deepEqual(refusedDelivery.refusal, refusalPayload);
});

test("trail projections keep background commands, gh commands, and newer DevSpec verbs granular and privacy-safe", () => {
	assert.equal(projectTrailArgs("bg_run", { command: "npm test" }), "npm test");
	assert.equal(projectTrailArgs("bg_run_pi_attested", { command: "git status --short" }), "git status --short");
	assert.equal(projectTrailArgs("bash", { command: "gh pr merge 1708 --squash --match-head-commit abc123" }), "gh pr merge");
	assert.equal(projectTrailArgs("bash", { command: "gh pr view https://secret.example.com/private" }), "gh pr view");
	assert.equal(projectTrailArgs("get_requirement", { requirement_id: SERVER_NOTICE_ID }), `requirement_id=${SERVER_NOTICE_ID}`);
	assert.equal(projectTrailArgs("claim_automation_run", { run_id: AUTOMATION_RUN_ID }), `run_id=${AUTOMATION_RUN_ID}`);
	assert.equal(projectTrailArgs("manage_incident", { action: "resolve", incident_id: SERVER_NOTICE_ID, summary: "private" }), `action=resolve; incident_id=${SERVER_NOTICE_ID}`);
	assert.equal(projectTrailResult("manage_incident", { details: { status: "resolved" } }), "status=resolved");
});

// ---- End-to-end live extension harness ------------------------------------

type Call = { name: string; args?: Record<string, unknown> };

class ScriptedDevspec {
	private server!: Server;
	private readonly streams = new Set<ServerResponse>();
	mcpUrl = "";
	readonly calls: Call[] = [];
	attachedSessionId: string | null = ROOM_SESSION;
	failNonCommandPickup = false;
	private pollQueue: Array<Record<string, unknown>> = [];
	private dispatchesById = new Map<string, unknown>();

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method === "GET" && url.pathname === "/api/mcp/connection-stream") {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				res.write("event: wake\ndata: {}\n\n");
				this.streams.add(res);
				req.on("close", () => this.streams.delete(res));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
		this.mcpUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api/mcp`;
	}

	enqueuePoll(response: Record<string, unknown>): void {
		this.pollQueue.push(response);
		this.wake();
	}

	rememberDispatch(id: string, envelope: unknown): void {
		this.dispatchesById.set(id, envelope);
	}

	wake(): void {
		for (const stream of this.streams) stream.write("event: wake\ndata: {}\n\n");
	}

	async stop(): Promise<void> {
		for (const stream of this.streams) stream.end();
		this.streams.clear();
		this.server.closeAllConnections?.();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	callsOf(name: string): Call[] {
		return this.calls.filter((c) => c.name === name);
	}

	installLaneFactory(): void {
		let registrations = 0;
		let attemptSeq = 0;
		setLaneClientFactoryForTests(async (): Promise<LaneClient> => ({
			callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
				this.calls.push({ name, args });
				if (name === "register_connection") {
					registrations += 1;
					const attached = this.attachedSessionId;
					return {
						...textResult({
							connection_id: CONNECTION,
							project_id: PROJECT.id,
							codename: TEST_CONNECTION.codename,
							session_id: attached,
							...(attached ? { attached_at: "2026-11-28T00:00:00.000Z", speech_attachment_id: "att-1" } : {}),
							project_selection: { version: 1, status: "resolved", source: "folder_pin", project: PROJECT },
						}),
						_meta: { devspec: { connection_capability: { version: 1, value: `dvsc_cap_${registrations}_12345678901234567890` } } },
					};
				}
				if (name === "poll_connection") {
					const next = this.pollQueue.shift();
					const interactionEcho = args?.interaction_event_version === 1
						? { interaction_event_version: 1, interaction_events: [], question_dismissal_event_version: 1, question_dismissal_events: [] }
						: {};
					if (next) return textResult({ ...interactionEcho, ...next });
					const attached = this.attachedSessionId;
					return textResult({
						connection_id: args?.connection_id ?? CONNECTION,
						session_id: attached,
						...(attached ? { attached_at: "2026-11-28T00:00:00.000Z", speech_attachment_id: "att-1" } : {}),
						changed: false,
						dispatches: [],
						dispatch_cursor: null,
						cursor_v2: null,
						...interactionEcho,
						...(args?.system_notice_version === undefined
							? {}
							: { system_notice_version: args.system_notice_version, system_notice_cursor: null, system_notices: [] }),
					});
				}
				if (name === "get_connection_dispatch") {
					const id = String(args?.dispatch_id ?? "");
					const found = this.dispatchesById.get(id);
					return textResult({
						connection_id: CONNECTION,
						dispatch_id: id,
						identity_complete: true,
						dispatches: found ? [found] : [],
						count: found ? 1 : 0,
					});
				}
				if (name === "report_pickup") {
					if (this.failNonCommandPickup && args?.work_subject) {
						return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "temporary pickup failure", retryable: true }) }] };
					}
					attemptSeq += 1;
					const attemptId = `00000000-0000-4000-8000-${String(attemptSeq).padStart(12, "0")}`;
					if (args?.local_activity_version === 1) {
						return textResult({
							connection_id: args.connection_id,
							expected_session_id: args.expected_session_id,
							expected_attached_at: args.expected_attached_at,
							expected_attachment_id: args.expected_attachment_id,
							attempt_id: args.attempt_id,
							status: "working",
							already_started: false,
						});
					}
					return textResult({
						connection_id: args?.connection_id ?? CONNECTION,
						attempt_id: attemptId,
						phase: "working",
						...(args?.work_subject ? { work_subject: args.work_subject } : {}),
					});
				}
				if (name === "report_complete") {
					return textResult({
						connection_id: args?.connection_id ?? CONNECTION,
						phase: "done",
						...(args?.attempt_id ? { attempt_id: args.attempt_id } : {}),
						...(args?.command_turn_id ? { command_turn_id: args.command_turn_id } : {}),
					});
				}
				if (name === "post_session_message") {
					if (args?.phase === "trail" && !args?.command_turn_id && !args?.command_turn_unbound) {
						const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
						if (!this.attachedSessionId) {
							return textResult({
								message_id: AUTOMATION_RUN_ID,
								session_id: null,
								connection_id: args.connection_id,
								phase: "trail",
								run_id: AUTOMATION_RUN_ID,
								delivery: { status: "stored", message_id: AUTOMATION_RUN_ID },
							});
						}
						return textResult({
							delivery: { status: "stored", message_id: attemptId },
							session_id: this.attachedSessionId,
							connection_id: args.connection_id,
							attempt_id: attemptId,
							phase: "trail",
							diagnostics_only: true,
							work_trail_chars: String(args.message ?? "").length,
						});
					}
					return textResult({
						connection_id: args?.connection_id ?? CONNECTION,
						session_id: this.attachedSessionId,
						phase: args?.phase ?? "answer",
						message_id: "row-1",
						...(args?.turn_kind ? { turn_kind: args.turn_kind } : {}),
						...(args?.assistant_source_id ? { assistant_source_id: args.assistant_source_id } : {}),
						delivery: { status: "stored", message_id: "row-1" },
					});
				}
				return textResult({ success: true });
			},
			readResource: async () => ({ contents: [] }),
			close: async () => {},
		}));
	}
}

let dir: string;
let srv: ScriptedDevspec;
const savedEnv = { token: process.env.DEVSPEC_MCP_TOKEN, url: process.env.DEVSPEC_MCP_URL, agentDir: process.env.PI_CODING_AGENT_DIR };
let shutdown: (() => Promise<void>) | null = null;

beforeEach(async () => {
	resetSystemNoticeStateForTests();
	dir = await mkdtemp(join(tmpdir(), "devspec-work-subject-"));
	srv = new ScriptedDevspec();
	await srv.start();
	delete process.env.DEVSPEC_MCP_TOKEN;
	process.env.DEVSPEC_MCP_URL = srv.mcpUrl;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	setBond(null);
	resetClientCache();
	await saveLogin({
		endpoint: srv.mcpUrl,
		tokens: { accessToken: "oat_initial", refreshToken: "rt_initial", issuedAt: Date.now(), expiresAt: Date.now() + 24 * HOUR },
		issuer: "https://apt-hare-75.clerk.accounts.dev",
		tokenEndpoint: `${srv.mcpUrl}/oauth/token`,
		clientId: "bWlWy3fvhxrNU2LT",
		resource: srv.mcpUrl,
		signedInAs: "Example Person",
	});
	srv.installLaneFactory();
});

afterEach(async () => {
	await shutdown?.();
	shutdown = null;
	resetSystemNoticeStateForTests();
	setLaneClientFactoryForTests(null);
	resetClientCache();
	setBond(null);
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	await srv.stop();
	for (const [key, value] of [["DEVSPEC_MCP_TOKEN", savedEnv.token], ["DEVSPEC_MCP_URL", savedEnv.url], ["PI_CODING_AGENT_DIR", savedEnv.agentDir]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(dir, { recursive: true, force: true });
});

async function loadRemote() {
	const { default: remote } = await import(`../extensions/devspec-remote.ts?fresh=${Math.random()}`);
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const eventBus = new Map<string, Set<(data: unknown) => void>>();
	const entries: unknown[] = [];
	const warnings: string[] = [];
	const sentCustomMessages: Array<{ customType: string; content: string; details?: unknown }> = [];
	const sentUserMessages: string[] = [];
	let idle = true;
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		events: {
			on: (name: string, fn: (data: unknown) => void) => {
				let set = eventBus.get(name);
				if (!set) { set = new Set(); eventBus.set(name, set); }
				set.add(fn);
				return () => { set?.delete(fn); };
			},
			emit: (name: string, data: unknown) => {
				for (const fn of [...(eventBus.get(name) ?? [])]) fn(data);
			},
		},
		getActiveTools: () => [],
		setActiveTools: () => {},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		sendMessage: (msg: { customType: string; content: string; details?: unknown }) => { sentCustomMessages.push(msg); },
		sendUserMessage: (msg: string) => { sentUserMessages.push(msg); },
	} as unknown as ExtensionAPI;
	remote(pi);
	const ctx = {
		cwd: dir,
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort: () => {},
		model: { provider: "anthropic", id: "claude-sonnet-4" },
		getContextUsage: () => undefined,
		sessionManager: {
			getSessionId: () => "local-session-1",
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafEntry: () => undefined,
			getSessionFile: () => undefined,
			getCwd: () => dir,
		},
		ui: {
			notify: (msg: string, level?: string) => { if (level === "warning" || level === "error") warnings.push(msg); },
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_role: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
	const run = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	let shut = false;
	shutdown = async () => {
		if (shut) return;
		shut = true;
		await run("session_shutdown", { type: "session_shutdown" });
	};
	// Strip auto-stamped project_id when asserting exact wire keys of pickup/complete calls.
	const stripProject = (args: Record<string, unknown> | undefined) => {
		const { project_id: _projectId, ...rest } = args ?? {};
		return rest;
	};
	return {
		start: () => run("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => shutdown!(),
		run,
		setIdle: (v: boolean) => { idle = v; },
		emitBus: (name: string, data: unknown) => (pi.events as { emit: (n: string, d: unknown) => void }).emit(name, data),
		onBus: (name: string, fn: (data: unknown) => void) => (pi.events as { on: (n: string, f: (d: unknown) => void) => () => void }).on(name, fn),
		sentCustomMessages,
		sentUserMessages,
		warnings,
		stripProject,
	};
}

test("server_notice wake reports live working state, exact work_subject, diagnostics trail, zero chat bubble, and clean idle clear", async () => {
	const pi = await loadRemote();
	await pi.start();
	assert.equal(getBond()?.connectionId, CONNECTION);

	const prNotice = {
		version: 1 as const,
		kind: "server_notice" as const,
		notice_id: SERVER_NOTICE_ID,
		topic: "coherence_finding",
		notice_type: "pr_requirement_break",
		summary: "PR #1708 violates requirement",
		prompt: "Fix the requirement violation on the branch.",
		contract_uri: "devspec://product/remote-ingress-contract" as const,
		records: [{ label: "Requirement", record_type: "memory", record_id: IDS.project, title: "Always verify", text: "Always verify.", url: null }],
		allowed_outcomes: ["fixed_on_branch"],
		allowed_tools: ["record_implementation"],
		audience: "for_the_record" as const,
	};
	srv.enqueuePoll({
		...canonicalPoll({ senderStyleNegotiated: true, wakeKind: "system_notice", systemNotices: [prNotice as never] }),
		session_id: ROOM_SESSION,
		attached_at: "2026-11-28T00:00:00.000Z",
		speech_attachment_id: "att-1",
	});
	await until(() => pi.sentCustomMessages.length === 1, 2_000, "notice custom message delivered");

	const custom = pi.sentCustomMessages[0]!;
	pi.setIdle(false);
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "custom", customType: custom.customType, content: custom.content, details: custom.details } });
	await pi.run("context", { messages: [] });
	await pi.run("tool_execution_start", { toolCallId: "t1", toolName: "read", args: { path: "src/app.ts" } });
	await pi.run("tool_execution_end", { toolCallId: "t1", toolName: "read", result: { content: [] }, isError: false });
	await pi.run("tool_execution_start", { toolCallId: "t2", toolName: "bash", args: { command: "npm test" } });
	await pi.run("tool_execution_end", { toolCallId: "t2", toolName: "bash", result: { content: [] }, isError: false });
	await pi.run("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed the branch and verified." }] } });

	// Trigger a live poll while working to verify poll_connection carries busy:true + work_subject + progress_marker.
	const pollsBefore = srv.callsOf("poll_connection").length;
	srv.wake();
	await until(
		() => {
			if (srv.callsOf("poll_connection").slice(pollsBefore).some((c) => c.args?.busy === true)) return true;
			srv.wake();
			return false;
		},
		2_000,
		"mid-run busy poll",
	);
	const busyPoll = srv.callsOf("poll_connection").slice(pollsBefore).find((c) => c.args?.busy === true);
	assert.ok(busyPoll, "poll_connection reports busy:true during server_notice turn");
	assert.deepEqual(busyPoll.args?.work_subject, { kind: "server_notice", id: SERVER_NOTICE_ID });
	assert.ok(typeof busyPoll.args?.progress_marker === "string");

	// Verify report_pickup opened a source-less attempt with exact work_subject (no command ids / local_activity_version).
	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "non-command report_pickup");
	const pickup = srv.callsOf("report_pickup")[0]!;
	assert.deepEqual(pi.stripProject(pickup.args), { connection_id: CONNECTION, work_subject: { kind: "server_notice", id: SERVER_NOTICE_ID } });

	// Verify live heartbeat carried busy:true + exact work_subject.
	const liveBeats = srv.callsOf("heartbeat_connection").filter((c) => c.args?.status === "live");
	assert.ok(liveBeats.some((b) => b.args?.busy === true && (b.args?.work_subject as { kind?: string; id?: string } | undefined)?.kind === "server_notice" && (b.args?.work_subject as { id?: string }).id === SERVER_NOTICE_ID));

	// Settle the notice turn.
	pi.setIdle(true);
	await pi.run("agent_settled", {});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "source-less report_complete");

	// Verify ZERO post_session_message calls (for-the-record notice stays quiet with no Technical details trail).
	const posts = srv.callsOf("post_session_message");
	assert.equal(posts.length, 0, "for-the-record server_notice posts zero chat bubbles and zero Technical details trails");

	assert.deepEqual(pi.stripProject(srv.callsOf("report_complete")[0]!.args), {
		connection_id: CONNECTION,
		reason: "turn_end",
		attempt_id: "00000000-0000-4000-8000-000000000001",
	});

	// Idle heartbeat clears work_subject: null; subsequent unchanged idle poll omits work_subject.
	await until(() => srv.callsOf("heartbeat_connection").some((c) => c.args?.busy === false && c.args?.work_subject === null), 2_000, "idle clear heartbeat");
	const pollsAfterIdle = srv.callsOf("poll_connection").length;
	srv.wake();
	await until(
		() => {
			if (srv.callsOf("poll_connection").slice(pollsAfterIdle).some((c) => c.args?.busy === false && !("work_subject" in (c.args ?? {})))) return true;
			srv.wake();
			return false;
		},
		2_000,
		"post-idle poll omitting unchanged work_subject",
	);
	const steadyIdlePoll = srv.callsOf("poll_connection").slice(pollsAfterIdle).find((c) => c.args?.busy === false && !("work_subject" in (c.args ?? {})))!;
	assert.equal(steadyIdlePoll.args?.busy, false);
	assert.equal("work_subject" in (steadyIdlePoll.args ?? {}), false, "unchanged idle poll omits work_subject");
	assert.deepEqual(pi.warnings, [], "diagnostics_only trail receipt triggers no warnings");
});

test("system_notice (unlinked_commit_item_review) reports exact system_notice work_subject and closes cleanly", async () => {
	const pi = await loadRemote();
	await pi.start();
	const commitNotice = {
		version: 1 as const,
		kind: "unlinked_commit_item_review" as const,
		notice_id: SYSTEM_NOTICE_ID,
		commit_sha: "a".repeat(40),
		task_id: IDS.project,
		task_title: "Link commit",
		branch: "main",
		contract_uri: "devspec://product/remote-ingress-contract" as const,
		allowed_outcomes: ["correct_item", "link_item", "resolve_duplicate", "dismiss_item", "confirm_item_correct", "defer_follow_up"],
		allowed_tools: ["get_task", "update_task", "link_tasks", "supersede_task"],
		audience: "for_the_record" as const,
	};
	srv.enqueuePoll({
		...canonicalPoll({ senderStyleNegotiated: true, wakeKind: "system_notice", systemNotices: [commitNotice as never] }),
		session_id: ROOM_SESSION,
		attached_at: "2026-11-28T00:00:00.000Z",
		speech_attachment_id: "att-1",
	});
	await until(() => pi.sentCustomMessages.length === 1, 2_000, "system notice delivered");

	const custom = pi.sentCustomMessages[0]!;
	pi.setIdle(false);
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "custom", customType: custom.customType, content: custom.content, details: custom.details } });
	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "system_notice report_pickup");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_pickup")[0]!.args), {
		connection_id: CONNECTION,
		work_subject: { kind: "system_notice", id: SYSTEM_NOTICE_ID },
	});
	pi.setIdle(true);
	await pi.run("agent_settled", {});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "system_notice report_complete");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_complete")[0]!.args), {
		connection_id: CONNECTION,
		reason: "turn_end",
		attempt_id: "00000000-0000-4000-8000-000000000001",
	});
});

test("check_job wake reports check_job work_subject, streams granular trail without check-plumbing tools, stays chat-silent, and closes cleanly", async () => {
	const pi = await loadRemote();
	await pi.start();
	const checkEnvelope = {
		id: CHECK_JOB_ID,
		kind: "check_job",
		check_job_id: CHECK_JOB_ID,
		check_kind: "conflict_decisions",
		record: { type: "task", id: "9b2d6c1e-1111-4222-8333-444455556666", title: "Verify check" },
		entries: 2,
		yours: false,
		offered_at: "2026-11-28T02:00:00.000Z",
		delivery_connection_id: CONNECTION,
	};
	srv.rememberDispatch(CHECK_JOB_ID, checkEnvelope);
	srv.enqueuePoll({
		connection_id: CONNECTION,
		session_id: ROOM_SESSION,
		attached_at: "2026-11-28T00:00:00.000Z",
		speech_attachment_id: "att-1",
		changed: false,
		dispatches: [checkEnvelope],
		dispatch_cursor: "disp-1",
		cursor_v2: null,
		system_notice_version: 3,
		system_notice_cursor: null,
		system_notices: [],
	});
	await until(() => pi.sentUserMessages.length === 1, 2_000, "check job delivered");
	const wakeMsg = pi.sentUserMessages[0]!;

	pi.setIdle(false);
	await pi.run("before_agent_start", { prompt: wakeMsg });
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "user", content: wakeMsg } });
	await pi.run("context", { messages: [] });
	await pi.run("tool_execution_start", { toolCallId: "c1", toolName: "claim_check_job", args: { check_job_id: CHECK_JOB_ID } });
	await pi.run("tool_execution_end", { toolCallId: "c1", toolName: "claim_check_job", result: { content: [] }, isError: false });
	await pi.run("tool_execution_start", { toolCallId: "c2", toolName: "read", args: { path: "docs/spec.md" } });
	await pi.run("tool_execution_end", { toolCallId: "c2", toolName: "read", result: { content: [] }, isError: false });
	await pi.run("tool_execution_start", { toolCallId: "c3", toolName: "record_check_rulings", args: { check_job_id: CHECK_JOB_ID } });
	await pi.run("tool_execution_end", { toolCallId: "c3", toolName: "record_check_rulings", result: { content: [] }, isError: false });
	await pi.run("message_end", { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Ruled both entries." }] } });

	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "check_job report_pickup");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_pickup")[0]!.args), {
		connection_id: CONNECTION,
		work_subject: { kind: "check_job", id: CHECK_JOB_ID },
	});

	pi.setIdle(true);
	await pi.run("agent_settled", {});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "check_job report_complete");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_complete")[0]!.args), {
		connection_id: CONNECTION,
		reason: "turn_end",
		attempt_id: "00000000-0000-4000-8000-000000000001",
	});

	const posts = srv.callsOf("post_session_message");
	assert.equal(posts.length, 0, "check_job posts zero chat bubbles and zero Technical details trails");
	assert.deepEqual(pi.warnings, []);
});

test("automation_run wake reports automation_run work_subject, streams trail, and closes cleanly", async () => {
	srv.attachedSessionId = null;
	const pi = await loadRemote();
	await pi.start();
	const autoEnvelope = {
		id: AUTOMATION_RUN_ID,
		kind: "automation_run",
		run_id: AUTOMATION_RUN_ID,
		automation_id: "5b2c3d4e-1111-4222-8333-444455556666",
		automation_name: "Nightly audit",
		trigger_kind: "scheduled",
		owner: { user_id: "owner-1", display_name: "Ali Price" },
		permission: "look_only",
		queued_at: "2026-11-28T02:00:00.000Z",
		delivery_connection_id: CONNECTION,
		requester: null,
	};
	srv.enqueuePoll({
		connection_id: CONNECTION,
		session_id: null,
		changed: false,
		dispatches: [autoEnvelope],
		dispatch_cursor: "disp-auto-1",
		cursor_v2: null,
		system_notice_version: 3,
		system_notice_cursor: null,
		system_notices: [],
	});
	await until(() => pi.sentUserMessages.length === 1, 2_000, "automation wake delivered");
	const wakeMsg = pi.sentUserMessages[0]!;

	pi.setIdle(false);
	await pi.run("before_agent_start", { prompt: wakeMsg });
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "user", content: wakeMsg } });
	await pi.run("tool_execution_start", { toolCallId: "a1", toolName: "bash", args: { command: "npm run lint" } });
	await pi.run("tool_execution_end", { toolCallId: "a1", toolName: "bash", result: { content: [] }, isError: false });

	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "automation report_pickup");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_pickup")[0]!.args), {
		connection_id: CONNECTION,
		work_subject: { kind: "automation_run", id: AUTOMATION_RUN_ID },
	});

	pi.setIdle(true);
	await pi.run("agent_settled", {});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "automation report_complete");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_complete")[0]!.args), {
		connection_id: CONNECTION,
		reason: "turn_end",
		attempt_id: "00000000-0000-4000-8000-000000000001",
	});
	const trailPosts = srv.callsOf("post_session_message");
	assert.equal(trailPosts.length, 0, "automation_run posts zero phase:trail Technical details");
});

test("terminal prompt (attached vs sessionless), room command, and offline heartbeat follow exact work_subject rules", async () => {
	// 1. Sessionless terminal prompt -> report_pickup({ connection_id, work_subject: { kind: "terminal" } })
	srv.attachedSessionId = null;
	const sessionlessPi = await loadRemote();
	await sessionlessPi.start();
	sessionlessPi.setIdle(false);
	await sessionlessPi.run("input", { source: "interactive", text: "check git log" });
	await sessionlessPi.run("agent_start", {});
	await sessionlessPi.run("message_start", { message: { role: "user", content: "check git log" } });
	await sessionlessPi.run("context", { messages: [] });
	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "sessionless terminal pickup");
	assert.deepEqual(sessionlessPi.stripProject(srv.callsOf("report_pickup")[0]!.args), {
		connection_id: CONNECTION,
		work_subject: { kind: "terminal" },
	});
	assert.equal(srv.callsOf("post_session_message").length, 0, "sessionless terminal prompt never attempts room local_prompt mirror");
	sessionlessPi.setIdle(true);
	await sessionlessPi.run("agent_settled", {});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "sessionless terminal complete");
	assert.deepEqual(sessionlessPi.stripProject(srv.callsOf("report_complete")[0]!.args), {
		connection_id: CONNECTION,
		reason: "turn_end",
		attempt_id: "00000000-0000-4000-8000-000000000001",
	});
	await sessionlessPi.shutdown();
	const offlineBeat = srv.callsOf("heartbeat_connection").find((c) => c.args?.status === "offline");
	assert.ok(offlineBeat, "shutdown sends offline heartbeat");
	assert.equal("work_subject" in (offlineBeat.args ?? {}), false, "offline heartbeat must NEVER include work_subject");

	// 2. Attached terminal prompt -> prepareLocalActivity (local_activity_version: 1, no work_subject on pickup)
	//    + work_subject: { kind: "terminal" } on heartbeat/poll; then room command keeps exact command pickup.
	srv.calls.length = 0;
	srv.attachedSessionId = ROOM_SESSION;
	const attachedPi = await loadRemote();
	await attachedPi.start();
	attachedPi.setIdle(false);
	await attachedPi.run("input", { source: "interactive", text: "explain the parser" });
	await attachedPi.run("agent_start", {});
	await attachedPi.run("message_start", { message: { role: "user", content: "explain the parser" } });
	await attachedPi.run("context", { messages: [] });
	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "attached local activity pickup");
	const localPickup = srv.callsOf("report_pickup")[0]!;
	assert.equal(localPickup.args?.local_activity_version, 1);
	assert.equal("work_subject" in (localPickup.args ?? {}), false, "never mix work_subject with local_activity_version");
	const terminalBeat = srv.callsOf("heartbeat_connection").find((c) => c.args?.busy === true && (c.args?.work_subject as { kind?: string } | undefined)?.kind === "terminal");
	assert.ok(terminalBeat, "attached terminal heartbeat carries work_subject: { kind: 'terminal' }");
	assert.deepEqual(terminalBeat.args?.work_subject, { kind: "terminal" });
	attachedPi.setIdle(true);
	await attachedPi.run("agent_settled", {});
	await until(() => srv.callsOf("heartbeat_connection").some((c) => c.args?.busy === false && c.args?.work_subject === null), 2_000, "attached terminal idle clear");

	// 3. Room command -> exact report_pickup({ connection_id, command_turn_id, command_message_id }) without work_subject,
	//    plus work_subject: { kind: "command", id: commandMessageId } on heartbeat/poll.
	srv.calls.length = 0;
	srv.enqueuePoll({
		...canonicalPoll({ senderStyleNegotiated: true }),
		session_id: ROOM_SESSION,
		attached_at: "2026-11-28T00:00:00.000Z",
		speech_attachment_id: "att-1",
	});
	await until(() => attachedPi.sentUserMessages.length === 1, 2_000, "room command delivered");
	const cmdMsg = attachedPi.sentUserMessages[0]!;
	attachedPi.setIdle(false);
	await attachedPi.run("before_agent_start", { prompt: cmdMsg });
	await attachedPi.run("agent_start", {});
	await attachedPi.run("message_start", { message: { role: "user", content: cmdMsg } });
	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "command report_pickup");
	assert.deepEqual(attachedPi.stripProject(srv.callsOf("report_pickup")[0]!.args), {
		connection_id: CONNECTION,
		command_turn_id: IDS.turn,
		command_message_id: IDS.command,
	});
	const cmdBeat = srv.callsOf("heartbeat_connection").find((c) => c.args?.busy === true && (c.args?.work_subject as { kind?: string } | undefined)?.kind === "command");
	assert.deepEqual(cmdBeat?.args?.work_subject, { kind: "command", id: IDS.command });
	attachedPi.setIdle(true);
	await attachedPi.run("agent_settled", {});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "command complete");
});

test("owned background command and async subagents keep working state, work_subject, and advancing progress_marker alive across notice and check-job settles", async () => {
	const pi = await loadRemote();
	await pi.start();

	// Wire a mock background-tasks provider and subagent-fleet RPC on the event bus.
	let bgStatus: "running" | "completed" = "running";
	pi.onBus("pi-background-tasks:request:v1", (raw) => {
		const req = raw as { request_id: string; operation: string };
		if (req.operation === "capabilities") {
			pi.emitBus("pi-background-tasks:response:v1", {
				schema_version: "pi-background-tasks.extension-response.v1",
				request_id: req.request_id,
				operation: "capabilities",
				ok: true,
				result: { api_version: 1, status: true },
			});
		} else if (req.operation === "status") {
			pi.emitBus("pi-background-tasks:response:v1", {
				schema_version: "pi-background-tasks.extension-response.v1",
				request_id: req.request_id,
				operation: "status",
				ok: true,
				result: { tasks: [{ id: "bg-1", startTime: 1_000, status: bgStatus }] },
			});
		}
	});
	let activeSubagents = 0;
	pi.onBus("subagents:rpc:v1:request", (raw) => {
		const req = raw as { requestId: string; method: string };
		if (req.method === "ping") {
			pi.emitBus(`subagents:rpc:v1:reply:${req.requestId}`, { version: 1, success: true, data: { capabilities: { fleetStatus: { version: 1 } } } });
		} else if (req.method === "status") {
			pi.emitBus(`subagents:rpc:v1:reply:${req.requestId}`, {
				version: 1,
				success: true,
				data: {
					fleet: {
						version: 1,
						totalActive: activeSubagents,
						omitted: 0,
						entries: activeSubagents > 0 ? [{ key: "k1", agent: "verifier", startedAt: Date.now() - 1000 }] : [],
					},
				},
			});
		}
	});

	// Start a server_notice turn that launches a background test command and settles while it runs.
	const prNotice = {
		version: 1 as const,
		kind: "server_notice" as const,
		notice_id: SERVER_NOTICE_ID,
		topic: "coherence_finding",
		notice_type: "pr_requirement_break",
		summary: "Run full test suite",
		prompt: "Fix and verify.",
		contract_uri: "devspec://product/remote-ingress-contract" as const,
		records: [{ label: "Requirement", record_type: "memory", record_id: IDS.project, title: "Tests pass", text: "Tests must pass.", url: null }],
		allowed_outcomes: ["fixed_on_branch"],
		allowed_tools: ["record_implementation"],
		audience: "for_the_record" as const,
	};
	srv.enqueuePoll({
		...canonicalPoll({ senderStyleNegotiated: true, wakeKind: "system_notice", systemNotices: [prNotice as never] }),
		session_id: ROOM_SESSION,
		attached_at: "2026-11-28T00:00:00.000Z",
		speech_attachment_id: "att-1",
	});
	await until(() => pi.sentCustomMessages.length === 1, 2_000, "notice delivered");
	const custom = pi.sentCustomMessages[0]!;

	pi.setIdle(false);
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "custom", customType: custom.customType, content: custom.content, details: custom.details } });
	await pi.run("tool_execution_start", { toolCallId: "bg-call", toolName: "bg_run", args: { command: "npm test" } });
	await pi.run("tool_execution_end", {
		toolCallId: "bg-call",
		toolName: "bg_run",
		result: { details: { task: { id: "bg-1", startTime: 1_000, status: "running", notifyOnCompletion: true, triggerOnCompletion: true } } },
		isError: false,
	});
	pi.setIdle(true);
	await pi.run("agent_settled", {});

	// Working state AND work_subject MUST remain alive while bg-1 is running!
	assert.equal(srv.callsOf("report_complete").length, 0, "must NOT complete while owned bg_run is still running");
	await until(() => srv.callsOf("heartbeat_connection").some((c) => c.args?.busy === true && (c.args?.work_subject as { id?: string } | undefined)?.id === SERVER_NOTICE_ID), 2_000, "live busy heartbeat with notice work_subject");
	const pollsBeforeBg = srv.callsOf("poll_connection").length;
	srv.wake();
	await until(
		() => srv.callsOf("poll_connection").slice(pollsBeforeBg).some((c) => c.args?.busy === true && (c.args?.work_subject as { id?: string } | undefined)?.id === SERVER_NOTICE_ID),
		2_000,
		"poll while bg task runs",
	);
	const poll1 = srv.callsOf("poll_connection").slice(pollsBeforeBg).find((c) => c.args?.busy === true && (c.args?.work_subject as { id?: string } | undefined)?.id === SERVER_NOTICE_ID)!;
	assert.equal(poll1.args?.busy, true);
	assert.deepEqual(poll1.args?.work_subject, { kind: "server_notice", id: SERVER_NOTICE_ID });

	// Another safety poll while bg-1 is UNCHANGED ("running") keeps working + work_subject
	// alive WITHOUT artificially advancing progress_marker (so a wedged process respects the 24h cutoff).
	const pollsSecond = srv.callsOf("poll_connection").length;
	srv.wake();
	await until(
		() => srv.callsOf("poll_connection").slice(pollsSecond).some((c) => c.args?.busy === true && (c.args?.work_subject as { id?: string } | undefined)?.id === SERVER_NOTICE_ID),
		2_000,
		"second poll while bg task unchanged",
	);
	const poll2 = srv.callsOf("poll_connection").slice(pollsSecond).find((c) => c.args?.busy === true && (c.args?.work_subject as { id?: string } | undefined)?.id === SERVER_NOTICE_ID)!;
	assert.equal(poll2.args?.progress_marker, poll1.args?.progress_marker, "unchanged running background observation must NOT advance progress_marker");

	// Complete bg-1 -> completeObservedIdle closes the exact source-less attempt_id and clears work_subject!
	bgStatus = "completed";
	pi.emitBus("pi-background-tasks:terminal:v1", {
		schema_version: "pi-background-tasks.extension-terminal.v1",
		task: { id: "bg-1", startTime: 1_000, status: "completed" },
	});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "complete after bg task ends");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_complete")[0]!.args), {
		connection_id: CONNECTION,
		reason: "turn_end",
		attempt_id: "00000000-0000-4000-8000-000000000001",
	});
	await until(() => srv.callsOf("heartbeat_connection").some((c) => c.args?.busy === false && c.args?.work_subject === null), 2_000, "idle clear after bg task ends");

	// Now verify async subagent fleet keeps a check_job turn alive across settle and closes on completion wake.
	srv.calls.length = 0;
	activeSubagents = 1;
	const checkEnvelope = {
		id: CHECK_JOB_ID,
		kind: "check_job",
		check_job_id: CHECK_JOB_ID,
		check_kind: "conflict_decisions",
		record: { type: "task", id: "9b2d6c1e-1111-4222-8333-444455556666", title: "Subagent check" },
		entries: 1,
		yours: false,
		offered_at: "2026-11-28T02:00:00.000Z",
		delivery_connection_id: CONNECTION,
	};
	srv.rememberDispatch(CHECK_JOB_ID, checkEnvelope);
	srv.enqueuePoll({
		connection_id: CONNECTION,
		session_id: ROOM_SESSION,
		attached_at: "2026-11-28T00:00:00.000Z",
		speech_attachment_id: "att-1",
		changed: false,
		dispatches: [checkEnvelope],
		dispatch_cursor: "disp-sub-1",
		cursor_v2: null,
		system_notice_version: 3,
		system_notice_cursor: null,
		system_notices: [],
	});
	await until(() => pi.sentUserMessages.length === 1, 2_000, "check job delivered for subagent test");
	const checkMsg = pi.sentUserMessages[0]!;
	pi.setIdle(false);
	await pi.run("before_agent_start", { prompt: checkMsg });
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "user", content: checkMsg } });
	pi.setIdle(true);
	await pi.run("agent_settled", {});

	assert.equal(srv.callsOf("report_complete").length, 0, "must NOT complete while async subagent is active");
	const subPollIdx = srv.callsOf("poll_connection").length;
	srv.wake();
	await until(
		() => {
			if (srv.callsOf("poll_connection").slice(subPollIdx).some((c) => c.args?.busy === true && (c.args?.work_subject as { id?: string } | undefined)?.id === CHECK_JOB_ID)) return true;
			srv.wake();
			return false;
		},
		2_000,
		"poll while subagent active",
	);
	const subBusyPoll = srv.callsOf("poll_connection").slice(subPollIdx).find((c) => c.args?.busy === true && (c.args?.work_subject as { id?: string } | undefined)?.id === CHECK_JOB_ID)!;
	assert.equal(subBusyPoll.args?.busy, true);
	assert.deepEqual(subBusyPoll.args?.work_subject, { kind: "check_job", id: CHECK_JOB_ID });

	// Subagent finishes and wakes Pi -> completion wake settles and closes the check_job attempt!
	activeSubagents = 0;
	pi.setIdle(false);
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "custom", customType: "subagent-notify", content: "Background task completed: **verifier**\n\nAll good." } });
	pi.setIdle(true);
	await pi.run("agent_settled", {});
	await until(() => srv.callsOf("report_complete").length === 1, 2_000, "report_complete after subagent completion wake");
	assert.deepEqual(pi.stripProject(srv.callsOf("report_complete")[0]!.args), {
		connection_id: CONNECTION,
		reason: "turn_end",
		attempt_id: "00000000-0000-4000-8000-000000000002",
	});
	await until(() => srv.callsOf("heartbeat_connection").some((c) => c.args?.busy === false && c.args?.work_subject === null), 2_000, "idle clear after subagent finishes");
});

test("non-command phase:'trail' is fenced on confirmed report_pickup attempt_id and never posts when pickup fails", async () => {
	srv.failNonCommandPickup = true;
	const pi = await loadRemote();
	await pi.start();
	const checkEnvelope = {
		id: CHECK_JOB_ID,
		kind: "check_job",
		check_job_id: CHECK_JOB_ID,
		check_kind: "conflict_decisions",
		record: { type: "task", id: "9b2d6c1e-1111-4222-8333-444455556666", title: "Pickup failure fence" },
		entries: 1,
		yours: false,
		offered_at: "2026-11-28T02:00:00.000Z",
		delivery_connection_id: CONNECTION,
	};
	srv.rememberDispatch(CHECK_JOB_ID, checkEnvelope);
	srv.enqueuePoll({
		connection_id: CONNECTION,
		session_id: ROOM_SESSION,
		attached_at: "2026-11-28T00:00:00.000Z",
		speech_attachment_id: "att-1",
		changed: false,
		dispatches: [checkEnvelope],
		dispatch_cursor: "disp-fail-1",
		cursor_v2: null,
		system_notice_version: 3,
		system_notice_cursor: null,
		system_notices: [],
	});
	await until(() => pi.sentUserMessages.length === 1, 2_000, "check job delivered");
	const wakeMsg = pi.sentUserMessages[0]!;
	pi.setIdle(false);
	await pi.run("before_agent_start", { prompt: wakeMsg });
	await pi.run("agent_start", {});
	await pi.run("message_start", { message: { role: "user", content: wakeMsg } });
	await pi.run("tool_execution_start", { toolCallId: "f1", toolName: "read", args: { path: "docs/spec.md" } });
	await pi.run("tool_execution_end", { toolCallId: "f1", toolName: "read", result: { content: [] }, isError: false });
	await until(() => srv.callsOf("report_pickup").length === 1, 2_000, "failed pickup attempted");
	pi.setIdle(true);
	await pi.run("agent_settled", {});
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(srv.callsOf("post_session_message").length, 0, "failed non-command pickup must NEVER post phase:trail (could fall back to an unrelated room command)");
	assert.equal(srv.callsOf("report_complete").length, 0, "failed non-command pickup must NEVER emit generic report_complete");
});
