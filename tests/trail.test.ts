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
import { safeTrailLabel } from "../extensions/core/trail-projection.ts";

test("summarizeArgs uses explicit, privacy-safe projections", () => {
	assert.equal(summarizeArgs("bash", { command: "npm test" }), "npm test");
	assert.equal(summarizeArgs("read", { path: "src/index.ts", offset: 3 }), "src/index.ts");
	assert.equal(summarizeArgs("unknown_tool", { path: "src/index.ts" }), undefined);
	assert.equal(summarizeArgs("read", null), undefined);
});

test("summarizeResult never copies raw output text", () => {
	const res = { content: [{ type: "text", text: "line one\nline two   with   space" }] };
	assert.equal(summarizeResult("bash", res), undefined);
	assert.equal(
		summarizeResult("search_action_items", {
			content: [{ type: "text", text: "search_action_items: 12 results; showing 7.\nprivate body" }],
		}),
		"12 results; showing 7",
	);
	assert.equal(summarizeResult("get_personal_instructions", res), undefined);
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
	t.toolStart("tool-1", "bash", { command: "npm test" });
	t.toolEnd("tool-1", "bash", true, { content: [{ type: "text", text: "12 passing" }] });
	t.toolStart("tool-2", "read", { path: "a.ts" }); // left open
	const out = t.render();
	assert.match(out, /> 💭 let me think/);
	assert.match(out, /working on it/);
	assert.match(out, /✔ `bash` — `npm test`/);
	assert.ok(!out.includes("12 passing"));
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
	t.toolStart("tool-1", "bash", { command: "rg foo" });
	t.toolEnd("tool-1", "bash", true, { content: [{ type: "text", text: "3 hits" }] });
	t.beginAssistantMessage(); // message_end / next message_start
	// Round 2
	t.setThinking("now I edit");
	t.toolStart("tool-2", "edit", { path: "a.ts" });
	t.toolEnd("tool-2", "edit", true, { content: [{ type: "text", text: "ok" }] });
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

test("tool trails fail closed around private args and exact result bodies", () => {
	const secret = "NESTED_PRIVATE_SENTINEL_7f81e";
	const privateBody = `personal instructions ${secret}`;
	const t = new TrailBuilder();

	t.toolStart("private-1", "create_unknown_tool", { path: secret, nested: { token: secret } });
	t.toolEnd("private-1", "create_unknown_tool", false, {
		content: [{ type: "text", text: JSON.stringify({ status: "open", count: 1, privateBody }) }],
	});
	t.toolStart("private-2", "get_personal_instructions", { nested: { password: secret } });
	t.toolEnd("private-2", "get_personal_instructions", true, { content: [{ type: "text", text: privateBody }] });
	t.toolStart("private-3", "get_session_transcript", { session_id: "11111111-2222-3333-4444-555555555555", query: secret });
	t.toolEnd("private-3", "get_session_transcript", true, { content: [{ type: "text", text: `transcript ${secret}` }] });
	t.toolStart("private-4", "get_database_schema", {});
	t.toolEnd("private-4", "get_database_schema", true, { content: [{ type: "text", text: `schema body ${secret}` }] });

	const serialized = `${t.render()}\n${JSON.stringify(t.events())}`;
	assert.ok(!serialized.includes(secret), serialized);
	assert.ok(!serialized.includes("personal instructions"), serialized);
	assert.ok(!serialized.includes("schema body"), serialized);
	assert.match(serialized, /create_unknown_tool/);
	assert.ok(!serialized.includes("status=open"), serialized);
	assert.match(serialized, /get_personal_instructions/);
	assert.match(serialized, /session_id=11111111-2222-3333-4444-555555555555/);
});

test("CLI projections distinguish positional paths from patterns and option values", () => {
	const secret = "PRIVATE_TOKEN/fragment";
	const cases: Array<[string, string]> = [
		[`rg ${secret}`, "rg …"],
		[`rg --glob=${secret} needle`, "rg …"],
		[`rg --glob ${secret} needle`, "rg …"],
		[`grep --regexp ${secret}`, "grep …"],
		[`stat --format=${secret}`, "stat"],
		[`stat --format ${secret}`, "stat"],
	];
	for (const [command, expected] of cases) {
		const summary = summarizeArgs("bash", { command });
		assert.equal(summary, expected);
		assert.ok(!summary?.includes(secret), summary);
	}
	assert.equal(summarizeArgs("bash", { command: "rg needle src/safe-file.ts" }), "rg … src/safe-file.ts");
	assert.equal(summarizeArgs("bash", { command: "grep -e needle -- src/safe-file.ts" }), "grep … src/safe-file.ts");
	assert.equal(summarizeArgs("bash", { command: "find src/safe-dir" }), "find … src/safe-dir");
	assert.equal(summarizeArgs("bash", { command: "stat src/safe-file.ts" }), "stat src/safe-file.ts");
	assert.equal(summarizeArgs("bash", { command: "npm run PRIVATE_TOKEN/fragment" }), "npm run");
	assert.equal(summarizeArgs("bash", { command: "npm run CUSTOMER_PRIVATE_*" }), "npm run");
	assert.equal(summarizeArgs("bash", { command: "CUSTOMER_PRIVATE_COMMAND --safe" }), "command");
	for (const command of [
		"stat CUSTOMER_PRIVATE_*",
		"cat CUSTOMER_PRIVATE?",
		"stat 'CUSTOMER_PRIVATE[0-9]'",
		"head $CUSTOMER_PRIVATE",
		"tail ${CUSTOMER_PRIVATE}",
		"wc '$(printf CUSTOMER_PRIVATE)'",
		"realpath '<(printf CUSTOMER_PRIVATE)'",
		"ls 'CUSTOMER_PRIVATE\\fragment'",
	]) {
		const summary = summarizeArgs("bash", { command });
		assert.ok(!summary?.includes("CUSTOMER_PRIVATE"), `${command} -> ${summary}`);
	}
});

test("web URL projections expose only the transport class", () => {
	const secret = "URL_PRIVATE_SENTINEL_28be";
	const urls = [
		`https://user:${secret}@app.example.com/password-reset/${secret}?token=${secret}#${secret}`,
		`https://${secret}.example.com/webhooks/${secret}`,
		`https://cdn.example.co.uk/signed/${secret}?signature=${secret}`,
	];
	assert.equal(summarizeArgs("fetch", { url: urls[0] }), "https request");
	assert.equal(summarizeArgs("fetch", { url: urls[1] }), "https request");
	assert.equal(summarizeArgs("fetch", { url: urls[2] }), "https request");
	for (const url of urls) {
		const summary = summarizeArgs("fetch", { url });
		assert.ok(!summary?.toLowerCase().includes(secret.toLowerCase()), summary);
		assert.ok(!summary?.includes("password-reset"), summary);
		assert.ok(!summary?.includes("webhooks"), summary);
		assert.ok(!summary?.includes("signed"), summary);
	}
	const sshUrl = `ssh://alice:${secret}@internal.example/private/${secret}`;
	assert.equal(summarizeArgs("bash", { command: `cat '${sshUrl}'` }), "cat");
	assert.equal(summarizeArgs("read", { path: sshUrl }), undefined);
	const label = safeTrailLabel(`Clone ${sshUrl}`);
	assert.equal(label, "Clone redacted URL");
	assert.ok(!label?.includes(secret), label);
	const emphasizedLabel = safeTrailLabel(`Clone _${sshUrl}`);
	assert.equal(emphasizedLabel, "Clone redacted URL");
	assert.ok(!emphasizedLabel?.includes(secret), emphasizedLabel);
});

test("common tool projections retain safe operations without credential values", () => {
	const secret = "CLI_SECRET_SENTINEL_91ad";
	const t = new TrailBuilder();
	t.toolStart("common-1", "bash", { command: `API_KEY=${secret} npm test --token ${secret}` });
	t.toolEnd("common-1", "bash", true, { content: [{ type: "text", text: `stdout ${secret}` }] });
	t.toolStart("common-2", "bash", { command: `curl -H 'Authorization: Bearer ${secret}' 'https://user:${secret}@example.com/api/items?token=${secret}'` });
	t.toolEnd("common-2", "bash", true, { content: [{ type: "text", text: secret }] });
	t.toolStart("common-3", "read", { path: "src/safe-file.ts", content: secret, nested: { api_key: secret } });
	t.toolEnd("common-3", "read", true, { content: [{ type: "text", text: secret }] });
	t.toolStart("common-4", "fetch", { url: `https://user:${secret}@example.com/docs/page?api_key=${secret}#private` });
	t.toolEnd("common-4", "fetch", true, { content: [{ type: "text", text: secret }] });
	t.toolStart("common-5", "supabase_execute_sql", { query: `select * from public.users where password = '${secret}'` });
	t.toolEnd("common-5", "supabase_execute_sql", true, { content: [{ type: "text", text: secret }] });

	const rendered = t.render();
	const events = JSON.stringify(t.events());
	for (const output of [rendered, events]) {
		assert.ok(!output.includes(secret), output);
		assert.match(output, /npm test/);
		assert.match(output, /src\/safe-file\.ts/);
		assert.match(output, /https request/);
		assert.ok(!output.includes("example.com"), output);
		assert.ok(!output.includes("/docs/page"), output);
		assert.ok(!output.includes("user:"), output);
		assert.ok(!output.includes("api_key="), output);
		assert.match(output, /SELECT public\.users/);
	}
});

test("domain events keep identity and safe outcome but discard private bodies", () => {
	const secret = "DOMAIN_PRIVATE_SENTINEL_46c2";
	const t = new TrailBuilder();
	t.toolStart("domain-1", "create_action_item", {
		title: "Safe trail item",
		description: `private description ${secret}`,
		testing_notes: secret,
	});
	t.toolEnd("domain-1", "create_action_item", true, {
		content: [{ type: "text", text: "create_action_item: created Safe trail item" }],
		details: {
			action_item: {
				id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				title: "Safe trail item",
				lifecycle: "open",
				description: secret,
			},
			instructions: secret,
			server_payload: secret,
		},
	});
	t.toolStart("domain-2", "claim_work_item", { action_item_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", force_reason: secret });
	t.toolEnd("domain-2", "claim_work_item", true, {
		content: [{ type: "text", text: "claim_work_item: claimed Safe trail item" }],
		details: {
			claim_success: true,
			action_item: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: "Safe trail item", state: "claimed" },
			project_agent_rules: secret,
		},
	});
	t.toolStart("domain-3", "record_criterion_verdicts", {
		action_item_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		verdicts: [{ criterion_id: "criterion-safe", evidence: secret }],
	});
	t.toolEnd("domain-3", "record_criterion_verdicts", true, {
		content: [{ type: "text", text: "record_criterion_verdicts: recorded" }],
		details: { recorded: true, evidence: secret },
	});

	const rendered = t.render();
	const events = t.events();
	const serialized = `${rendered}\n${JSON.stringify(events)}`;
	assert.ok(!serialized.includes(secret), serialized);
	assert.ok(!serialized.includes("project_agent_rules"), serialized);
	assert.match(serialized, /Safe trail item/);
	assert.match(serialized, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/);
	assert.match(serialized, /lifecycle=open/);
	assert.match(serialized, /claim_success=true/);
	assert.match(serialized, /recorded=true/);
	assert.equal(events.filter((event) => event.kind === "domain").length, 3);
});

test("realistic domain wrappers preserve safe lifecycle outcomes and markdown-safe labels", () => {
	const secret = "TITLE_URL_SENTINEL_5bc9";
	const t = new TrailBuilder();
	t.toolStart("wrapper-1", "create_action_item", { title: "unsafe `trail` **title** [link]" });
	t.toolEnd("wrapper-1", "create_action_item", true, {
		content: [{ type: "text", text: "create_action_item: created" }],
		details: {
			item: {
				id: "11111111-2222-3333-4444-555555555555",
				title: "unsafe `trail` **title** [link]",
				lifecycle: "staged",
			},
		},
	});
	t.toolStart("wrapper-2", "update_action_item", { action_item_id: "22222222-3333-4444-5555-666666666666" });
	t.toolEnd("wrapper-2", "update_action_item", true, {
		content: [{ type: "text", text: "update_action_item: updated" }],
		details: {
			action_item: {
				id: "22222222-3333-4444-5555-666666666666",
				title: `Reset https://${secret}.example.com/password-reset/${secret}`,
				lifecycle: "in_progress",
			},
		},
	});
	t.toolStart("wrapper-3", "update_resource", { resource_id: "33333333-4444-5555-6666-777777777777" });
	t.toolEnd("wrapper-3", "update_resource", true, {
		content: [{ type: "text", text: "update_resource: updated" }],
		details: {
			resource: {
				id: "33333333-4444-5555-6666-777777777777",
				title: "Deferred resource",
				status: "deferred",
			},
		},
	});
	t.toolStart("wrapper-4", "record_memory", { title: "Dismissed memory" });
	t.toolEnd("wrapper-4", "record_memory", true, {
		content: [{ type: "text", text: "record_memory: recorded" }],
		details: {
			memory: {
				id: "44444444-5555-6666-7777-888888888888",
				title: "Dismissed memory",
				state: "dismissed",
			},
			recorded: true,
		},
	});
	t.toolStart("wrapper-5", "record_implementation", { action_item_id: "55555555-6666-7777-8888-999999999999" });
	t.toolEnd("wrapper-5", "record_implementation", true, {
		content: [{ type: "text", text: "record_implementation: recorded" }],
		details: {
			item: {
				action_item: {
					id: "55555555-6666-7777-8888-999999999999",
					title: "Implemented item",
					lifecycle: "implemented",
				},
			},
			implementation_recorded: true,
		},
	});

	const rendered = t.render();
	const events = t.events();
	const serialized = `${rendered}\n${JSON.stringify(events)}`;
	assert.ok(!serialized.includes(secret), serialized);
	assert.ok(!serialized.includes("password-reset"), serialized);
	assert.ok(!rendered.includes("`trail`"), rendered);
	assert.match(serialized, /unsafe trail title link/);
	assert.match(serialized, /Reset https request/);
	assert.match(serialized, /lifecycle=staged/);
	assert.match(serialized, /lifecycle=in_progress/);
	assert.match(serialized, /status=deferred/);
	assert.match(serialized, /state=dismissed/);
	assert.match(serialized, /implementation_recorded=true/);
	assert.match(serialized, /55555555-6666-7777-8888-999999999999/);
});

test("TrailBuilder.events emits stable seqs and classifies domain tools", () => {
	assert.deepEqual(classifyDomainTool("create_action_item"), {
		domain: "action_item",
		action: "created",
	});
	assert.equal(classifyDomainTool("devspec", { verb: "record_memory" }), null);
	assert.equal(classifyDomainTool("bash"), null);

	const t = new TrailBuilder();
	t.setThinking("plan");
	t.toolStart("tool-1", "create_action_item", { title: "Trail UI" });
	t.toolEnd("tool-1", "create_action_item", true, {
		content: [{ type: "text", text: JSON.stringify({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", title: "Trail UI" }) }],
	});
	t.toolStart("tool-2", "bash", { command: "npm test" });
	const events = t.events();
	assert.equal(events[0]?.kind, "thinking");
	assert.equal(events[0]?.seq, 1);
	assert.equal(events[1]?.kind, "domain");
	if (events[1]?.kind === "domain") {
		assert.equal(events[1].domain, "action_item");
		assert.equal(events[1].status, "ok");
		assert.equal(events[1].title, "Trail UI");
		assert.equal(typeof events[1].durationMs, "number");
	}
	assert.equal(events[2]?.kind, "tool");
	if (events[2]?.kind === "tool") {
		assert.equal(events[2].status, "running");
		assert.equal(events[2].name, "bash");
		assert.equal(events[2].correlationId, "tool-2");
		assert.ok(events[2].occurredAt);
	}
});

test("structured Activity excludes assistant speech and captures nested subagents", () => {
	const t = new TrailBuilder();
	t.setText("I understand — I’ll inspect the activity contract first.");
	t.setThinking("**Inspecting the activity contract**");
	t.toolStart("sub-1", "subagent", { workflowScript: "review two lanes" });
	const secret = "SUBAGENT_PRIVATE_SENTINEL_74bc";
	t.toolUpdate("sub-1", {
		details: {
			progress: [
				{ index: 0, agent: "contracts", status: "running", model: "gpt-5.6-sol", thinking: "high", lastActivityAt: Date.now(), durationMs: 1200, summary: secret },
				{ index: 1, agent: "budgets", status: "completed", model: "gpt-5.6-sol", thinking: "high", durationMs: 900, output: secret },
			],
			workflowOutput: secret,
		},
	});
	const events = t.events();
	assert.ok(!JSON.stringify(events).includes(secret));
	assert.equal(events.some((event) => event.kind === "text"), false);
	assert.doesNotMatch(t.render(undefined, false), /I understand/);
	assert.equal(events[0]?.kind, "thinking");
	assert.equal(events[1]?.kind, "subagent");
	if (events[1]?.kind === "subagent") {
		assert.equal(events[1].children.length, 2);
		assert.equal(events[1].children[0]?.agent, "contracts");
		assert.equal(events[1].children[0]?.model, "gpt-5.6-sol");
		assert.equal(events[1].summary, "1 of 2 agents active");
	}
});
