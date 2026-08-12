import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the store at a temp dir BEFORE importing the module under test.
const sandbox = await mkdtemp(join(tmpdir(), "devspec-pi-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
delete process.env.DEVSPEC_MCP_TOKEN;

const { authFilePath, clearAuth, loadStoredAuth, resolveToken, saveAuth } = await import(
	"../extensions/core/auth-store.ts"
);

test("loadStoredAuth returns null when no store exists", async () => {
	assert.equal(await loadStoredAuth(), null);
	assert.equal(await resolveToken(), null);
});

test("saveAuth writes 0600 JSON and loadStoredAuth round-trips", async () => {
	await saveAuth({ token: "tok-123", principal: "Ali" });
	const stored = await loadStoredAuth();
	assert.equal(stored?.token, "tok-123");
	assert.equal(stored?.principal, "Ali");

	const raw = JSON.parse(await readFile(authFilePath(), "utf8"));
	assert.equal(raw.token, "tok-123");

	const mode = (await stat(authFilePath())).mode & 0o777;
	assert.equal(mode, 0o600);
});

test("resolveToken prefers the env var over the store", async () => {
	await saveAuth({ token: "stored-tok" });
	process.env.DEVSPEC_MCP_TOKEN = "env-tok";
	const resolved = await resolveToken();
	assert.equal(resolved?.token, "env-tok");
	assert.equal(resolved?.source, "env");
	delete process.env.DEVSPEC_MCP_TOKEN;
	const fallback = await resolveToken();
	assert.equal(fallback?.token, "stored-tok");
	assert.equal(fallback?.source, "store");
});

test("clearAuth removes the store", async () => {
	await saveAuth({ token: "tok" });
	await clearAuth();
	assert.equal(await loadStoredAuth(), null);
});

test("loadStoredAuth tolerates corrupt JSON", async () => {
	await saveAuth({ token: "tok" });
	const { writeFile } = await import("node:fs/promises");
	await writeFile(authFilePath(), "{ not json");
	assert.equal(await loadStoredAuth(), null);
});
