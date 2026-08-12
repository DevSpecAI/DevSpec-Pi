import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractAssistantParts,
	extractText,
	summarizeArgs,
	summarizeResult,
	TrailBuilder,
} from "../extensions/core/trail.ts";

test("summarizeArgs prefers readable keys", () => {
	assert.equal(summarizeArgs({ command: "npm test" }), "npm test");
	assert.equal(summarizeArgs({ path: "src/index.ts", offset: 3 }), "src/index.ts");
	assert.equal(summarizeArgs({}), undefined);
	assert.equal(summarizeArgs(null), undefined);
});

test("summarizeResult flattens text content to one line", () => {
	const res = { content: [{ type: "text", text: "line one\nline two   with   space" }] };
	assert.equal(summarizeResult(res), "line one line two with space");
	assert.equal(summarizeResult({ content: [] }), undefined);
});

test("extractAssistantParts separates text and thinking", () => {
	const msg = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "hello " },
			{ type: "text", text: "world" },
		],
	};
	assert.deepEqual(extractAssistantParts(msg), { text: "hello world", thinking: "hmm" });
});

test("extractText handles string and block content", () => {
	assert.equal(extractText({ content: "plain" }), "plain");
	assert.equal(extractText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
});

test("TrailBuilder renders thinking, text, and tools with statuses", () => {
	const t = new TrailBuilder();
	assert.ok(t.isEmpty());
	t.setThinking("let me think");
	t.setText("working on it");
	t.toolStart("bash", { command: "npm test" });
	t.toolEnd("bash", true, { content: [{ type: "text", text: "12 passing" }] });
	t.toolStart("read", { path: "a.ts" }); // left open
	const out = t.render();
	assert.match(out, /💭 \*let me think\*/);
	assert.match(out, /working on it/);
	assert.match(out, /✔ `bash` — `npm test` → 12 passing/);
	assert.match(out, /… `read` — `a\.ts`/);
	assert.ok(!t.isEmpty());
});

test("TrailBuilder truncates very long trails from the head", () => {
	const t = new TrailBuilder();
	t.setText("x".repeat(8000));
	const out = t.render();
	assert.ok(out.length <= 6100);
	assert.ok(out.startsWith("…"));
});
