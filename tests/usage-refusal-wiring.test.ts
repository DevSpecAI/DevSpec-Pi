/**
 * Task 04a1fe8f: the real remote extension reports a model provider's usage
 * refusal on its status updates once the run that hit it is over, and clears it
 * once a turn succeeds (remote-ingress semantics.check_job.usage_refusal).
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

const PROJECT = {
	id: "abababab-abab-4bab-8bab-abababababab",
	name: "Website",
	organization: { id: "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd", name: "Agency" },
};
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const HOUR = 60 * 60 * 1000;

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

type Call = { name: string; args?: Record<string, unknown> };

class ScriptedDevspec {
	private server!: Server;
	private readonly streams = new Set<ServerResponse>();
	mcpUrl = "";
	readonly calls: Call[] = [];

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

	/** Status updates: live heartbeats and polls, in the order sent. */
	statusUpdates(): Call[] {
		return this.calls.filter((c) => c.name === "poll_connection" || (c.name === "heartbeat_connection" && c.args?.status === "live"));
	}

	installLaneFactory(): void {
		let registrations = 0;
		setLaneClientFactoryForTests(async (): Promise<LaneClient> => ({
			callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
				this.calls.push({ name, args });
				if (name === "register_connection") {
					registrations += 1;
					return {
						...text({
							connection_id: CONNECTION,
							project_id: PROJECT.id,
							codename: "Drifting Hare",
							session_id: null,
							project_selection: { version: 1, status: "resolved", source: "folder_pin", project: PROJECT },
						}),
						_meta: { devspec: { connection_capability: { version: 1, value: `dvsc_cap_${registrations}_12345678901234567890` } } },
					};
				}
				if (name === "poll_connection") {
					return text({
						connection_id: args?.connection_id ?? CONNECTION,
						session_id: null,
						changed: false,
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
	dir = await mkdtemp(join(tmpdir(), "devspec-usage-refusal-"));
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
	/** One run whose model calls ended as given, in order. */
	const modelRun = async (...messages: Array<Record<string, unknown>>) => {
		await run("agent_start", { type: "agent_start" });
		for (const message of messages) await run("message_end", { type: "message_end", message: { role: "assistant", content: [], ...message } });
		await run("agent_settled", { type: "agent_settled" });
	};
	return { start: () => run("session_start", { type: "session_start", reason: "startup" }), modelRun };
}

test("a run refused for usage is reported on the next status updates, and a turn that succeeds clears it", async () => {
	const pi = await loadRemote();
	await pi.start();
	assert.equal(getBond()?.connectionId, CONNECTION);
	srv.wake();
	await until(() => srv.calls.some((c) => c.name === "poll_connection"), 2_000, "first poll");
	assert.ok(srv.statusUpdates().every((c) => !(c.args && "usage_refused_until" in c.args)), "nothing is reported before any turn");

	const before = srv.statusUpdates().length;
	const refusedAt = Date.now();
	await pi.modelRun({ stopReason: "error", errorMessage: "429 rate_limit_error: Rate limit exceeded. Retry after 600 seconds." });
	srv.wake();
	await until(() => srv.statusUpdates().slice(before).some((c) => typeof c.args?.usage_refused_until === "string"), 2_000, "a status update carrying the refusal");
	const reported = srv.statusUpdates().slice(before).find((c) => typeof c.args?.usage_refused_until === "string")!;
	const until600 = Date.parse(reported.args!.usage_refused_until as string);
	assert.ok(until600 >= refusedAt + 599_000 && until600 <= Date.now() + 600_000, `refused until the time the provider gave, got ${reported.args!.usage_refused_until}`);
	assert.equal(reported.args!.status === undefined || reported.args!.status === "live", true);

	const afterRefusal = srv.statusUpdates().length;
	await pi.modelRun({ stopReason: "stop", content: [{ type: "text", text: "Done." }] });
	srv.wake();
	await until(() => srv.statusUpdates().slice(afterRefusal).some((c) => c.args?.usage_refused_until === null), 2_000, "a status update clearing the refusal");
	const cleared = srv.statusUpdates().slice(afterRefusal).findIndex((c) => c.args?.usage_refused_until === null);
	assert.ok(
		srv.statusUpdates().slice(afterRefusal + cleared + 1).every((c) => typeof c.args?.usage_refused_until !== "string"),
		"once cleared, no later status update reports the refusal again",
	);
});

test("a refusal Pi's own retry carried through is never reported", async () => {
	const pi = await loadRemote();
	await pi.start();
	srv.wake();
	await until(() => srv.calls.some((c) => c.name === "poll_connection"), 2_000, "first poll");
	const before = srv.statusUpdates().length;
	// Pi's automatic retry: the refused call and its successful retry in one run.
	await pi.modelRun(
		{ stopReason: "error", errorMessage: "Too Many Requests" },
		{ stopReason: "stop", content: [{ type: "text", text: "ok" }] },
	);
	srv.wake();
	await until(() => srv.statusUpdates().length > before + 1, 2_000, "status updates after the run");
	assert.ok(srv.statusUpdates().slice(before).every((c) => typeof c.args?.usage_refused_until !== "string"));
});
