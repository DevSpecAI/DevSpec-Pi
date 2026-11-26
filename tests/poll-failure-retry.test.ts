/**
 * Item da977c8d: a room check-in that fails without ending the bond is retried
 * after its back-off, not after the next push wake or the 45-second safety tick.
 * The wake that started the failed lap was already used up, so without the owed
 * retry a message DevSpec had announced could wait up to another 45 seconds.
 *
 * Runs devspec-remote.ts against a scripted DevSpec with an SSE push channel,
 * the same shape as tests/pump-token-renewal.test.ts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetClientCache, setLaneClientFactoryForTests, type LaneClient } from "../extensions/core/client.ts";
import { getBond, setBond } from "../extensions/core/bond-state.ts";
import { saveLogin } from "../extensions/core/auth-store.ts";
import { PUSH_SAFETY_MS, pollCheckedNothing, pollFailureBackoffMs } from "../extensions/devspec-remote.ts";

const PROJECT = {
	id: "abababab-abab-4bab-8bab-abababababab",
	name: "Website",
	organization: { id: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd", name: "Agency" },
};
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const HOUR = 60 * 60 * 1000;
/** The first back-off, read from the real curve rather than restated. */
const FIRST_BACKOFF_MS = pollFailureBackoffMs(1);
/** Scheduling slack for a loaded CI runner; far below the 45 s the bug cost. */
const SLACK_MS = 2_500;

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

class ScriptedDevspec {
	private server!: Server;
	private readonly streams = new Set<ServerResponse>();
	mcpUrl = "";
	/** When each poll_connection call reached the server, and whether it was answered. */
	readonly polls: Array<{ at: number; failed: boolean }> = [];
	/** The next this-many poll_connection calls time out (the client retries a timeout once). */
	failNextPolls = 0;
	/** What the next "nothing new" answers say about their own check, in order; empty = field absent. */
	markerReads: Array<"ok" | "unavailable"> = [];

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

	wake(): void {
		for (const stream of this.streams) stream.write("event: wake\ndata: {}\n\n");
	}

