/**
 * Item dffdc30a: interactive Pi must never hold the first prompt for minutes
 * when DevSpec accepts connections but never answers. Ali Price's limits
 * (13 Nov 2026): start-up waits at most 30 s for DevSpec, says once that it
 * could not be reached, then tries again every 30 s in the background.
 *
 * Pi takes no prompt until every session_start handler has returned, so these
 * tests run the real remote extension's session_start against a scripted
 * DevSpec and time when it returns. The limits are shortened through the
 * test-only override so nothing waits 30 real seconds.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	callDevspec,
	DevspecRateLimitError,
	DevspecUnreachableError,
	isRecoverableTransportError,
	resetClientCache,
	setLaneClientFactoryForTests,
	type LaneClient,
} from "../extensions/core/client.ts";
import { getBond, setBond } from "../extensions/core/bond-state.ts";
import {
	BackgroundConnect,
	DEVSPEC_REACH_LIMIT_MS,
	DEVSPEC_REACHABLE_EVENT,
	DEVSPEC_RETRY_INTERVAL_MS,
	DEVSPEC_UNREACHABLE_NOTICE,
	reachTiming,
	setReachTimingForTests,
	type BackgroundConnectStep,
} from "../extensions/core/startup-connect.ts";

const PROJECT = { id: "abababab-abab-4bab-8bab-abababababab", name: "Website", organization: { id: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd", name: "Agency" } };
const CONNECTION = "11111111-1111-4111-8111-111111111111";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, withinMs: number, what: string): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > withinMs) assert.fail(`timed out waiting for ${what}`);
		await delay(10);
	}
}

function text(data: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** A scripted DevSpec reached through the lane client factory, one behaviour at a time. */
class ScriptedDevspec {
	mode: "hang" | "refuse" | "answer" | "refuse_register" = "hang";
	handshakes = 0;
	readonly calls: string[] = [];

	install(): void {
		setLaneClientFactoryForTests(async () => {
			this.handshakes += 1;
			// Accepts the connection and never replies, as in the observed incident.
			if (this.mode === "hang") return new Promise<LaneClient>(() => {});
			// What Node's fetch reports for a refused connection.
			if (this.mode === "refuse") throw new TypeError("fetch failed");
			return this.client();
		});
	}

	private client(): LaneClient {
		return {
			callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
				this.calls.push(name);
				if (this.mode === "hang") return new Promise(() => {});
				if (name === "register_connection") {
					if (this.mode === "refuse_register") return { isError: true, content: [{ type: "text", text: "This folder is not linked to a DevSpec project you can use." }] };
					return {
						...text({
							connection_id: CONNECTION,
							project_id: PROJECT.id,
							codename: "Amber Hawk",
							session_id: null,
							project_selection: { version: 1, status: "resolved", source: "folder_pin", project: PROJECT },
						}),
						_meta: { devspec: { connection_capability: { version: 1, value: "dvsc_fixture_only_12345678901234567890" } } },
					};
				}
				if (name === "poll_connection") {
					await delay(30);
					// An idle lap that answers exactly what was negotiated.
					return text({
						connection_id: args?.connection_id, session_id: null, changed: false, dispatches: [], dispatch_cursor: null, cursor_v2: null,
						...(args?.system_notice_version === undefined ? {} : { system_notice_version: args.system_notice_version, system_notice_cursor: null, system_notices: [] }),
					});
				}
				return text({ success: true });
			},
			readResource: async () => ({ contents: [] }),
			close: async () => {},
		};
	}

	registrations(): number {
		return this.calls.filter((name) => name === "register_connection").length;
	}
}

interface Harness {
	start: () => Promise<void>;
	shutdown: () => Promise<void>;
	command: (name: string, args: string) => Promise<void>;
	notices: Array<{ message: string; level: string }>;
	/** Channels emitted on Pi's shared event bus. */
	emitted: string[];
}

