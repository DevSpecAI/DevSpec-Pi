import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DevspecApiError,
	DevspecAuthError,
	DevspecAuthUnavailableError,
	isPermanentServerEnd,
	personEndClosesPi,
	isRecoverableTransportError,
	mapClientError,
	parseRateLimitRetryMs,
	readStructuredFailure,
	remotePostRejectionFromError,
	shouldEndBondOnPollFailure,
	withHardTimeout,
} from "../extensions/core/client.ts";

test("maps the server's 401 body text to DevspecAuthError", () => {
	const sdkError = new Error(
		'Streamable HTTP error: Error POSTing to endpoint: {"error":"Invalid or revoked API token"}',
	);
	assert.ok(mapClientError(sdkError) instanceof DevspecAuthError);
});

test("structured 503 unavailable-validation is retryable, never credential rejection", () => {
	// Exact SDK shape: StreamableHTTPError carries .code; the JSON failure
	// contract (item 798e2375) rides in the message body.
	const sdkError = Object.assign(
		new Error(
			'Streamable HTTP error: Error POSTing to endpoint: {"error":"Authentication is temporarily unavailable. Please try again.","code":"auth_validation_unavailable","credential_type":"api_token","retryable":true}',
		),
		{ code: 503 },
	);
	const mapped = mapClientError(sdkError);
	assert.ok(mapped instanceof DevspecAuthUnavailableError);
	assert.equal((mapped as DevspecAuthUnavailableError).credentialType, "api_token");
	assert.equal(isRecoverableTransportError(mapped), true);
	assert.equal(shouldEndBondOnPollFailure(sdkError), false);
	assert.deepEqual(readStructuredFailure(sdkError), {
		status: 503,
		code: "auth_validation_unavailable",
		retryable: true,
		credentialType: "api_token",
	});
});

test("a 503 that mentions 401 in prose is still unavailable, not revoked", () => {
	// The defect that killed healthy bonds: bare /401/ matched anything.
	const sdkError = Object.assign(
		new Error(
			'Streamable HTTP error: Error POSTing to endpoint: {"error":"Database lookup failed (see runbook 401c); retrying","code":"auth_validation_unavailable","retryable":true}',
		),
		{ code: 503 },
	);
	assert.ok(mapClientError(sdkError) instanceof DevspecAuthUnavailableError);
	assert.equal(shouldEndBondOnPollFailure(sdkError), false);
});

test("structured invalid-token and invalid-capability codes are credential rejection", () => {
	for (const code of ["invalid_api_token", "invalid_connection_capability"]) {
		const sdkError = Object.assign(
			new Error(
				`Streamable HTTP error: Error POSTing to endpoint: {"error":"Denied.","code":"${code}","retryable":false}`,
			),
			{ code: 401 },
		);
		assert.ok(mapClientError(sdkError) instanceof DevspecAuthError, code);
		assert.equal(shouldEndBondOnPollFailure(sdkError), true, code);
	}
});

test("the server retryable verdict wins over any status heuristic", () => {
	const sdkError = Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: {"code":"auth_validation_unavailable","retryable":true}'), { code: 401 });
	assert.ok(mapClientError(sdkError) instanceof DevspecAuthUnavailableError);
});

test("status arrives via code, status, or statusCode — string codes are transport noise", () => {
	assert.equal(readStructuredFailure(Object.assign(new Error("x"), { code: 503 })).status, 503);
	assert.equal(readStructuredFailure(Object.assign(new Error("x"), { status: 401 })).status, 401);
	assert.equal(readStructuredFailure(Object.assign(new Error("x"), { statusCode: 429 })).status, 429);
	assert.equal(readStructuredFailure(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).status, null);
});

test("ambiguous 401s with no server code are recoverable, not proof of revocation", () => {
	// Proxy/gateway 401s, bare statuses, OAuth-shaped tokens: none of these
	// prove the credential is dead, so none may end the bond (item 781886cf).
	for (const text of ["HTTP 401", "401 Unauthorized", "invalid_token", "Missing or invalid Authorization header", "Proxy 401: authenticate"]) {
		const mapped = mapClientError(new Error(text));
		assert.ok(mapped instanceof DevspecApiError, text);
		assert.ok(!(mapped instanceof DevspecAuthError), text);
		assert.equal(shouldEndBondOnPollFailure(new Error(text)), false, text);
	}
});

test("exact legacy server strings still classify as rejection (old servers)", () => {
	assert.ok(mapClientError(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":"Invalid or revoked API token"}')) instanceof DevspecAuthError);
	assert.ok(mapClientError(new Error("Invalid or expired connection capability")) instanceof DevspecAuthError);
});

test("unavailable-validation text never trips the rate-limit path", () => {
	const mapped = mapClientError(Object.assign(new Error('{"code":"auth_validation_unavailable","retryable":true}'), { code: 503 }));
	assert.equal(parseRateLimitRetryMs(mapped.message), null);
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

test("only deliberate human ends are sticky; owner_gone and auth revive", () => {
	// Matches the server's PERMANENT_END_REASONS (ui / local_stop). owner_gone
	// and auth are recoverable ends the revive path re-validates (item 781886cf).
	assert.equal(isPermanentServerEnd("ended", "ui"), true);
	assert.equal(isPermanentServerEnd("ended", "local_stop"), true);
	assert.equal(isPermanentServerEnd("ended", "owner_gone"), false);
	assert.equal(isPermanentServerEnd("ended", "auth"), false);
	assert.equal(isPermanentServerEnd("ended", null), false);
	assert.equal(isPermanentServerEnd("not_found", null), false);
	assert.equal(isPermanentServerEnd("ended", "idle_timeout"), false);
	assert.equal(isPermanentServerEnd("live", "ui"), false);
});

test("only a person's End from DevSpec closes Pi (item 7813bcd9)", () => {
	// End on the Agents page or in a session: the server's 'ui', owner-only.
	assert.equal(personEndClosesPi("ended", "ui"), true);
	assert.equal(personEndClosesPi("not_found", "ui"), true);
	// A local stop means the person is at this terminal: Pi stays open.
	assert.equal(personEndClosesPi("ended", "local_stop"), false);
	// Recoverable ends (redeploy blip, sweep, auth) never close Pi.
	for (const reason of ["owner_gone", "auth", "idle_timeout", null, undefined]) {
		assert.equal(personEndClosesPi("ended", reason), false, String(reason));
	}
	// Anything that is not an end at all (a detach leaves the connection live).
	assert.equal(personEndClosesPi("live", "ui"), false);
	assert.equal(personEndClosesPi(null, "ui"), false);
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

test("remotePostRejectionFromError extracts the server's not-stored outcome (759f2818)", () => {
	const stored = new Error("Your message was NOT stored (stale_generation). Do not retry this post — the connection or its turn is gone.");
	assert.equal(remotePostRejectionFromError(stored), "stale_generation");
	assert.equal(remotePostRejectionFromError(new Error("Your message was NOT stored (stale_attempt). …")), "stale_attempt");
	assert.equal(remotePostRejectionFromError(new Error("Your message was NOT stored (activity_attempt_closed). …")), "activity_attempt_closed");
	assert.equal(remotePostRejectionFromError(new Error("phase='trail' requires an exact open activity attempt for this command segment.")), "no_open_attempt");
	assert.equal(remotePostRejectionFromError(new Error("network timeout")), null, "transport errors carry no projection outcome");
	assert.equal(remotePostRejectionFromError("stale_generation"), null, "non-Error input is not an outcome");
	assert.equal(remotePostRejectionFromError(null), null);
});
