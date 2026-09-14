import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Item 781886cf: the pump loop's recovery behavior. The loop itself needs a
// live host + server, so these pins assert the wiring order in source: an
// auth-shaped poll failure revives before it may end, ends stamp truthful
// reasons, and the manual/degraded guidance exists. Behavioral classification
// underneath is covered by client-errors.test.ts against real error shapes.
const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");

test("an auth-shaped poll failure revives before it may end the bond", () => {
	const authBranch = remote.indexOf("if (shouldEndBondOnPollFailure(err))");
	assert.ok(authBranch > 0, "auth-failure branch missing from the poll catch");
	const window = remote.slice(authBranch, authBranch + 1500);
	const reviveAt = window.indexOf("reviveRecoverableBond(active, token, ctx, failure)");
	const endAt = window.indexOf('stopPump(ctx, "auth")');
	assert.ok(reviveAt > 0, "poll catch must attempt revive on auth-shaped failure");
	assert.ok(endAt > reviveAt, "terminal end must come only after the revive attempt");
	assert.match(window, /failure\.authFailed/, "revive must report whether credentials were confirmed rejected");
});

test("confirmed rejection stamps auth; owner_gone is never written for validation failure", () => {
	// Every owner_gone stamp passes serverAlreadyEnded (the server already
	// holds the true ui/local_stop reason); nothing transmits owner_gone for
	// a credential outcome.
	for (const match of remote.matchAll(/stopPump\(ctx, "owner_gone"([^)]*)\)/g)) {
		assert.match(match[1], /,\s*true/, `owner_gone stamp must be serverAlreadyEnded: ${match[0]}`);
	}
	assert.match(remote, /stopPump\(ctx, "auth"\)/, "confirmed rejection must stamp the auth end reason");
	assert.match(
		remote,
		/credentials rejected — bond ended\. \/devspec\.login to reconnect\./,
		"login guidance appears only on the confirmed-rejection path",
	);
	assert.doesNotMatch(remote, /token rejected — bond ended/, "old misleading rejection text is gone");
});

test("prolonged failure warns once with the manual action; recovery is reported once", () => {
	assert.match(
		remote,
		/connection troubled — retrying automatically\. \/devspec\.remote reconnect to retry now\./,
		"degraded warning with the manual retry action",
	);
	assert.match(remote, /notifiedDegraded = true/, "degraded warning fires once per episode");
	assert.match(remote, /connection recovered\./, "recovery is reported");
});

test("/devspec.remote reconnect hurries the next lap without rebuilding state", () => {
	assert.match(remote, /arg === "reconnect" \|\| arg === "retry"/, "reconnect subcommand exists");
	const at = remote.indexOf('arg === "reconnect"');
	const window = remote.slice(at, at + 1200);
	assert.match(window, /signalWake\(pump\)/, "reconnect wakes the pump's next lap");
	assert.match(window, /pump\.errors = 0/, "reconnect clears the consecutive-error count");
	assert.doesNotMatch(window, /stopPump|ctx\.reload/, "reconnect must not tear down or reload anything");
	assert.match(remote, /\| stop \| reconnect \| auto/, "usage string advertises reconnect");
});