let dir: string;
const saved = { token: process.env.DEVSPEC_MCP_TOKEN, url: process.env.DEVSPEC_MCP_URL, agentDir: process.env.PI_CODING_AGENT_DIR };
let shutdowns: Array<() => Promise<void>> = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "devspec-startup-connect-"));
	process.env.DEVSPEC_MCP_TOKEN = "test-only-token";
	// Nothing listens on port 1: the pump's wake channel is refused at once.
	process.env.DEVSPEC_MCP_URL = "http://127.0.0.1:1/api/mcp";
	process.env.PI_CODING_AGENT_DIR = dir;
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	setBond(null);
	resetClientCache();
	shutdowns = [];
});

afterEach(async () => {
	for (const shutdown of shutdowns) await shutdown();
	setLaneClientFactoryForTests(null);
	setReachTimingForTests(null);
	resetClientCache();
	setBond(null);
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	for (const [key, value] of [["DEVSPEC_MCP_TOKEN", saved.token], ["DEVSPEC_MCP_URL", saved.url], ["PI_CODING_AGENT_DIR", saved.agentDir]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(dir, { recursive: true, force: true });
});

/** The real remote extension, loaded fresh, with an interactive Pi session around it. */
async function loadRemote(): Promise<Harness> {
	const { default: remote } = await import(`../extensions/devspec-remote.ts?fresh=${Math.random()}`);
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const entries: unknown[] = [];
	const emitted: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, spec.handler),
		registerFlag: () => {},
		getFlag: () => undefined,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		events: { on: () => () => {}, emit: (channel: string) => emitted.push(channel) },
		getActiveTools: () => [],
		setActiveTools: () => {},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	remote(pi);
	const notices: Array<{ message: string; level: string }> = [];
	const ctx = {
		cwd: dir,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		abort: () => {},
		model: undefined,
		getContextUsage: () => undefined,
		sessionManager: {
			getSessionId: () => "local-session-1",
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionFile: () => undefined,
			getCwd: () => dir,
		},
		ui: {
			notify: (message: string, level = "info") => notices.push({ message, level }),
			setStatus: () => {},
			setWidget: () => {},
			theme: { fg: (_role: string, value: string) => value },
		},
	} as unknown as ExtensionContext;
	const run = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	let shut = false;
	const harness: Harness = {
		start: () => run("session_start", { type: "session_start", reason: "startup" }),
		shutdown: async () => {
			if (shut) return;
			shut = true;
			await run("session_shutdown", { type: "session_shutdown" });
		},
		command: (name, args) => commands.get(name)!(args, ctx),
		notices,
		emitted,
	};
	shutdowns.push(harness.shutdown);
	return harness;
}

async function timed(work: () => Promise<void>): Promise<number> {
	const started = Date.now();
	await work();
	return Date.now() - started;
}

test("Ali's limits: start-up waits at most 30 s for DevSpec and retries every 30 s", () => {
	assert.equal(DEVSPEC_REACH_LIMIT_MS, 30_000);
	assert.equal(DEVSPEC_RETRY_INTERVAL_MS, 30_000);
	assert.deepEqual(reachTiming(), { limitMs: 30_000, intervalMs: 30_000 });
});

test("a DevSpec that never answers: start-up gives up at the limit, says so once, and connects in the background once DevSpec answers", async () => {
	setReachTimingForTests({ limitMs: 300, intervalMs: 200 });
	const devspec = new ScriptedDevspec();
	devspec.install();
	const pi = await loadRemote();

	const startup = await timed(pi.start);
	assert.ok(startup >= 250, `gave up before the limit (${startup}ms)`);
	assert.ok(startup < 1_500, `start-up held the first prompt for ${startup}ms against a 300ms limit`);
	assert.deepEqual(pi.notices, [{ message: DEVSPEC_UNREACHABLE_NOTICE, level: "warning" }]);
	assert.equal(getBond(), null);
	// One handshake, abandoned at the limit: no second full wait inside start-up.
	assert.equal(devspec.handshakes, 1);

	// Still unanswered: background attempts keep going, silently, one at a time.
	await until(() => devspec.handshakes >= 3, 3_000, "background attempts");
	assert.equal(pi.notices.length, 1, "background failures are not announced again");

	devspec.mode = "answer";
	await until(() => pi.notices.length > 1, 3_000, "background connection");
	assert.equal(getBond()?.connectionId, CONNECTION);
	assert.match(pi.notices.at(-1)!.message, /auto-bonded as Amber Hawk — you're reachable from the Agents page/);
	assert.equal(pi.notices.filter((notice) => notice.message === DEVSPEC_UNREACHABLE_NOTICE).length, 1);
	assert.deepEqual(pi.emitted, [DEVSPEC_REACHABLE_EVENT], "the sign-in footer hears that DevSpec answers again");

	// Connected: the retries stop.
	const registered = devspec.registrations();
	await delay(600);
	assert.equal(devspec.registrations(), registered);
});

test("a DevSpec that refuses connections still lets the first prompt run at once", async () => {
	setReachTimingForTests({ limitMs: 5_000, intervalMs: 5_000 });
	const devspec = new ScriptedDevspec();
	devspec.mode = "refuse";
	devspec.install();
	const pi = await loadRemote();

	const startup = await timed(pi.start);
	assert.ok(startup < 1_000, `a refused connection held start-up for ${startup}ms`);
	assert.deepEqual(pi.notices, [{ message: DEVSPEC_UNREACHABLE_NOTICE, level: "warning" }]);
	assert.equal(getBond(), null);
});

test("a healthy DevSpec: start-up connects automatically, exactly as before, with no retry left running", async () => {
	setReachTimingForTests({ limitMs: 5_000, intervalMs: 150 });
	const devspec = new ScriptedDevspec();
	devspec.mode = "answer";
	devspec.install();
	const pi = await loadRemote();

	await pi.start();
	assert.equal(getBond()?.connectionId, CONNECTION);
	assert.equal(getBond()?.projectId, PROJECT.id);
	assert.equal(pi.notices.length, 1);
	assert.match(pi.notices[0]!.message, /^DevSpec remote: auto-bonded as Amber Hawk — you're reachable from the Agents page\./);
	await delay(400);
	assert.equal(devspec.registrations(), 1);
});

test("a DevSpec that answers with a refusal is reported at start-up and not retried", async () => {
	setReachTimingForTests({ limitMs: 5_000, intervalMs: 150 });
	const devspec = new ScriptedDevspec();
	devspec.mode = "refuse_register";
	devspec.install();
	const pi = await loadRemote();

	await pi.start();
	assert.equal(getBond(), null);
	assert.equal(pi.notices.length, 1);
	assert.match(pi.notices[0]!.message, /^DevSpec remote: auto-bond failed: This folder is not linked/);
	assert.equal(pi.notices[0]!.level, "error");
	await delay(400);
	assert.equal(devspec.registrations(), 1);
});

test("/devspec.remote stop ends the background retries", async () => {
	setReachTimingForTests({ limitMs: 100, intervalMs: 100 });
	const devspec = new ScriptedDevspec();
	devspec.install();
	const pi = await loadRemote();

	await pi.start();
	await pi.command("devspec.remote", "stop");
	assert.match(pi.notices.at(-1)!.message, /stopped trying to connect/);
	const handshakes = devspec.handshakes;
	devspec.mode = "answer";
	await delay(400);
	assert.equal(devspec.handshakes, handshakes);
	assert.equal(getBond(), null);
});

test("a handshake that never answers is bounded by the call's timeout, and the next attempt opens a fresh one", async () => {
	let opened = 0;
	setLaneClientFactoryForTests(async () => {
		opened += 1;
		if (opened === 1) return new Promise<LaneClient>(() => {});
		return { callTool: async () => text({ ok: true }), readResource: async () => ({ contents: [] }), close: async () => {} };
	});
	const elapsed = await timed(async () => {
		await callDevspec("tok", "get_project_summary", {}, { timeoutMs: 100 });
	});
	assert.equal(opened, 2);
	assert.ok(elapsed < 1_000, `hung handshake held the call for ${elapsed}ms`);
});

test("a deadline bounds the whole call, its transport retry included", async () => {
	let calls = 0;
	setLaneClientFactoryForTests(async () => ({
		callTool: () => { calls += 1; return new Promise(() => {}); },
		readResource: async () => ({ contents: [] }),
		close: async () => {},
	}));
	let failure: unknown;
	const elapsed = await timed(async () => {
		failure = await callDevspec("tok", "register_connection", {}, { lane: "pump", deadline: Date.now() + 200 }).catch((err) => err);
	});
	assert.ok(failure instanceof DevspecUnreachableError, String(failure));
	assert.ok(isRecoverableTransportError(failure));
	assert.equal(calls, 1, "no second attempt once the deadline has passed");
	assert.ok(elapsed >= 150 && elapsed < 1_000, `deadline call took ${elapsed}ms`);
});

test("a deadline never waits out a rate-limit cooldown it cannot fit", async () => {
	setLaneClientFactoryForTests(async () => ({
		callTool: async () => { throw new Error("Rate limit exceeded. Retry after 5 seconds."); },
		readResource: async () => ({ contents: [] }),
		close: async () => {},
	}));
	const elapsed = await timed(async () => {
		await assert.rejects(callDevspec("tok", "get_project_summary", {}, { deadline: Date.now() + 1_000 }), DevspecRateLimitError);
	});
	assert.ok(elapsed < 500, `waited ${elapsed}ms for a cooldown past the deadline`);
	(globalThis as unknown as Record<string, { until: number }>).__devspecPiRateLimit!.until = 0;
});

test("a call with a deadline on a healthy DevSpec returns its result unchanged", async () => {
	setLaneClientFactoryForTests(async () => ({
		callTool: async ({ name }: { name: string }) => text({ answered: name }),
		readResource: async () => ({ contents: [] }),
		close: async () => {},
	}));
	const raw = await callDevspec("tok", "get_project_summary", {}, { deadline: Date.now() + 1_000 });
	assert.deepEqual(raw, text({ answered: "get_project_summary" }));
});

test("an attempt nobody is watching never opens the project chooser, and a concurrent one is told it is busy", async () => {
	const { installProjectSelection } = await import("../extensions/core/project-selection-ui.ts");
	const selects: string[][] = [];
	const reaches: Array<number | undefined> = [];
	let finish: () => void = () => {};
	const choiceRequired = { version: 1 as const, status: "choice_required" as const, reason: "ambiguous_remote", candidates: [PROJECT] };
	const pi = { registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {}, registerCommand: () => {} } as unknown as ExtensionAPI;
	const ctx = {
		cwd: dir, mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: { getSessionId: () => "local-A", getEntries: () => [] },
		ui: { setStatus: () => {}, notify: () => {}, select: async (_title: string, options: string[]) => { selects.push(options); return options[0]; } },
	} as unknown as ExtensionContext;
	const selection = installProjectSelection(pi, {
		attempt: async (_ctx, _room, _project, reach) => {
			reaches.push(reach?.reachLimitMs);
			if (reaches.length === 2) await new Promise<void>((resolve) => { finish = resolve; });
			return { ok: false, projectChoice: choiceRequired };
		},
		stop: async () => {},
	});
	const unattended = await selection.connect(ctx, undefined, undefined, { reachLimitMs: 30_000, pickProject: false });
	assert.equal(unattended.ok, false);
	assert.deepEqual(unattended.projectChoice, choiceRequired);
	assert.deepEqual(selects, [], "no chooser opened");
	assert.deepEqual(reaches, [30_000]);

	const first = selection.connect(ctx, undefined, undefined, { reachLimitMs: 30_000, pickProject: false });
	await delay(0);
	const second = await selection.connect(ctx);
	assert.equal(second.busy, true);
	finish();
	await first;
});

test("the sign-in check's \"offline?\" mark clears once a background attempt reaches DevSpec", async () => {
	const { default: auth } = await import(`../extensions/devspec-auth.ts?fresh=${Math.random()}`);
	setLaneClientFactoryForTests(async () => { throw new TypeError("fetch failed"); });
	const listeners = new Map<string, (data: unknown) => void>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	auth({
		registerCommand: () => {},
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(name, handler),
		events: { on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, handler); return () => {}; }, emit: () => {} },
	} as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	const ctx = { hasUI: true, mode: "tui", ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value), notify: () => {} } };
	await handlers.get("session_start")!({}, ctx);
	await until(() => statuses.at(-1) === "DevSpec: offline?", 2_000, "the offline mark");
	listeners.get(DEVSPEC_REACHABLE_EVENT)!({});
	assert.equal(statuses.at(-1), undefined);
});

