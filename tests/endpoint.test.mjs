import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "devspec-pi-endpoint-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
delete process.env.DEVSPEC_MCP_TOKEN;
delete process.env.DEVSPEC_MCP_URL;
delete process.env.DEVSPEC_ENV;

const { resolveEndpoint, saveAuth, clearAuth } = await import("../extensions/core/auth-store.ts");
const { DEFAULT_MCP_URL, STAGING_MCP_URL } = await import("../extensions/core/config.ts");

test("defaults to production with no env and no store", async () => {
	assert.equal(await resolveEndpoint(), DEFAULT_MCP_URL);
});

test("stored login URL beats the production default", async () => {
	await saveAuth({ token: "tok", url: STAGING_MCP_URL });
	assert.equal(await resolveEndpoint(), STAGING_MCP_URL);
	await clearAuth();
});

test("DEVSPEC_ENV=staging beats the stored URL", async () => {
	await saveAuth({ token: "tok", url: DEFAULT_MCP_URL });
	process.env.DEVSPEC_ENV = "staging";
	assert.equal(await resolveEndpoint(), STAGING_MCP_URL);
	delete process.env.DEVSPEC_ENV;
	await clearAuth();
});

test("explicit DEVSPEC_MCP_URL beats everything", async () => {
	await saveAuth({ token: "tok", url: STAGING_MCP_URL });
	process.env.DEVSPEC_ENV = "staging";
	process.env.DEVSPEC_MCP_URL = "http://localhost:3000/api/mcp";
	assert.equal(await resolveEndpoint(), "http://localhost:3000/api/mcp");
	delete process.env.DEVSPEC_MCP_URL;
	delete process.env.DEVSPEC_ENV;
	await clearAuth();
});
