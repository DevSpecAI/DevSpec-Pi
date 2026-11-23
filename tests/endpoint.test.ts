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

const { resolveEndpoint, saveLogin, removeLogin } = await import("../extensions/core/auth-store.ts");
const { DEFAULT_MCP_URL, STAGING_MCP_URL } = await import("../extensions/core/config.ts");

test("defaults to production with no env and no login", async () => {
	assert.equal(await resolveEndpoint(), DEFAULT_MCP_URL);
});

test("a saved login never chooses the server: only the environment does", async () => {
	const now = Date.now();
	await saveLogin({
		endpoint: STAGING_MCP_URL,
		tokens: { accessToken: "oat_s", refreshToken: "rt_s", issuedAt: now, expiresAt: now + 3_600_000 },
		issuer: "https://issuer.test",
		tokenEndpoint: "https://issuer.test/oauth/token",
		clientId: "pi-client",
		resource: STAGING_MCP_URL,
	});
	try {
		assert.equal(await resolveEndpoint(), DEFAULT_MCP_URL);
		process.env.DEVSPEC_ENV = "staging";
		assert.equal(await resolveEndpoint(), STAGING_MCP_URL);
	} finally {
		delete process.env.DEVSPEC_ENV;
		await removeLogin(STAGING_MCP_URL);
	}
});

test("explicit DEVSPEC_MCP_URL beats DEVSPEC_ENV", async () => {
	process.env.DEVSPEC_ENV = "staging";
	process.env.DEVSPEC_MCP_URL = "http://localhost:3000/api/mcp";
	try {
		assert.equal(await resolveEndpoint(), "http://localhost:3000/api/mcp");
	} finally {
		delete process.env.DEVSPEC_ENV;
		delete process.env.DEVSPEC_MCP_URL;
	}
});
