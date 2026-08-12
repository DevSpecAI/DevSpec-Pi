import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSseFrame } from "../extensions/core/push-channel.ts";

test("parseSseFrame parses event + data", () => {
	assert.deepEqual(parseSseFrame('event: wake\ndata: {"at":"x"}'), { event: "wake", data: '{"at":"x"}' });
});

test("parseSseFrame defaults event to message", () => {
	assert.deepEqual(parseSseFrame('data: {"a":1}'), { event: "message", data: '{"a":1}' });
});

test("parseSseFrame ignores comments/keepalives", () => {
	assert.equal(parseSseFrame(":ka 123"), null);
});

test("parseSseFrame joins multi-line data", () => {
	assert.deepEqual(parseSseFrame("event: x\ndata: one\ndata: two"), { event: "x", data: "one\ntwo" });
});

test("parseSseFrame returns null for frames without data", () => {
	assert.equal(parseSseFrame("event: wake"), null);
});
