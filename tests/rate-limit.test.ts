import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRateLimitRetryMs } from "../extensions/core/client.ts";
import { nextTrailDelayMs } from "../extensions/devspec-remote.ts";

test("parseRateLimitRetryMs parses the server's hint", () => {
	assert.equal(parseRateLimitRetryMs("Rate limit exceeded. Retry after 16 seconds."), 16_000);
	assert.equal(parseRateLimitRetryMs("rate limit exceeded, retry after 1 second"), 1_000);
});

test("parseRateLimitRetryMs defaults to 5s when no hint, null without rate-limit", () => {
	assert.equal(parseRateLimitRetryMs("Rate limit exceeded"), 5_000);
	assert.equal(parseRateLimitRetryMs("some other error"), null);
});

test("nextTrailDelayMs doubles to a 10s ceiling", () => {
	assert.equal(nextTrailDelayMs(0), 1_000);
	assert.equal(nextTrailDelayMs(1), 2_000);
	assert.equal(nextTrailDelayMs(2), 4_000);
	assert.equal(nextTrailDelayMs(3), 8_000);
	assert.equal(nextTrailDelayMs(4), 10_000);
	assert.equal(nextTrailDelayMs(10), 10_000);
});

test("trail budget: a 3-minute turn costs ~20 posts, not ~180", () => {
	// Simulate: tick every 1s, post when now-lastPostAt >= delay.
	let posts = 0;
	let lastPost = -100_000;
	for (let t = 0; t <= 180_000; t += 1_000) {
		if (t - lastPost >= nextTrailDelayMs(posts)) {
			posts += 1;
			lastPost = t;
		}
	}
	assert.ok(posts <= 25, `posts=${posts} would pressure the 60 req/min budget`);
	assert.ok(posts >= 10, `posts=${posts} would feel dead — too sparse`);
});
