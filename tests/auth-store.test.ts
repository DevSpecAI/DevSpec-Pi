import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "devspec-pi-auth-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
delete process.env.DEVSPEC_MCP_TOKEN;
delete process.env.DEVSPEC_MCP_URL;
delete process.env.DEVSPEC_ENV;

const store = await import("../extensions/core/auth-store.ts");
const { DEFAULT_MCP_URL, STAGING_MCP_URL } = await import("../extensions/core/config.ts");
const { SignInEndedError } = await import("../extensions/core/oauth.ts");

const HOUR = 60 * 60 * 1000;

function tokens(tag: string, issuedAt = Date.now(), lifeMs = 24 * HOUR) {
	return { accessToken: `oat_${tag}`, refreshToken: `rt_${tag}`, issuedAt, expiresAt: issuedAt + lifeMs };
}

function save(endpoint: string, tag: string, issuedAt?: number, lifeMs?: number) {
	return store.saveLogin({
		endpoint,
		tokens: tokens(tag, issuedAt, lifeMs),
		issuer: "https://issuer.test",
		tokenEndpoint: "https://issuer.test/oauth/token",
		clientId: "pi-client",
		resource: endpoint,
		signedInAs: "Ali Price",
	});
}

beforeEach(async () => {
	delete process.env.DEVSPEC_MCP_TOKEN;
	delete process.env.DEVSPEC_ENV;
	await mkdir(join(sandbox, "devspec"), { recursive: true });
	await rm(store.authFilePath(), { force: true });
	await rm(`${store.authFilePath()}.lock`, { force: true });
});

test("with no login there is no credential", async () => {
	assert.equal(await store.resolveToken(), null);
	assert.deepEqual(await store.loginState(), { kind: "none", legacyToken: false });
});

test("a login is saved owner-only and used for its own server", async () => {
	await save(DEFAULT_MCP_URL, "prod");
	assert.equal((await stat(store.authFilePath())).mode & 0o777, 0o600);
	const resolved = await store.resolveToken();
	assert.equal(resolved?.token, "oat_prod");
	assert.equal(resolved?.source, "login");
});

test("staging and production logins sit side by side, and the environment picks which is used", async () => {
	await save(DEFAULT_MCP_URL, "prod");
	await save(STAGING_MCP_URL, "staging");
	assert.equal((await store.resolveToken())?.token, "oat_prod");
	process.env.DEVSPEC_ENV = "staging";
	assert.equal((await store.resolveToken())?.token, "oat_staging");
	delete process.env.DEVSPEC_ENV;
	assert.equal((await store.resolveToken())?.token, "oat_prod", "switching back needs no new login");
});

test("a login can never be saved under a server other than the one it was approved for", async () => {
	await assert.rejects(store.saveLogin({
		endpoint: DEFAULT_MCP_URL,
		tokens: tokens("x"),
		issuer: "https://issuer.test",
		tokenEndpoint: "https://issuer.test/oauth/token",
		clientId: "pi-client",
		resource: STAGING_MCP_URL,
	}));
	assert.deepEqual(await store.loginState(DEFAULT_MCP_URL), { kind: "none", legacyToken: false });
});

test("signing out removes only the current server's login", async () => {
	await save(DEFAULT_MCP_URL, "prod");
	await save(STAGING_MCP_URL, "staging");
	const removed = await store.removeLogin(STAGING_MCP_URL);
	assert.equal(removed?.refreshToken, "rt_staging");
	assert.equal((await store.loginState(STAGING_MCP_URL)).kind, "none");
	assert.equal((await store.loginState(DEFAULT_MCP_URL)).kind, "active");
});

test("the environment token wins over a saved login", async () => {
	await save(DEFAULT_MCP_URL, "prod");
	process.env.DEVSPEC_MCP_TOKEN = "dvs_env";
	const resolved = await store.resolveToken();
	assert.deepEqual(resolved, { token: "dvs_env", source: "env" });
});

