import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
	mergeDisabledOverlay,
	persistDisabledOverlay,
	projectOverlayPath,
	resetAdapterGuardState,
	recordAdapterGuard,
	getAdapterGuardState,
	serversFromConfig,
	toolsToDeactivate,
	SUPPRESSION_NOTICE,
} = await import("../extensions/core/adapter-overlap.ts");

const STAGING = "https://staging.devspec.ai/api/mcp";
const PROD = "https://devspec.ai/api/mcp";

test("isDevspecMcpHost matches prod and staging, not supabase", () => {
	assert.equal(isDevspecMcpHost("devspec.ai"), true);
	assert.equal(isDevspecMcpHost("staging.devspec.ai"), true);
	assert.equal(isDevspecMcpHost("mcp.supabase.com"), false);
	assert.equal(isDevspecMcpHost("example.com"), false);
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

test("mergeDisabledOverlay writes only disabled:true and does not copy credentials", () => {
	const { next, changed } = mergeDisabledOverlay({}, ["devspec"]);
	assert.equal(changed, true);
	const servers = (next.mcpServers as Record<string, { disabled?: boolean; url?: string }>).devspec;
	assert.equal(servers.disabled, true);
	assert.equal(servers.url, undefined);
});

test("mergeDisabledOverlay is a no-op when already disabled", () => {
	const existing = { mcpServers: { devspec: { disabled: true } } };
	const { changed } = mergeDisabledOverlay(existing, ["devspec"]);
	assert.equal(changed, false);
});

test("persistDisabledOverlay writes .pi/mcp.json and never needs a shared file", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "devspec-pi-overlay-"));
	await writeFile(join(cwd, ".mcp.json"), JSON.stringify({
		mcpServers: {
			devspec: { url: STAGING, headers: { Authorization: "Bearer secret" }, directTools: true },
			supabase: { url: "https://mcp.supabase.com/mcp", directTools: true },
		},
	}));
	const result = persistDisabledOverlay(cwd, ["devspec"]);
	assert.equal(result.changed, true);
	assert.equal(result.path, projectOverlayPath(cwd));
	const overlay = JSON.parse(await readFile(result.path, "utf8")) as {
		mcpServers: Record<string, { disabled?: boolean; url?: string; headers?: unknown }>;
	};
	assert.equal(overlay.mcpServers.devspec.disabled, true);
	assert.equal(overlay.mcpServers.devspec.url, undefined);
	assert.equal(overlay.mcpServers.devspec.headers, undefined);
	assert.equal(overlay.mcpServers.supabase, undefined);
	const shared = await readFile(join(cwd, ".mcp.json"), "utf8");
	assert.match(shared, /Bearer secret/);
	assert.match(shared, /supabase/);
});

test("adapterToolName default prefix is server_verb", () => {
	assert.equal(adapterToolName("get_action_item", "devspec", "server"), "devspec_get_action_item");
	assert.equal(adapterToolName("get_action_item", "devspec", "none"), "get_action_item");
	assert.equal(adapterToolName("post_session_message", "devspec", "server"), "devspec_post_session_message");
});

test("adapterToolNamesFor includes pump and delivery verbs under every prefix", () => {
	const names = adapterToolNamesFor("devspec");
	assert.ok(names.includes("devspec_post_session_message"));
	assert.ok(names.includes("devspec_poll_connection"));
	assert.ok(names.includes("get_action_item")); // prefix none
});

test("toolsToDeactivate removes prefixed adapter names and leaves native verbs", () => {
	const removed = toolsToDeactivate(
		[
			{ name: "get_action_item", sourceInfo: { source: "extension", path: "devspec-tools.ts" } },
			{ name: "devspec_get_action_item", sourceInfo: { source: "pi-mcp-adapter" } },
			{ name: "devspec_post_session_message" },
			{ name: "supabase_list_projects" },
			{ name: "read" },
		],
		["devspec"],
	);
	assert.deepEqual(removed.sort(), ["devspec_get_action_item", "devspec_post_session_message"]);
});

test("toolsToDeactivate only strips a bare verb when sourceInfo is the adapter", () => {
	assert.deepEqual(
		toolsToDeactivate([{ name: "get_action_item" }], ["devspec"]),
		[],
	);
	assert.deepEqual(
		toolsToDeactivate(
			[{ name: "get_action_item", sourceInfo: { path: "/x/pi-mcp-adapter/index.ts" } }],
			["devspec"],
		),
		["get_action_item"],
	);
	assert.equal(isAdapterSource({ path: "/home/n3o/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts" }), true);
	assert.equal(isAdapterSource({ source: "builtin" }), false);
});

test("guard state lives on globalThis so other extension files can read it", () => {
	resetAdapterGuardState();
	recordAdapterGuard({
		suppressed: [{ name: "devspec", source: "/tmp/.mcp.json", url: STAGING, alreadyDisabled: false }],
		persisted: true,
		overlayPath: "/tmp/.pi/mcp.json",
	});
	const s = getAdapterGuardState();
	assert.equal(s.suppressed[0].name, "devspec");
	assert.equal(s.persisted, true);
	assert.match(SUPPRESSION_NOTICE, /turned off the extra DevSpec MCP server/);
});