/** Manual timers: nothing runs until the test fires it. */
function manualClock() {
	let now = 0;
	const timers: Array<{ at: number; run: () => void; id: number }> = [];
	let nextId = 1;
	return {
		now: () => now,
		setTimer: (run: () => void, ms: number) => { const id = nextId++; timers.push({ at: now + ms, run, id }); return id; },
		clearTimer: (id: unknown) => { const at = timers.findIndex((timer) => timer.id === id); if (at >= 0) timers.splice(at, 1); },
		pending: () => timers.map((timer) => timer.at - now),
		/** Move time forward to the next timer and run it. */
		async fire(): Promise<void> {
			timers.sort((a, b) => a.at - b.at);
			const next = timers.shift();
			assert.ok(next, "no timer scheduled");
			now = next.at;
			next.run();
			await delay(0);
		},
		advance(ms: number) { now += ms; },
	};
}

test("background attempts start one interval apart, never overlap, and stop once one is done", async () => {
	const clock = manualClock();
	const steps: BackgroundConnectStep[] = ["retry", "retry", "done"];
	const starts: number[] = [];
	let running = 0;
	let overlapped = false;
	const retry = new BackgroundConnect({
		intervalMs: 30_000,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		attempt: async () => {
			starts.push(clock.now());
			running += 1;
			if (running > 1) overlapped = true;
			// The second attempt waits on DevSpec for 30 s before giving up.
			if (starts.length === 2) clock.advance(30_000);
			running -= 1;
			return steps.shift()!;
		},
	});
	retry.start();
	assert.deepEqual(clock.pending(), [30_000], "the first attempt comes one interval after start-up gave up");
	await clock.fire();
	assert.deepEqual(clock.pending(), [30_000]);
	await clock.fire();
	// That attempt used the whole interval, so the next one starts straight away.
	assert.deepEqual(clock.pending(), [0]);
	await clock.fire();
	assert.deepEqual(starts, [30_000, 60_000, 90_000]);
	assert.equal(overlapped, false);
	assert.equal(retry.active, false);
	assert.deepEqual(clock.pending(), []);
});

test("cancelling stops background attempts, and a cancelled attempt cannot reschedule", async () => {
	const clock = manualClock();
	let attempts = 0;
	let release: (step: BackgroundConnectStep) => void = () => {};
	const retry = new BackgroundConnect({
		intervalMs: 1_000,
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		attempt: () => { attempts += 1; return new Promise<BackgroundConnectStep>((resolve) => { release = resolve; }); },
	});
	retry.start();
	await clock.fire();
	assert.equal(attempts, 1);
	retry.cancel();
	release("retry");
	await delay(0);
	assert.equal(retry.active, false);
	assert.deepEqual(clock.pending(), []);
	retry.cancel();
	retry.start();
	assert.deepEqual(clock.pending(), [1_000]);
	retry.cancel();
	assert.deepEqual(clock.pending(), []);
});
