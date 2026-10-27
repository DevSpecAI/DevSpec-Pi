/**
 * Every request Pi makes to DevSpec names the plugin: `x-devspec-plugin: pi/<version>`
 * (ADR "Protecting intent" §14, decision bab58fed, item 306fb64a). The server's
 * no-plugin rules (2295e089) key on it, so a transport that forgets it would show
 * Pi to DevSpec as an unidentified client and switch remote control off. This runs
 * the real MCP transports and the push channel against a local HTTP endpoint and
 * checks the header on every request they send.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { callDevspec, callDevspecAdvisoryOnce, readDevspecResource, resetClientCache } from "../extensions/core/client.ts";
import { PLUGIN_HEADER, pluginHeaders, versionReportFromManifest } from "../extensions/core/client-versions.ts";
import { URL_ENV_VAR } from "../extensions/core/config.ts";
import { openPushChannel } from "../extensions/core/push-channel.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const expected = `pi/${manifest.version}`;

interface Seen { method: string; path: string; rpc: string | null; clientVersion: string | null; headers: IncomingHttpHeaders }
const seen: Seen[] = [];
let server: Server;
let base = "";

function reply(res: import("node:http").ServerResponse, id: unknown, result: unknown): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

before(async () => {
	server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://local").pathname;
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			const message = body ? JSON.parse(body) as { id?: unknown; method?: string; params?: { clientInfo?: { version?: string } } } : null;
			seen.push({ method: req.method ?? "", path, rpc: message?.method ?? null, clientVersion: message?.params?.clientInfo?.version ?? null, headers: req.headers });
			if (req.method === "GET" && path.endsWith("/connection-stream")) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end("event: ended\ndata: {\"end_reason\":\"test\"}\n\n");
				return;
			}
			if (req.method !== "POST") { res.writeHead(405).end(); return; }
			if (message?.method === "initialize") {
				reply(res, message.id, { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fixture", version: "1" } });
			} else if (message?.method === "tools/call") {
				reply(res, message.id, { content: [{ type: "text", text: "{}" }] });
			} else if (message?.method === "resources/read") {
				reply(res, message.id, { contents: [{ uri: "devspec://product/implementation-contract", text: "{}" }] });
			} else {
				res.writeHead(202).end();
			}
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
});

after(async () => {
	resetClientCache();
	await new Promise<void>((done) => server.close(() => done()));
});

test("the header names this plugin and its loaded version, and is left off when the version is unknown", () => {
	assert.deepEqual(pluginHeaders(), { [PLUGIN_HEADER]: expected });
	assert.deepEqual(pluginHeaders(versionReportFromManifest({ name: "@devspec/pi-plugin", version: "1.2.3" }, undefined)), { [PLUGIN_HEADER]: "pi/1.2.3" });
	assert.deepEqual(pluginHeaders({}), {});
});

test("every request from the work lane, the pump lane, advisory calls, resource reads and the push channel carries it", async () => {
	seen.length = 0;
	resetClientCache();
	await callDevspec("fixture-token", "get_task", { task_id: "a" }, { endpoint: base, lane: "work" });
	await callDevspec("fixture-token", "poll_connection", { connection_id: "c" }, { endpoint: base, lane: "pump", connectionCapability: "capability" });
	const previous = process.env[URL_ENV_VAR];
	process.env[URL_ENV_VAR] = base;
	try {
		await callDevspecAdvisoryOnce("fixture-token", "search_tasks", { query: "x" }, 5_000);
		await readDevspecResource("fixture-token", "devspec://product/implementation-contract", { lane: "work" });
	} finally {
		if (previous === undefined) delete process.env[URL_ENV_VAR];
		else process.env[URL_ENV_VAR] = previous;
	}
	let ended: string | null = null;
	await openPushChannel({
		mcpUrl: base, token: "fixture-token", connectionId: "c", connectionCapability: "capability",
		handlers: { onWake() {}, onEnded(reason) { ended = reason; }, onClose() {} },
		signal: new AbortController().signal,
	});
	assert.equal(ended, "test");

	const rpcs = seen.map((entry) => `${entry.method} ${entry.rpc ?? entry.path}`);
	for (const required of ["POST initialize", "POST tools/call", "POST resources/read", "GET /api/mcp/connection-stream"]) {
		assert.ok(rpcs.includes(required), `${required} was exercised (saw ${rpcs.join(", ")})`);
	}
	for (const entry of seen) {
		assert.equal(entry.headers[PLUGIN_HEADER], expected, `${entry.method} ${entry.rpc ?? entry.path}`);
	}
	// The MCP handshake reports the same loaded version, not a stale literal.
	for (const init of seen.filter((entry) => entry.rpc === "initialize")) assert.equal(init.clientVersion, manifest.version);
});
