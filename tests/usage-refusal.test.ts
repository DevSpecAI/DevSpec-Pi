/**
 * Task 04a1fe8f: a Pi whose model provider refuses it for usage tells DevSpec
 * until when, on its status updates, so its check jobs go to another agent
 * (remote-ingress semantics.check_job.usage_refusal; server item 4d744b7b).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isUsageRefusal,
	refusalLiftsAt,
	reportedRefusalUntil,
	USAGE_REFUSAL_COOL_OFF_MS,
	USAGE_REFUSAL_MAX_AHEAD_MS,
	UsageRefusalReport,
} from "../extensions/core/usage-refusal.ts";

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("provider usage refusals are recognised; capacity, server and context errors are not", () => {
	for (const text of [
		'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization"}}',
		"Rate limit exceeded. Retry after 16 seconds.",
		"Too Many Requests",
		"You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.",
		"insufficient_quota: You exceeded your current quota, please check your plan and billing details.",
		"[429] RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).",
		"GoUsageLimitError: Monthly usage limit reached",
		"Your credit balance is too low to access the Anthropic API.",
	]) assert.equal(isUsageRefusal(text), true, text);
	for (const text of [
		'529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		"503 Service Unavailable",
		"prompt is too long: 210000 tokens > 200000 maximum",
		"fetch failed",
		"request 4291af failed",
		"",
	]) assert.equal(isUsageRefusal(text), false, text);
	assert.equal(isUsageRefusal(null), false);
	assert.equal(isUsageRefusal(undefined), false);
});

test("the time a refusal says it lifts is read from the forms providers use", () => {
	assert.equal(refusalLiftsAt("Rate limit exceeded. Retry after 16 seconds.", NOW), NOW + 16_000);
	assert.equal(refusalLiftsAt("You have hit your ChatGPT usage limit. Try again in ~42 min.", NOW), NOW + 42 * 60_000);
	assert.equal(refusalLiftsAt("Weekly limit reached; resets in 3h 20m", NOW), NOW + (3 * 60 + 20) * 60_000);
	assert.equal(refusalLiftsAt("Limit reached, try again in 2 hours and 5 minutes", NOW), NOW + 125 * 60_000);
	assert.equal(refusalLiftsAt("Server requested 90s retry delay (max: 60s). 429 rate_limit_error", NOW), NOW + 90_000);
	assert.equal(refusalLiftsAt("429 Too Many Requests; retry-after: 30", NOW), NOW + 30_000);
	assert.equal(refusalLiftsAt("Usage limit reached. Resets at 2026-11-20T15:00:00Z.", NOW), Date.parse("2026-11-20T15:00:00Z"));
	assert.equal(refusalLiftsAt("Rate limit exceeded", NOW), null, "nothing said: no time");
	assert.equal(refusalLiftsAt("Rate limit exceeded; retry in 2 attempts", NOW), null, "not a duration");
});

test("a refusal that says nothing, or nothing ahead, gets a short cool-off; any time is held to the server's bound", () => {
	assert.equal(reportedRefusalUntil("Too Many Requests", NOW), NOW + USAGE_REFUSAL_COOL_OFF_MS);
	assert.equal(reportedRefusalUntil("usage limit. Try again in ~0 min.", NOW), NOW + USAGE_REFUSAL_COOL_OFF_MS);
	assert.equal(reportedRefusalUntil("quota exceeded, resets in 30 days", NOW), NOW + USAGE_REFUSAL_MAX_AHEAD_MS);
	assert.equal(USAGE_REFUSAL_MAX_AHEAD_MS, 7 * 24 * 60 * 60_000, "the server's own bound");
});

test("a run that ends refused is reported on every status update until it lifts, then cleared once a turn succeeds", () => {
	const report = new UsageRefusalReport();
	report.noteModelCall({ stopReason: "error", errorMessage: "Rate limit exceeded. Retry after 120 seconds." }, NOW);
	assert.deepEqual(report.statusField(NOW), {}, "nothing is reported while the run may still retry");
	report.settleRun();
	const field = report.statusField(NOW + 1_000);
	assert.deepEqual(field, { usage_refused_until: iso(NOW + 120_000) });
	report.delivered(field);
	assert.deepEqual(report.statusField(NOW + 60_000), { usage_refused_until: iso(NOW + 120_000) }, "sent with each status update while it stands");
	// The time passes with no turn: the server has lifted it too, so nothing is sent.
	assert.deepEqual(report.statusField(NOW + 121_000), {});
	// A turn succeeds: the next status update clears it, once.
	report.noteModelCall({ stopReason: "stop" }, NOW + 200_000);
	report.settleRun();
	const clear = report.statusField(NOW + 200_001);
	assert.deepEqual(clear, { usage_refused_until: null });
	report.delivered(clear);
	assert.deepEqual(report.statusField(NOW + 200_002), {});
});

test("a refusal Pi's own retries carried through was never a refusal", () => {
	const report = new UsageRefusalReport();
	report.noteModelCall({ stopReason: "error", errorMessage: "429 rate_limit_error" }, NOW);
	report.noteModelCall({ stopReason: "toolUse" }, NOW + 5_000);
	report.settleRun();
	assert.notEqual(typeof report.statusField(NOW + 6_000).usage_refused_until, "string");
});

test("other errors and a person's Stop neither report nor clear a refusal", () => {
	const report = new UsageRefusalReport();
	report.noteModelCall({ stopReason: "error", errorMessage: "503 Service Unavailable" }, NOW);
	report.settleRun();
	assert.notEqual(typeof report.statusField(NOW).usage_refused_until, "string");
	report.noteModelCall({ stopReason: "error", errorMessage: "Too Many Requests" }, NOW);
	report.settleRun();
	report.noteModelCall({ stopReason: "aborted" }, NOW + 1_000);
	report.settleRun();
	assert.deepEqual(report.statusField(NOW + 2_000), { usage_refused_until: iso(NOW + USAGE_REFUSAL_COOL_OFF_MS) });
});

test("a refusal held from before a restart is cleared by the first turn that succeeds", () => {
	const report = new UsageRefusalReport();
	assert.deepEqual(report.statusField(NOW), {}, "nothing is claimed before any turn");
	report.noteModelCall({ stopReason: "stop" }, NOW);
	report.settleRun();
	const clear = report.statusField(NOW);
	assert.deepEqual(clear, { usage_refused_until: null });
	report.delivered(clear);
	report.noteModelCall({ stopReason: "stop" }, NOW + 1_000);
	report.settleRun();
	assert.deepEqual(report.statusField(NOW + 1_000), {}, "later turns send nothing");
});

test("a clear delivered while a new refusal came to stand does not drop the refusal", () => {
	const report = new UsageRefusalReport();
	report.noteModelCall({ stopReason: "stop" }, NOW);
	const inFlight = report.statusField(NOW); // a long poll carrying the clear
	assert.deepEqual(inFlight, { usage_refused_until: null });
	report.noteModelCall({ stopReason: "error", errorMessage: "usage limit reached" }, NOW + 1_000);
	report.settleRun();
	report.delivered(inFlight);
	assert.deepEqual(report.statusField(NOW + 2_000), { usage_refused_until: iso(NOW + 1_000 + USAGE_REFUSAL_COOL_OFF_MS) });
	// The refusal it reported is cleared again by the next turn that succeeds.
	report.delivered(report.statusField(NOW + 2_000));
	report.noteModelCall({ stopReason: "stop" }, NOW + 3_000);
	assert.deepEqual(report.statusField(NOW + 3_000), { usage_refused_until: null });
});
