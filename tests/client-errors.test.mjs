import assert from "node:assert/strict";
import { test } from "node:test";
import { DevspecApiError, DevspecAuthError, mapClientError } from "../extensions/core/client.ts";

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
