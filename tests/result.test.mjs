import assert from "node:assert/strict";
import { test } from "node:test";
import { toolErrorResult, toolTextResult, unwrapMcpResult } from "../extensions/core/result.ts";

test("unwrapMcpResult joins text blocks", () => {
	const res = {
		content: [
			{ type: "text", text: "hello" },
			{ type: "image", data: "..." },
			{ type: "text", text: "world" },
		],
	};
	const out = unwrapMcpResult(res);
	assert.equal(out.text, "hello\n\nworld");
	assert.equal(out.isError, false);
	assert.equal(out.details, null);
});

test("unwrapMcpResult parses JSON text into details", () => {
	const res = { content: [{ type: "text", text: '{"projects": []}' }] };
	const out = unwrapMcpResult(res);
	assert.deepEqual(out.details, { projects: [] });
});

test("unwrapMcpResult prefers structuredContent over parsed text", () => {
	const res = {
		content: [{ type: "text", text: '{"a": 1}' }],
		structuredContent: { b: 2 },
	};
	assert.deepEqual(unwrapMcpResult(res).details, { b: 2 });
});

test("unwrapMcpResult keeps non-JSON text as text only", () => {
	const out = unwrapMcpResult({ content: [{ type: "text", text: "plain answer" }] });
	assert.equal(out.text, "plain answer");
	assert.equal(out.details, null);
});

test("unwrapMcpResult surfaces isError", () => {
	const out = unwrapMcpResult({ content: [{ type: "text", text: "nope" }], isError: true });
	assert.equal(out.isError, true);
});

test("unwrapMcpResult tolerates garbage", () => {
	assert.deepEqual(unwrapMcpResult(null), { text: "", details: null, isError: false });
	assert.deepEqual(unwrapMcpResult(undefined), { text: "", details: null, isError: false });
	assert.deepEqual(unwrapMcpResult({}), { text: "", details: null, isError: false });
});

test("toolTextResult / toolErrorResult shapes", () => {
	assert.deepEqual(toolTextResult("hi"), { content: [{ type: "text", text: "hi" }], details: {} });
	const err = toolErrorResult("bad");
	assert.equal(err.content[0].text, "Error: bad");
	assert.equal(err.details.error, "bad");
});
