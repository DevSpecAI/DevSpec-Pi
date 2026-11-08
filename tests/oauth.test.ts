import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import {
	browserCanReachThisMachine,
	clientIdFor,
	discoverSignIn,
	refreshTokens,
	SignInEndedError,
	startCopyCodeSignIn,
	startLoopbackSignIn,
	type SignInDiscovery,
} from "../extensions/core/oauth.ts";

// One fake host plays both DevSpec (protected-resource metadata) and Clerk
// (authorization-server metadata and token endpoint). The token endpoint only
// pays out when the PKCE verifier matches the challenge from the authorize step.
let server: Server;
let base = "";
const issued = new Map<string, { challenge: string; redirectUri: string }>();
const exchanges: Array<Record<string, string>> = [];
let resourceInMetadata: (mcp: string) => string = (mcp) => mcp;

before(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", base);
		const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
		if (url.pathname === "/.well-known/oauth-protected-resource/api/mcp") {
			return json(200, { resource: resourceInMetadata(`${base}/api/mcp`), authorization_servers: [base], scopes_supported: ["devspec", "offline_access"] });
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			return json(200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, revocation_endpoint: `${base}/oauth/token/revoke` });
		}
		if (url.pathname === "/oauth/token" && req.method === "POST") {
			let raw = "";
			req.on("data", (chunk) => { raw += chunk; });
			req.on("end", () => {
				const body = Object.fromEntries(new URLSearchParams(raw));
				exchanges.push(body);
				if (body.grant_type === "refresh_token") {
					return body.refresh_token === "rt_live" ? json(200, { access_token: "oat_renewed", refresh_token: "rt_next", expires_in: 86400, token_type: "bearer" })
						: json(400, { error: "invalid_grant" });
				}
				const grant = issued.get(body.code ?? "");
				const verified = grant && grant.redirectUri === body.redirect_uri &&
					createHash("sha256").update(body.code_verifier ?? "").digest("base64url") === grant.challenge;
				if (!verified) return json(400, { error: "invalid_grant" });
				issued.delete(body.code!);
				return json(200, { access_token: "oat_new", refresh_token: "rt_new", expires_in: 86400, token_type: "bearer" });
			});
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); });

/** What Clerk does after the person clicks Allow: mint a code bound to the challenge. */
function approve(authorizeUrl: string, code: string): URL {
	const request = new URL(authorizeUrl);
	issued.set(code, { challenge: request.searchParams.get("code_challenge")!, redirectUri: request.searchParams.get("redirect_uri")! });
	const back = new URL(request.searchParams.get("redirect_uri")!);
	back.searchParams.set("code", code);
	back.searchParams.set("state", request.searchParams.get("state")!);
	back.searchParams.set("iss", base);
	return back;
}

async function discovery(): Promise<SignInDiscovery> {
	return discoverSignIn(`${base}/api/mcp`);
}

test("discovery follows DevSpec to its sign-in server", async () => {
	const found = await discovery();
	assert.equal(found.resource, `${base}/api/mcp`);
	assert.equal(found.issuer, base);
	assert.equal(found.tokenEndpoint, `${base}/oauth/token`);
});

test("discovery refuses metadata for a different address, and a server without sign-in", async () => {
	resourceInMetadata = () => "https://elsewhere.test/api/mcp";
	try {
		await assert.rejects(discovery(), /different address/);
	} finally {
		resourceInMetadata = (mcp) => mcp;
	}
	await assert.rejects(discoverSignIn(`${base}/other/mcp`), /does not offer browser sign-in yet/);
});

test("each DevSpec sign-in server has Pi's own app, and an unknown one is refused", () => {
	assert.equal(clientIdFor("https://clerk.devspec.ai"), "0WORfT6JYchcBDDq");
	assert.equal(clientIdFor("https://apt-hare-75.clerk.accounts.dev"), "bWlWy3fvhxrNU2LT");
	assert.throws(() => clientIdFor("https://attacker.test"), /does not know how to sign in/);
});