	async stop(): Promise<void> {
		for (const stream of this.streams) stream.end();
		this.streams.clear();
		this.server.closeAllConnections?.();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	installLaneFactory(): void {
		setLaneClientFactoryForTests(async (): Promise<LaneClient> => ({
			callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
				if (name === "register_connection") {
					return {
						...text({
							connection_id: CONNECTION,
							project_id: PROJECT.id,
							codename: "Drifting Hare",
							session_id: null,
							project_selection: { version: 1, status: "resolved", source: "folder_pin", project: PROJECT },
						}),
						_meta: { devspec: { connection_capability: { version: 1, value: "dvsc_cap_1_12345678901234567890" } } },
					};
				}
				if (name === "poll_connection") {
					if (this.failNextPolls > 0) {
						this.failNextPolls -= 1;
						this.polls.push({ at: Date.now(), failed: true });
						throw new Error("poll_connection timed out");
					}
					const markerRead = this.markerReads.shift();
					this.polls.push({ at: Date.now(), failed: markerRead === "unavailable" });
					return text({
						connection_id: args?.connection_id ?? CONNECTION,
						session_id: null,
						changed: false,
						...(markerRead ? { marker_read: markerRead } : {}),
						dispatches: [],
						dispatch_cursor: null,
						cursor_v2: null,
						...(args?.system_notice_version === undefined
							? {}
							: { system_notice_version: args.system_notice_version, system_notice_cursor: null, system_notices: [] }),
					});
				}
				return text({ success: true });
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
	dir = await mkdtemp(join(tmpdir(), "devspec-poll-retry-"));
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
	const entries: unknown[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		events: { on: () => () => {}, emit: () => {} },
		getActiveTools: () => [],
		setActiveTools: () => {},
		getAllTools: () => [],
		getThinkingLevel: () => "off",
		sendMessage: () => {},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	remote(pi);
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
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, theme: { fg: (_role: string, value: string) => value } },
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
	return { start: () => run("session_start", { type: "session_start", reason: "startup" }) };
}

/** Wake the pump into a check-in that times out (both client attempts), and return when it failed. */
async function failOneCheckIn(): Promise<number> {
	const before = srv.polls.length;
	srv.failNextPolls = 2;
	srv.wake();
	await until(() => srv.polls.length >= before + 2, 3_000, "the timed-out check-in");
	return srv.polls[srv.polls.length - 1]!.at;
}

test("the back-off starts at five seconds, doubles, and never exceeds the safety interval", () => {
	const curve = [1, 2, 3, 4, 5, 6, 50].map(pollFailureBackoffMs);
	assert.deepEqual(curve, [5_000, 10_000, 20_000, 40_000, PUSH_SAFETY_MS, PUSH_SAFETY_MS, PUSH_SAFETY_MS]);
	assert.equal(pollFailureBackoffMs(0), 5_000, "no failure recorded still waits the first gap");
	assert.equal(pollFailureBackoffMs(Number.NaN), 5_000);
});

test("a timed-out check-in is retried after its back-off without another wake, and a handled one resets the back-off", async () => {
	const pi = await loadRemote();
	await pi.start();
	assert.equal(getBond()?.connectionId, CONNECTION);
	await until(() => srv.polls.some((p) => !p.failed), 3_000, "first check-in");
	await delay(100); // the pump is back waiting for a wake

	// First failure: the retry comes after the first back-off, with no wake sent.
	const failedAt = await failOneCheckIn();
	await until(() => srv.polls.length > 0 && !srv.polls[srv.polls.length - 1]!.failed && srv.polls[srv.polls.length - 1]!.at > failedAt,
		FIRST_BACKOFF_MS + SLACK_MS, "the owed retry");
	const retriedAfter = srv.polls[srv.polls.length - 1]!.at - failedAt;
	assert.ok(retriedAfter >= FIRST_BACKOFF_MS - 250, `retried before its back-off (${retriedAfter} ms)`);

	// The retry used up the owed check-in: the pump goes back to waiting quietly.
	const settled = srv.polls.length;
	await delay(1_500);
	assert.equal(srv.polls.length, settled, "no extra check-ins once the retry succeeded");

	// The handled package reset the streak, so the next failure waits the first gap
	// again, not the doubled one.
	const failedAgainAt = await failOneCheckIn();
	await until(() => !srv.polls[srv.polls.length - 1]!.failed && srv.polls[srv.polls.length - 1]!.at > failedAgainAt,
		FIRST_BACKOFF_MS + SLACK_MS, "the second owed retry at the first back-off");
	assert.equal(getBond()?.connectionId, CONNECTION, "the bond survived both failures");
});

test("only an explicit unchecked no-change answer counts as a failed check-in", () => {
	assert.equal(pollCheckedNothing({ changed: false, marker_read: "unavailable" }), true);
	assert.equal(pollCheckedNothing({ changed: false, marker_read: "ok" }), false);
	// An older server sends no marker_read: its no-change answer is trusted as before.
	assert.equal(pollCheckedNothing({ changed: false }), false);
	assert.equal(pollCheckedNothing({ changed: true, marker_read: "unavailable" }), false);
	assert.equal(pollCheckedNothing(null), false);
});

test("a no-change answer that checked nothing is retried on the growing back-off, without another wake", async () => {
	const pi = await loadRemote();
	await pi.start();
	await until(() => srv.polls.some((p) => !p.failed), 3_000, "first check-in");
	await delay(100);

	// Two unchecked answers in a row, then a real one: the retries come at the first
	// and then the doubled back-off, so the streak was not reset by the unchecked one.
	srv.markerReads = ["unavailable", "unavailable", "ok"];
	const before = srv.polls.length;
	srv.wake();
	await until(() => srv.polls.length >= before + 1, 3_000, "the unchecked answer");
	const firstAt = srv.polls[before]!.at;
	await until(() => srv.polls.length >= before + 2, FIRST_BACKOFF_MS + SLACK_MS, "the first owed retry");
	const secondAt = srv.polls[before + 1]!.at;
	assert.ok(secondAt - firstAt >= FIRST_BACKOFF_MS - 250, `retried before the first back-off (${secondAt - firstAt} ms)`);
	await until(() => srv.polls.length >= before + 3, pollFailureBackoffMs(2) + SLACK_MS, "the second owed retry");
	const thirdAt = srv.polls[before + 2]!.at;
	assert.ok(thirdAt - secondAt >= pollFailureBackoffMs(2) - 250, `the streak reset on an unchecked answer (${thirdAt - secondAt} ms)`);

	// The checked answer ends it: nothing more until something wakes the pump.
	const settled = srv.polls.length;
	await delay(1_500);
	assert.equal(srv.polls.length, settled, "no extra check-ins after a checked answer");
});

test("a checked no-change answer, and one from an older server without the field, are trusted as before", async () => {
	const pi = await loadRemote();
	await pi.start();
	await until(() => srv.polls.some((p) => !p.failed), 3_000, "first check-in");
	await delay(100);
	for (const markerRead of ["ok", undefined] as const) {
		srv.markerReads = markerRead ? [markerRead] : [];
		const before = srv.polls.length;
		srv.wake();
		await until(() => srv.polls.length >= before + 1, 3_000, `the ${markerRead ?? "field-less"} answer`);
		await delay(1_500);
		assert.equal(srv.polls.length, before + 1, `a ${markerRead ?? "field-less"} no-change answer is not retried`);
	}
});
