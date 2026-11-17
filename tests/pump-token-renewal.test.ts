/**
 * Item b59b18fa: When a Pi session's browser sign-in renews its 24-hour Clerk
 * access token at the 12-hour midpoint, Clerk immediately invalidates the
 * previous access token (`404 not_known_to_clerk` -> `401 invalid_api_token`).
 *
 * These tests run the real remote extension against a scripted DevSpec + local
 * OAuth token renewal server + SSE push channel and verify:
 * 1. Renewal during the wake wait (`waitForWake`): the pump resolves the
 *    renewed credential after waking before sending `poll_connection`, never
 *    sends the invalidated pre-sleep token, and stays connected.
 * 2. Renewal while `poll_connection` is in flight: when `poll_connection` on
 *    the old token fails with `401 invalid_api_token`, the pump picks up the
 *    renewed credential and continues polling without ending the bond.
 * 3. `reviveRecoverableBond` after a poll failure or server-side end: resolves
 *    the latest saved credential before calling `register_connection` rather
 *    than reusing the credential that failed, and rides out a renewal that
 *    completes while `register_connection` is in flight while still ending the
 *    bond on genuine credential rejection or `signed_out`.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	resetClientCache,
	setLaneClientFactoryForTests,
	type LaneClient,
} from "../extensions/core/client.ts";
import { getBond, setBond } from "../extensions/core/bond-state.ts";
import { authFilePath, saveLogin } from "../extensions/core/auth-store.ts";

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

function invalidApiTokenError(): Error {
	return Object.assign(
		new Error(
			'Streamable HTTP error: Error POSTing to endpoint: {"error":"Invalid or revoked API token","code":"invalid_api_token","retryable":false}',
		),
		{ code: 401 },
	);
}

function invalidCapabilityError(): Error {
	return Object.assign(
		new Error(
			'Streamable HTTP error: Error POSTing to endpoint: {"error":"Denied.","code":"invalid_connection_capability","retryable":false}',
		),
		{ code: 401 },
	);
}

class RenewalTestServer {
	private server!: Server;
	private readonly sseStreams = new Set<ServerResponse>();
	mcpUrl = "";
	tokenEndpoint = "";
	activeAccessToken = "oat_initial";
	activeRefreshToken = "rt_initial";
	nextRenewedAccessToken = "oat_renewed_1";
	nextRenewedRefreshToken = "rt_renewed_1";
	refreshCalls = 0;
	readonly revokedTokens = new Set<string>();
	readonly calls: Array<{ name: string; token: string; args?: Record<string, unknown> }> = [];
	onPoll?: (call: { token: string; args?: Record<string, unknown>; pollIndex: number }) => Promise<unknown> | unknown;
	onRegister?: (call: { token: string; args?: Record<string, unknown>; regIndex: number }) => Promise<unknown> | unknown;
	private pollCounter = 0;
	private regCounter = 0;

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method === "GET" && url.pathname === "/api/mcp/connection-stream") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				res.write("event: wake\ndata: {}\n\n");
				this.sseStreams.add(res);
				req.on("close", () => this.sseStreams.delete(res));
				return;
			}
			if (req.method === "POST" && url.pathname === "/oauth/token") {
				let body = "";
				req.setEncoding("utf8");
				req.on("data", (chunk) => { body += chunk; });
				req.on("end", () => {
					this.refreshCalls += 1;
					// Clerk immediately deletes the previous access token when a refresh completes.
					this.revokedTokens.add(this.activeAccessToken);
					this.activeAccessToken = this.nextRenewedAccessToken;
					this.activeRefreshToken = this.nextRenewedRefreshToken;
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({
						access_token: this.activeAccessToken,
						refresh_token: this.activeRefreshToken,
						expires_in: 86400,
						token_type: "Bearer",
					}));
				});
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
		const port = (this.server.address() as AddressInfo).port;
		this.mcpUrl = `http://127.0.0.1:${port}/api/mcp`;
		this.tokenEndpoint = `http://127.0.0.1:${port}/oauth/token`;
	}

	sendWake(): void {
		for (const stream of this.sseStreams) {
			stream.write("event: wake\ndata: {}\n\n");
		}
	}

	async stop(): Promise<void> {
		for (const stream of this.sseStreams) {
			stream.end();
		}
		this.sseStreams.clear();
		this.server.closeAllConnections?.();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	installLaneFactory(): void {
		setLaneClientFactoryForTests(async ({ token }): Promise<LaneClient> => ({
			callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
				this.calls.push({ name, token, args });
				if (name === "register_connection") {
					const regIndex = ++this.regCounter;
					if (this.onRegister) {
						const custom = await this.onRegister({ token, args, regIndex });
						if (custom !== undefined) return custom;
					}
					if (this.revokedTokens.has(token)) throw invalidApiTokenError();
					return {
						...text({
							connection_id: CONNECTION,
							project_id: PROJECT.id,
							codename: "Drifting Hare",
							session_id: null,
							project_selection: { version: 1, status: "resolved", source: "folder_pin", project: PROJECT },
						}),
						_meta: { devspec: { connection_capability: { version: 1, value: `dvsc_cap_${regIndex}_12345678901234567890` } } },
					};
				}
				if (name === "poll_connection") {
					const pollIndex = ++this.pollCounter;
					if (this.onPoll) {
						const custom = await this.onPoll({ token, args, pollIndex });
						if (custom !== undefined) return custom;
					}
					if (this.revokedTokens.has(token)) throw invalidApiTokenError();
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
				if (this.revokedTokens.has(token)) throw invalidApiTokenError();
				return text({ success: true });
			},
			readResource: async () => {
				if (this.revokedTokens.has(token)) throw invalidApiTokenError();
				return { contents: [] };
			},
			close: async () => {},
		}));
	}
}

interface Harness {
	start: () => Promise<void>;
	shutdown: () => Promise<void>;
	command: (name: string, args: string) => Promise<void>;
	notices: Array<{ message: string; level: string }>;
}

let dir: string;
let srv: RenewalTestServer;
const savedEnv = {
	token: process.env.DEVSPEC_MCP_TOKEN,
	url: process.env.DEVSPEC_MCP_URL,
	agentDir: process.env.PI_CODING_AGENT_DIR,
};
let shutdowns: Array<() => Promise<void>> = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "devspec-pump-renewal-"));
	srv = new RenewalTestServer();
	await srv.start();
	delete process.env.DEVSPEC_MCP_TOKEN;
	process.env.DEVSPEC_MCP_URL = srv.mcpUrl;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	setBond(null);
	resetClientCache();
	shutdowns = [];
	await saveLogin({
		endpoint: srv.mcpUrl,
		tokens: {
			accessToken: "oat_initial",
			refreshToken: "rt_initial",
			issuedAt: Date.now(),
			expiresAt: Date.now() + 24 * HOUR,
		},
		issuer: "https://apt-hare-75.clerk.accounts.dev",
		tokenEndpoint: srv.tokenEndpoint,
		clientId: "bWlWy3fvhxrNU2LT",
		resource: srv.mcpUrl,
		signedInAs: "Ali Price",
	});
	srv.installLaneFactory();
});

afterEach(async () => {
	for (const shutdown of shutdowns) await shutdown();
	setLaneClientFactoryForTests(null);
	resetClientCache();
	setBond(null);
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	await srv.stop();
	for (const [key, value] of [
		["DEVSPEC_MCP_TOKEN", savedEnv.token],
		["DEVSPEC_MCP_URL", savedEnv.url],
		["PI_CODING_AGENT_DIR", savedEnv.agentDir],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(dir, { recursive: true, force: true });
});

async function loadRemote(): Promise<Harness> {
	const { default: remote } = await import(`../extensions/devspec-remote.ts?fresh=${Math.random()}`);
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const entries: unknown[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, spec.handler),
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
	};
	shutdowns.push(harness.shutdown);
	return harness;
}

/** Age the saved login past its 12-hour midpoint so the next resolveToken() renews it via /oauth/token. */
async function ageSavedLoginPastMidpoint(): Promise<void> {
	const raw = JSON.parse(await readFile(authFilePath(), "utf8")) as {
		version: number;
		logins: Record<string, { issuedAt: string; expiresAt: string }>;
	};
	for (const login of Object.values(raw.logins)) {
		const issued = Date.now() - 13 * HOUR;
		login.issuedAt = new Date(issued).toISOString();
		login.expiresAt = new Date(issued + 24 * HOUR).toISOString();
	}
	await writeFile(authFilePath(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/** Simulate another Pi process or background call completing a token renewal in auth.json. */
async function rotateSavedLoginInPlace(nextAccessToken: string, nextRefreshToken = "rt_rotated"): Promise<void> {
	const raw = JSON.parse(await readFile(authFilePath(), "utf8")) as {
		version: number;
		logins: Record<string, { accessToken: string; refreshToken: string; issuedAt: string; expiresAt: string }>;
	};
	for (const login of Object.values(raw.logins)) {
		srv.revokedTokens.add(login.accessToken);
		login.accessToken = nextAccessToken;
		login.refreshToken = nextRefreshToken;
		const now = Date.now();
		login.issuedAt = new Date(now).toISOString();
		login.expiresAt = new Date(now + 24 * HOUR).toISOString();
	}
	srv.activeAccessToken = nextAccessToken;
	await writeFile(authFilePath(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

test("renewal during the wake wait: pumpLoop renews after waking and polls with the new token without ending the bond", async () => {
	srv.nextRenewedAccessToken = "oat_renewed_after_wake";
	const pi = await loadRemote();
	await pi.start();
	assert.equal(getBond()?.connectionId, CONNECTION);

	// Wake once so the initial poll completes with oat_initial, then pumpLoop enters waitForWake.
	srv.sendWake();
	await until(
		() => srv.calls.some((c) => c.name === "poll_connection" && c.token === "oat_initial"),
		2_000,
		"initial poll with oat_initial",
	);
	await delay(50);

	// While the pump sleeps in waitForWake, the 24-hour login crosses its 12-hour renewal threshold.
	await ageSavedLoginPastMidpoint();
	const pollsBeforeWake = srv.calls.filter((c) => c.name === "poll_connection").length;

	// Wake the pump: it must renew via /oauth/token BEFORE sending poll_connection,
	// never sending the invalidated oat_initial token on the post-wake poll.
	srv.sendWake();
	await until(
		() => srv.calls.some((c) => c.name === "poll_connection" && c.token === "oat_renewed_after_wake"),
		2_000,
		"post-wake poll with oat_renewed_after_wake",
	);

	assert.equal(srv.refreshCalls, 1, "OAuth refresh_token called exactly once after wake");
	const postWakePolls = srv.calls.filter((c) => c.name === "poll_connection").slice(pollsBeforeWake);
	assert.ok(postWakePolls.length >= 1);
	assert.ok(
		postWakePolls.every((c) => c.token === "oat_renewed_after_wake"),
		`expected all post-wake polls to use oat_renewed_after_wake, got ${postWakePolls.map((c) => c.token).join(", ")}`,
	);
	assert.equal(getBond()?.connectionId, CONNECTION, "bond remains connected");
	assert.equal(
		srv.calls.some((c) => c.name === "heartbeat_connection" && c.args?.end_reason === "auth"),
		false,
		"must never end the bond with end_reason=auth",
	);
	assert.equal(
		pi.notices.some((n) => /credentials rejected/i.test(n.message)),
		false,
		"must never report credentials rejected",
	);
});

test("renewal while poll_connection is in flight: 401 on the invalidated old token switches to the renewed token without ending the bond", async () => {
	let releaseInFlightPoll: (() => void) | undefined;
	let inFlightEntered = false;
	srv.onPoll = async ({ token, pollIndex }) => {
		if (pollIndex === 1) {
			inFlightEntered = true;
			await new Promise<void>((resolve) => { releaseInFlightPoll = resolve; });
			// By the time this in-flight poll completes, oat_initial was revoked by the renewal.
			if (srv.revokedTokens.has(token)) throw invalidApiTokenError();
		}
		return undefined;
	};

	const pi = await loadRemote();
	await pi.start();
	srv.sendWake();
	await until(() => inFlightEntered, 2_000, "poll #1 in flight with oat_initial");

	// Another Pi or background call renews auth.json while poll #1 is in flight, invalidating oat_initial.
	await rotateSavedLoginInPlace("oat_renewed_inflight");
	releaseInFlightPoll!();

	// The catch block sees the renewed token and immediately continues polling on the next wake.
	await delay(30);
	srv.sendWake();
	await until(
		() => srv.calls.some((c) => c.name === "poll_connection" && c.token === "oat_renewed_inflight"),
		2_000,
		"poll with oat_renewed_inflight after in-flight 401",
	);

	assert.equal(getBond()?.connectionId, CONNECTION, "bond remains connected");
	assert.equal(
		srv.calls.filter((c) => c.name === "register_connection").length,
		1,
		"switched directly to renewed token without needing a re-registration",
	);
	assert.equal(
		srv.calls.some((c) => c.name === "heartbeat_connection" && c.args?.end_reason === "auth"),
		false,
		"must never end the bond with end_reason=auth",
	);
	assert.equal(
		pi.notices.some((n) => /credentials rejected/i.test(n.message)),
		false,
		"must never report credentials rejected",
	);
});

test("reviveRecoverableBond resolves the latest saved credential before re-registering after a server end or capability rotation", async () => {
	let endedReturned = false;
	srv.onPoll = async ({ pollIndex }) => {
		if (pollIndex === 1) {
			// Renewal completed right as the server reported a recoverable idle_timeout end.
			await rotateSavedLoginInPlace("oat_renewed_for_revive");
			endedReturned = true;
			return text({
				connection_id: CONNECTION,
				status: "ended",
				end_reason: "idle_timeout",
			});
		}
		return undefined;
	};

	const pi = await loadRemote();
	await pi.start();
	srv.sendWake();
	await until(() => endedReturned, 2_000, "recoverable ended response");
	await until(
		() => srv.calls.some((c) => c.name === "register_connection" && c.token === "oat_renewed_for_revive"),
		2_000,
		"revive register_connection with oat_renewed_for_revive",
	);
	srv.sendWake();
	await until(
		() => srv.calls.some((c) => c.name === "poll_connection" && c.token === "oat_renewed_for_revive"),
		2_000,
		"post-revive poll with oat_renewed_for_revive",
	);

	assert.equal(getBond()?.connectionId, CONNECTION);
	assert.equal(
		srv.calls.some((c) => c.name === "heartbeat_connection" && c.args?.end_reason === "auth"),
		false,
	);
	assert.equal(pi.notices.some((n) => /credentials rejected/i.test(n.message)), false);
});

test("reviveRecoverableBond does not mark authFailed if the credential rotated while register_connection was in flight, but still ends on genuine rejection", async () => {
	let phase: "rotate_during_revive" | "healthy" | "genuine_reject" = "rotate_during_revive";
	srv.onPoll = async () => {
		if (phase === "rotate_during_revive") {
			// Force reviveRecoverableBond while saved token is still oat_initial.
			throw invalidCapabilityError();
		}
		if (phase === "genuine_reject") {
			throw invalidApiTokenError();
		}
		return undefined;
	};
	srv.onRegister = async ({ token, regIndex }) => {
		if (regIndex === 2 && phase === "rotate_during_revive") {
			// While register_connection is in flight with oat_initial, the token renews to oat_after_revive_race.
			await rotateSavedLoginInPlace("oat_after_revive_race");
			phase = "healthy";
			if (srv.revokedTokens.has(token)) throw invalidApiTokenError();
		}
		if (phase === "genuine_reject") {
			throw invalidApiTokenError();
		}
		return undefined;
	};

	const pi = await loadRemote();
	await pi.start();
	srv.sendWake();
	await until(
		() => srv.calls.some((c) => c.name === "poll_connection" && c.token === "oat_after_revive_race"),
		5_000,
		"recovery poll with oat_after_revive_race after mid-revive rotation",
	);
	assert.equal(getBond()?.connectionId, CONNECTION, "bond survived mid-revive credential rotation");
	assert.equal(pi.notices.some((n) => /credentials rejected/i.test(n.message)), false);

	// Now simulate a genuine revocation where the token is rejected and no new token exists.
	phase = "genuine_reject";
	srv.sendWake();
	await until(() => getBond() === null, 3_000, "bond ended on genuine rejection");
	assert.equal(
		srv.calls.some((c) => c.name === "heartbeat_connection" && c.args?.end_reason === "auth"),
		true,
		"genuine credential rejection still stamps end_reason=auth",
	);
	assert.equal(
		pi.notices.some((n) => /credentials rejected — bond ended\. \/devspec\.login to reconnect\./.test(n.message)),
		true,
		"genuine credential rejection notifies the user",
	);
});