test("the approval comes back through the browser to this machine, and only with the matching state", async () => {
	const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: "pi-client" });
	const request = new URL(pending.url);
	assert.equal(request.searchParams.get("scope"), "devspec offline_access");
	assert.equal(request.searchParams.get("code_challenge_method"), "S256");
	assert.equal(request.searchParams.get("resource"), `${base}/api/mcp`);
	assert.match(request.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

	const back = approve(pending.url, "code-1");
	const forged = new URL(back);
	forged.searchParams.set("state", "someone-elses");
	assert.equal((await fetch(forged)).status, 400, "a callback this Pi did not start is refused");

	const page = await fetch(back);
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, /Signed in to DevSpec/);
	assert.match(html, /Restart Pi to finish connecting\./);
	assert.match(html, /color-scheme:light dark/);
	assert.match(html, /@media \(prefers-color-scheme:dark\)/);
	assert.match(html, /logo-icon\.png/);
	const tokens = await pending.done;
	assert.equal(tokens.accessToken, "oat_new");
	assert.equal(tokens.refreshToken, "rt_new");
	assert.equal(exchanges.at(-1)?.resource, `${base}/api/mcp`);
	await assert.rejects(fetch(back), "the listener is gone once the sign-in finishes");
});

test("Deny in the browser ends the sign-in plainly", async () => {
	const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: "pi-client" });
	const request = new URL(pending.url);
	const back = new URL(request.searchParams.get("redirect_uri")!);
	back.searchParams.set("error", "access_denied");
	back.searchParams.set("state", request.searchParams.get("state")!);
	const outcome = assert.rejects(pending.done, /canceled in the browser/);
	await fetch(back);
	await outcome;
});

test("an approval returned by a different sign-in server is refused", async () => {
	const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: "pi-client" });
	const back = approve(pending.url, "code-mixup");
	back.searchParams.set("iss", "https://attacker.test");
	const outcome = assert.rejects(pending.done, /different server/);
	assert.equal((await fetch(back)).status, 400);
	await outcome;
});

test("an unanswered sign-in closes its listener by itself", async () => {
	const pending = await startLoopbackSignIn({ discovery: await discovery(), clientId: "pi-client", waitMs: 20 });
	await assert.rejects(pending.done, /timed out/);
});

test("on a machine the browser cannot reach, the person pastes the code DevSpec's page shows", async () => {
	const codePageUrl = "https://app.devspec.test/oauth-code";
	const flow = startCopyCodeSignIn({ discovery: await discovery(), clientId: "pi-client", codePageUrl });
	assert.equal(new URL(flow.url).searchParams.get("redirect_uri"), codePageUrl);
	const back = approve(flow.url, "code-2");
	const shown = `${back.searchParams.get("code")}#${back.searchParams.get("state")}`;
	await assert.rejects(flow.complete("code-2#not-this-sign-in"), /not from this sign-in/);
	await assert.rejects(flow.complete("code-2"), /not from this sign-in/);
	const tokens = await flow.complete(`  ${shown}\n`);
	assert.equal(tokens.accessToken, "oat_new");
});

test("renewal rotates the key, and a spent or revoked key ends the sign-in", async () => {
	const found = await discovery();
	const renewed = await refreshTokens({ tokenEndpoint: found.tokenEndpoint, clientId: "pi-client", refreshToken: "rt_live", resource: found.resource });
	assert.equal(renewed.refreshToken, "rt_next");
	await assert.rejects(
		refreshTokens({ tokenEndpoint: found.tokenEndpoint, clientId: "pi-client", refreshToken: "rt_spent", resource: found.resource }),
		SignInEndedError,
	);
});

test("an SSH session uses the copy-a-code page, because its browser cannot reach this machine", () => {
	assert.equal(browserCanReachThisMachine({}), true);
	assert.equal(browserCanReachThisMachine({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }), false);
	assert.equal(browserCanReachThisMachine({ SSH_TTY: "/dev/pts/1" }), false);
});
