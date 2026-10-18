import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "devspec-pi-adapter-overlap-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

const {
	adapterToolName,
	adapterToolNamesFor,
	findDevspecServers,
	isAdapterSource,
	isDevspecMcpHost,
	isDevspecMcpUrl,
	resetAdapterGuardState,
	recordAdapterGuard,
	getAdapterGuardState,
	serversFromConfig,
	toolsToDeactivate,
	SUPPRESSION_NOTICE,
} = await import("../extensions/core/adapter-overlap.ts");

const STAGING = "https://api.devspecstaging.com/api/mcp";
const PROD = "https://api.devspec.ai/api/mcp";

test("isDevspecMcpHost matches the prod and staging API hosts, not supabase", () => {
	assert.equal(isDevspecMcpHost("api.devspec.ai"), true);
	assert.equal(isDevspecMcpHost("api.devspecstaging.com"), true);
	assert.equal(isDevspecMcpHost("devspec.ai"), true);
	assert.equal(isDevspecMcpHost("devspecstaging.com"), true);
	// Retiring host: a checkout's .mcp.json may still name it, and that is the entry the guard disables.
	assert.equal(isDevspecMcpHost("staging.devspec.ai"), true);
	assert.equal(isDevspecMcpHost("mcp.supabase.com"), false);
	assert.equal(isDevspecMcpHost("example.com"), false);
	assert.equal(isDevspecMcpHost("devspec.ai.example.com"), false);
	assert.equal(isDevspecMcpHost("notdevspecstaging.com"), false);
});

test("isDevspecMcpUrl matches host and the effective endpoint", () => {
	assert.equal(isDevspecMcpUrl(STAGING, PROD), true);
	assert.equal(isDevspecMcpUrl(PROD, STAGING), true);
	assert.equal(isDevspecMcpUrl("https://mcp.supabase.com/mcp", STAGING), false);
	assert.equal(isDevspecMcpUrl("http://localhost:3000/api/mcp", "http://localhost:3000/api/mcp"), true);
	assert.equal(isDevspecMcpUrl("not a url", STAGING), false);
});

test("findDevspecServers picks the DevSpec entry and leaves Supabase", () => {
	const hits = findDevspecServers(
		{
			devspec: { url: STAGING },
			supabase: { url: "https://mcp.supabase.com/mcp" },
		},
		"/tmp/.mcp.json",
		PROD,
	);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].name, "devspec");
	assert.equal(hits[0].alreadyDisabled, false);
});

test("findDevspecServers honors disabled: true and odd names", () => {
	const hits = findDevspecServers(
		{
			"my-devspec": { url: PROD, disabled: true },
			chrome: { url: "https://example.com" },
		},
		"/tmp/.mcp.json",
		STAGING,
	);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].name, "my-devspec");
	assert.equal(hits[0].alreadyDisabled, true);
});

test("serversFromConfig reads mcpServers and mcp-servers", () => {
	assert.deepEqual(Object.keys(serversFromConfig({ mcpServers: { a: { url: "x" } } })), ["a"]);
	assert.deepEqual(Object.keys(serversFromConfig({ "mcp-servers": { b: { url: "x" } } })), ["b"]);
	assert.deepEqual(serversFromConfig(null), {});
});

test("adapterToolName default prefix is server_verb", () => {
	assert.equal(adapterToolName("get_task", "devspec", "server"), "devspec_get_task");
	assert.equal(adapterToolName("get_task", "devspec", "none"), "get_task");
	assert.equal(adapterToolName("post_session_message", "devspec", "server"), "devspec_post_session_message");
});

test("adapterToolNamesFor includes pump and delivery verbs under every prefix", () => {
	const names = adapterToolNamesFor("devspec");
	assert.ok(names.includes("devspec_post_session_message"));
	assert.ok(names.includes("devspec_poll_connection"));
	assert.ok(names.includes("get_task")); // prefix none
});

test("toolsToDeactivate removes prefixed adapter names and leaves native verbs", () => {
	const removed = toolsToDeactivate(
		[
			{ name: "get_task", sourceInfo: { source: "extension", path: "devspec-tools.ts" } },
			{ name: "devspec_get_task", sourceInfo: { source: "pi-mcp-adapter" } },
			{ name: "devspec_post_session_message" },
			{ name: "supabase_list_projects" },
			{ name: "read" },
		],
		["devspec"],
	);
	assert.deepEqual(removed.sort(), ["devspec_get_task", "devspec_post_session_message"]);
});

test("toolsToDeactivate only strips a bare verb when sourceInfo is the adapter", () => {
	assert.deepEqual(
		toolsToDeactivate([{ name: "get_task" }], ["devspec"]),
		[],
	);
	assert.deepEqual(
		toolsToDeactivate(
			[{ name: "get_task", sourceInfo: { path: "/x/pi-mcp-adapter/index.ts" } }],
			["devspec"],
		),
		["get_task"],
	);
	assert.equal(isAdapterSource({ path: "/home/n3o/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts" }), true);
	assert.equal(isAdapterSource({ source: "builtin" }), false);
});

test("guard state lives on globalThis so other extension files can read it", () => {
	resetAdapterGuardState();
	recordAdapterGuard({
		suppressed: [{ name: "devspec", source: "/tmp/.mcp.json", url: STAGING, alreadyDisabled: false }],
		persisted: true,
		overlayPath: "/tmp/.pi/mcp-adapter.json",
	});
	const s = getAdapterGuardState();
	assert.equal(s.suppressed[0].name, "devspec");
	assert.equal(s.persisted, true);
	assert.match(SUPPRESSION_NOTICE, /disabled in Pi to avoid duplicate tools/);
	assert.match(SUPPRESSION_NOTICE, /Other agents’ settings and your other MCP servers are unchanged/);
});