test("a pasted token from an older version is reported, not used", async () => {
	await writeFile(store.authFilePath(), JSON.stringify({ token: "dvs_old", url: STAGING_MCP_URL }));
	assert.equal(await store.resolveToken(), null);
	assert.deepEqual(await store.loginState(), { kind: "none", legacyToken: true });
});

test("a pasted token keeps the fingerprint it always had; a login keeps one identity across renewals", async () => {
	const { createHash } = await import("node:crypto");
	assert.equal(store.principalOf({ token: "dvs_env" }), createHash("sha256").update("dvs_env").digest("hex"));

	const issued = Date.now() - 13 * HOUR; // past half of a 24h life
	await save(DEFAULT_MCP_URL, "first", issued);
	const before = await store.resolveToken({ refresh: async () => tokens("second") });
	const again = await store.resolveToken();
	assert.equal(before?.token, "oat_second");
	assert.equal(again?.token, "oat_second");
	assert.match(store.principalOf(before!), /^[a-f0-9]{64}$/);
	assert.equal(store.principalOf(before!), store.principalOf(again!));
	assert.notEqual(store.principalOf(before!), store.principalOf({ token: "oat_second" }));
});

test("a token is renewed once past half its life, never before", async () => {
	assert.equal(store.needsRenewal({ issuedAt: new Date(0).toISOString(), expiresAt: new Date(24 * HOUR).toISOString() }, 11 * HOUR), false);
	assert.equal(store.needsRenewal({ issuedAt: new Date(0).toISOString(), expiresAt: new Date(24 * HOUR).toISOString() }, 12 * HOUR), true);
	await save(DEFAULT_MCP_URL, "fresh");
	let calls = 0;
	const resolved = await store.resolveToken({ refresh: async () => { calls += 1; return tokens("unused"); } });
	assert.equal(resolved?.token, "oat_fresh");
	assert.equal(calls, 0);
});

test("concurrent renewals spend the single-use renewal key exactly once", async () => {
	await save(DEFAULT_MCP_URL, "old", Date.now() - 20 * HOUR);
	const spent: string[] = [];
	const refresh = async (input: { refreshToken: string }) => {
		spent.push(input.refreshToken);
		await new Promise((resolve) => setTimeout(resolve, 50));
		return tokens(`renewed${spent.length}`);
	};
	const results = await Promise.all(Array.from({ length: 5 }, () => store.resolveToken({ refresh })));
	assert.deepEqual(spent, ["rt_old"]);
	assert.deepEqual(new Set(results.map((r) => r?.token)), new Set(["oat_renewed1"]));
	const saved = JSON.parse(await readFile(store.authFilePath(), "utf8"));
	assert.equal(Object.values<{ refreshToken: string }>(saved.logins)[0]!.refreshToken, "rt_renewed1");
});

test("a renewal DevSpec refuses ends the login, and Pi stops offering it", async () => {
	await save(DEFAULT_MCP_URL, "old", Date.now() - 20 * HOUR);
	const resolved = await store.resolveToken({ refresh: async () => { throw new SignInEndedError("ended"); } });
	assert.equal(resolved, null);
	assert.equal((await store.loginState()).kind, "ended");
	assert.equal(await store.resolveToken({ refresh: async () => tokens("never") }), null);
});

test("a renewal that fails for a passing reason keeps the login and hands back the current token", async () => {
	await save(DEFAULT_MCP_URL, "old", Date.now() - 20 * HOUR);
	const resolved = await store.resolveToken({ refresh: async () => { throw new Error("offline"); } });
	assert.equal(resolved?.token, "oat_old");
	assert.equal((await store.loginState()).kind, "active");
});

test("an abandoned lock from a process that died does not block renewal", async () => {
	await save(DEFAULT_MCP_URL, "old", Date.now() - 20 * HOUR);
	await writeFile(`${store.authFilePath()}.lock`, "999999999");
	const resolved = await store.resolveToken({ refresh: async () => tokens("after-crash") });
	assert.equal(resolved?.token, "oat_after-crash");
});

test("a corrupt file reads as signed out", async () => {
	await writeFile(store.authFilePath(), "{ not json");
	assert.equal(await store.resolveToken(), null);
});
