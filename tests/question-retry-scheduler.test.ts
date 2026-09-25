import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { test } from "node:test";

// Execute the production scheduling prefix, not a copied decision predicate.
// Fake only time, retry work and the downstream poll; the RPC regression covers
// actual Pi command application separately, without relying on timer jitter.
const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const loop = source.indexOf("async function pumpLoop");
const from = source.indexOf("while (pump === active && !active.stop) {", loop);
const to = source.indexOf("// The server can claim ten at once.", from);
assert.ok(loop >= 0 && from > loop && to > from);
const probe = stripTypeScriptTypes(`(async () => { ${source.slice(from, to)} polls += 1; active.stop = true; } })()`, { mode: "transform" });

async function replay(attempted: boolean, futureRetry: boolean) {
	const active = { stop: false, pushEnded: undefined, pushClosed: false };
	const sleeps: number[] = [];
	let attempts = 0;
	let observations = 0;
	const scope: any = {
		active, pump: active, ctx: {}, lastCtx: null, token: "fixture", endpoint: "loopback",
		pushMode: false, notifiedFallback: false, polls: 0,
		ensurePushInteractionNegotiation() {},
		// An unavailable provider must not hold command polling behind its reply.
		pi_refreshBackgroundWork: () => { observations += 1; return new Promise(() => {}); },
		nextInteractionRetryAt: () => futureRetry ? 11_000 : null,
		drainInteractionRetries: async () => { if (++attempts >= 3) active.stop = true; return attempted; },
		Date: { now: () => 1_000 },
		setTimeout: (callback: () => void, delay: number) => { sleeps.push(delay); callback(); },
	};
	vm.createContext(scope);
	await vm.runInContext(probe, scope);
	return { polls: scope.polls, attempts, sleeps, observations };
}

test("a deferred retry attempt cannot consume the ordinary command/control poll", async () => {
	const result = await replay(true, false);
	assert.equal(result.polls, 1, "ordinary polling must run even when a retry was attempted");
	assert.equal(result.attempts, 1);
	assert.equal(result.observations, 1);
});

test("a future retry deadline cannot delay a ready ordinary poll", async () => {
	const result = await replay(false, true);
	assert.equal(result.polls, 1);
	assert.deepEqual(result.sleeps, [], "retry timers schedule retries, not a barrier before ordinary polling");
});
