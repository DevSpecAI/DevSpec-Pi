import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DevspecApiError,
	DevspecAuthError,
	isPermanentServerEnd,
	isRecoverableTransportError,
	mapClientError,
	shouldEndBondOnPollFailure,
	withHardTimeout,
} from "../extensions/core/client.ts";

test("maps the server's 401 body text to DevspecAuthError", () => {
	const sdkError = new Error(
		'Streamable HTTP error: Error POSTing to endpoint: {"error":"Invalid or revoked API token"}',
	);
	assert.ok(mapClientError(sdkError) instanceof DevspecAuthError);
});

test("maps explicit status and wording variants", () => {
	assert.ok(mapClientError(new Error("HTTP 401")) instanceof DevspecAuthError);
	assert.ok(mapClientError(new Error("401 Unauthorized")) instanceof DevspecAuthError);
	assert.ok(mapClientError(new Error("invalid_token")) instanceof DevspecAuthError);
	assert.ok(mapClientError(new Error("Missing or invalid Authorization header")) instanceof DevspecAuthError);
});

test("maps network failures to DevspecApiError with guidance", () => {
	const err = mapClientError(new Error("fetch failed"));
	assert.ok(err instanceof DevspecApiError);
	assert.match(err.message, /Cannot reach DevSpec/);
});

test("maps TLS failures (e.g. wrong-environment cert) to reachability guidance", () => {
	const err = mapClientError(new Error("certificate verify failed: unable to get local issuer"));
	assert.ok(err instanceof DevspecApiError);
	assert.match(err.message, /Cannot reach DevSpec/);
});

test("passes through unknown errors as DevspecApiError", () => {
	const err = mapClientError(new Error("weird protocol thing"));
	assert.ok(err instanceof DevspecApiError);
	assert.match(err.message, /weird protocol thing/);
});

test("Streamable HTTP parse / timeout hangs are recoverable, not a human End", () => {
	const parse = new Error("Streamable HTTP error: Failed to parse message");
	const timeout = new DevspecApiError("DevSpec get_conventions timed out after 25000ms");
	assert.equal(isRecoverableTransportError(parse), true);
	assert.equal(isRecoverableTransportError(timeout), true);
	assert.equal(shouldEndBondOnPollFailure(parse), false);
	assert.equal(shouldEndBondOnPollFailure(timeout), false);
});

test("Connection closed / -32000 is recoverable transport, not a human End", () => {
	const closed = new Error("MCP error -32000: Connection closed");
	assert.equal(isRecoverableTransportError(closed), true);
	assert.equal(shouldEndBondOnPollFailure(closed), false);
});

test("only a rejected token ends the bond from the client", () => {
	const auth = new DevspecAuthError("DevSpec rejected the token (invalid or revoked). Run /devspec.login.");
	assert.equal(shouldEndBondOnPollFailure(auth), true);
	assert.equal(isRecoverableTransportError(auth), false);
});

test("explicit human, host-death, and auth server ends are sticky", () => {
	assert.equal(isPermanentServerEnd("ended", "ui"), true);
	assert.equal(isPermanentServerEnd("ended", "local_stop"), true);
	assert.equal(isPermanentServerEnd("ended", "owner_gone"), true);
	assert.equal(isPermanentServerEnd("ended", "auth"), true);
	assert.equal(isPermanentServerEnd("ended", null), false);
	assert.equal(isPermanentServerEnd("not_found", null), false);
	assert.equal(isPermanentServerEnd("ended", "idle_timeout"), false);
	assert.equal(isPermanentServerEnd("live", "ui"), false);
});

test("withHardTimeout rejects a hung call without waiting for it", async () => {
	const hung = new Promise(() => {});
	const started = Date.now();
	await assert.rejects(
		() => withHardTimeout(hung, 30, "get_conventions"),
		(err: unknown) => {
			assert.ok(err instanceof DevspecApiError);
			assert.match((err as Error).message, /timed out after 30ms/);
			return true;
		},
	);
	assert.ok(Date.now() - started < 500);
});
