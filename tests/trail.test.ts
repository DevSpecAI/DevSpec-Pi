import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractAssistantParts,
	extractText,
	summarizeArgs,
	summarizeResult,
	TrailBuilder,
} from "../extensions/core/trail.ts";
import { classifyDomainTool } from "../extensions/core/trail-events.ts";

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
	assert.deepEqual(extractAssistantParts(msg), {
		text: "hello world",
		thinking: "hmm",
		hasToolCalls: false,
		stopReason: null,
	});
});

test("extractAssistantParts flags toolCall blocks and stopReason", () => {
	const msg = {
		role: "assistant",
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "looking" },
			{ type: "toolCall", id: "1", name: "bash", arguments: {} },
		],
	};
	assert.deepEqual(extractAssistantParts(msg), {
		text: "looking",
		thinking: "",
		hasToolCalls: true,
		stopReason: "toolUse",
	});
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
	assert.match(out, /> 💭 let me think/);
	assert.match(out, /working on it/);
	assert.match(out, /✔ `bash` — `npm test` → 12 passing/);
	assert.match(out, /… `read` — `a\.ts`/);
	assert.ok(!t.isEmpty());
});

test("TrailBuilder truncates very long trails from the head", () => {
	const t = new TrailBuilder();
	t.setText("x".repeat(20_000));
	const out = t.render();
	// MAX_TRAIL_CHARS (12k) + the trim marker head.
	assert.ok(out.length <= 12_100);
	assert.ok(out.startsWith("…"));
});

test("TrailBuilder thinking renders prefix-stable as the trace grows (item 9b7455df)", () => {
	// The server merges cumulative snapshots by prefix-replace; that only works
	// if a growing thinking trace is always a strict prefix of its next render.
	const t = new TrailBuilder();
	t.setThinking("the plan is");
	const s1 = t.render();
	t.setThinking("the plan is to refactor the pump");
	const s2 = t.render();
	assert.ok(s2.startsWith(s1), `expected prefix-stable render:\n${s1}\n---\n${s2}`);
	// Across the 800-char cap boundary the ellipsis trails outside the variable
	// region, so stability holds there too.
	t.setThinking("x".repeat(799));
	const c1 = t.render();
	t.setThinking("x".repeat(801));
	const c2 = t.render();
	assert.ok(c2.startsWith(c1), `expected prefix-stable render across the cap`);
	assert.ok(c2.endsWith("…"));
});

test("TrailBuilder accumulates EVERY round of a run in order (cc9e8c43)", () => {
	// pi fires turn_start per LLM round, each round its own assistant message.
	// beginAssistantMessage (wired to message_start AND message_end) opens fresh
	// entries per round, so a long tool-looping run keeps its whole history.
	const t = new TrailBuilder();
	// Round 1
	t.setThinking("first I search");
	t.setText("looking into it");
	t.toolStart("bash", { command: "rg foo" });
	t.toolEnd("bash", true, { content: [{ type: "text", text: "3 hits" }] });
	t.beginAssistantMessage(); // message_end / next message_start
	// Round 2
	t.setThinking("now I edit");
	t.toolStart("edit", { path: "a.ts" });
	t.toolEnd("edit", true, { content: [{ type: "text", text: "ok" }] });
	t.beginAssistantMessage();
	// Round 3 — the answer
	t.setText("done — here is what changed");

	const out = t.render();
	const iThink1 = out.indexOf("first I search");
	const iText1 = out.indexOf("looking into it");
	const iBash = out.indexOf("✔ `bash`");
	const iThink2 = out.indexOf("now I edit");
	const iEdit = out.indexOf("✔ `edit`");
	const iFinal = out.indexOf("done — here is what changed");
	assert.ok(iThink1 !== -1 && iText1 !== -1 && iBash !== -1 && iThink2 !== -1 && iEdit !== -1 && iFinal !== -1, `all rounds present:\n${out}`);
	assert.ok(iThink1 < iText1 && iText1 < iBash && iBash < iThink2 && iThink2 < iEdit && iEdit < iFinal, `chronological order:\n${out}`);
});

test("without a round boundary, snapshots still replace in place (no duplication)", () => {
	// Defensive: if neither message_start nor message_end fires (an unforeseen
	// mode), behaviour degrades to the old last-round-wins — never duplicated
	// content.
	const t = new TrailBuilder();
	t.setThinking("round one");
	t.setThinking("round two");
	const out = t.render();
	assert.ok(!out.includes("round one"));
	assert.ok(out.includes("round two"));
});

test("the final render honours the larger cap (9b7455df + cc9e8c43)", () => {
	const t = new TrailBuilder();
	t.setText("x".repeat(20_000));
	const out = t.render(48_000);
	assert.ok(!out.startsWith("…"), "20k fits under the final cap — no head trim");
	assert.equal(out.length, 20_000);
});

test("TrailBuilder.events emits stable seqs and classifies domain tools", () => {
	assert.deepEqual(classifyDomainTool("create_action_item"), {
		domain: "action_item",
		action: "created",
	});
	assert.deepEqual(classifyDomainTool("devspec", { verb: "record_memory" }), {
		domain: "memory",
		action: "recorded",
	});
	assert.equal(classifyDomainTool("bash"), null);

	const t = new TrailBuilder();
	t.setThinking("plan");
	t.toolStart("create_action_item", { title: "Trail UI" });
	t.toolEnd("create_action_item", true, {
		content: [{ type: "text", text: JSON.stringify({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: "Trail UI" }) }],
	});
	t.toolStart("bash", { command: "npm test" });
	const events = t.events();
	assert.equal(events[0]?.kind, "thinking");
	assert.equal(events[0]?.seq, 1);
	assert.equal(events[1]?.kind, "domain");
	if (events[1]?.kind === "domain") {
		assert.equal(events[1].domain, "action_item");
		assert.equal(events[1].status, "ok");
		assert.equal(events[1].title, "Trail UI");
	}
	assert.equal(events[2]?.kind, "tool");
	if (events[2]?.kind === "tool") {
		assert.equal(events[2].status, "running");
		assert.equal(events[2].name, "bash");
	}
});
