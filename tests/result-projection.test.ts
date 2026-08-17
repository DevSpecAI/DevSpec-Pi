import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertMessages as convertGoogleMessages } from "@earendil-works/pi-ai/api/google-shared";
import { convertMessages as convertOpenAICompletionsMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { clearAllFlags, extractFlags, listFlags } from "../extensions/core/conflict-watch.ts";
import { PROJECTION_BUDGETS, projectModelText, projectionFamily } from "../extensions/core/result-projection.ts";
import { projectedToolResult, unwrapMcpResult } from "../extensions/core/result.ts";
import { extractItemRef, getStatusSnapshot, resetStatus } from "../extensions/core/status-line.ts";
import { consumeResultMechanics } from "../extensions/devspec-tools.ts";
import { MCP_CATALOG, MODEL_VERB_NAMES } from "../extensions/generated/mcp-catalog.ts";

const huge = (label: string, length = 12_000) => `${label}: ${"internal payload ".repeat(Math.ceil(length / 17))}`.slice(0, length);

function mcpJson(payload: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function visible(result: ReturnType<typeof projectedToolResult>): string {
	return result.content[0].text;
}

function toolContext(secret: string) {
	return {
		systemPrompt: "system",
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "example_tool", arguments: {} }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "example_tool",
				content: [{ type: "text", text: "compact visible content" }],
				details: { secret, payload: huge("hidden") },
				isError: false,
				timestamp: 2,
			},
		],
		tools: [],
	};
}

function model(api: string) {
	return {
		id: "test-model",
		name: "test-model",
		api,
		provider: "test",
		baseUrl: "http://localhost",
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 4_096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

test("every generated model verb is intentionally assigned to a projection contract", () => {
	const fallback = MODEL_VERB_NAMES.filter((name) => projectionFamily(name) === "fallback");
	assert.deepEqual(fallback, ["generate_commit_message"], "new/changed verbs must choose a projection family explicitly");
});

test("model tool schemas and projection families require an explicit contract-baseline update", () => {
	const contract = MCP_CATALOG
		.filter((entry) => entry.kind === "model")
		.map(({ name, inputSchema }) => ({ name, inputSchema, family: projectionFamily(name) }));
	const fingerprint = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
	// Reviewed 2026-08-17: the only schema change is claim_work_item gaining two
	// OPTIONAL client-proof inputs (known_instruction_tiers_version/_hash, the
	// instruction-tier echo that stops a claim paying twice for identical tiers).
	// Projection families are about tool RESULTS, so an added optional input
	// changes no family and no quality/budget coverage — baseline updated.
	assert.equal(
		fingerprint,
		"945a1aef27dfd4b80598e420677c9f892d9153cbc796502be39322adb93a6b02",
		"a model-facing schema or projection family changed; review quality/budget coverage, then update this fingerprint deliberately",
	);
});

test("verb projections use explicit, loss-aware families", () => {
	assert.equal(projectionFamily("get_project_summary"), "project");
	assert.equal(projectionFamily("search_action_items"), "collection");
	assert.equal(projectionFamily("devspec_help_search"), "help");
	assert.equal(projectionFamily("create_action_item"), "ack");
	for (const verb of [
		"get_action_item", "claim_work_item", "get_session_transcript", "preview_conflict_resolution",
		"get_project_instruction_rules", "get_personal_instructions", "get_workflow_rules", "get_database_schema",
		"get_goals", "get_project_goals", "create_session", "claim_playbook_run", "claim_review",
		"import_instruction_rules", "update_personal_instructions",
	]) assert.equal(projectionFamily(verb), "full", verb);
	assert.equal(projectionFamily("some_future_verb"), "fallback");
});

test("real project summary shape preserves operational context, safe identity, and mandatory tiers", () => {
	const payload = {
		id: "project-123",
		name: "DevSpec",
		stats: { sessions: 12, action_items: 47, indexed_files: 8421, member_count: 2 },
		repos: [
			{ id: "repo-1", full_name: "DevSpecAI/DevSpec-Pi", provider: "github", target_branch: "main", default_branch: "trunk" },
		],
		database_targets: [{
			name: "primary",
			environment: "production",
			branch_name: "main",
			identity: { kind: "supabase_project_ref", externalId: "safe-project-ref", detail: { dashboardUrl: "https://supabase.com/dashboard/project/safe-project-ref" } },
			connection_string: "postgres://secret@example/db",
			password: "very-secret",
		}],
		members: [
			{ id: "user-1", name: "Ada Lovelace", email: "private@example.com" },
			{ id: "user-2", displayName: "Grace Hopper" },
		],
		execution: {
			branch_prefix: "devspec/",
			commit_message_prefix: "feat: ",
			test_commands: ["npm test", "npm run typecheck"],
			protected_paths: ["extensions/generated/**", ".env"],
			auto_push: true,
			auto_merge: false,
			custom_instructions: "Prefer narrow changes. Decisions are binding.",
			agent_rules: "Run npm test and typecheck before pushing. Never commit secrets.",
		},
		owner_agent_rules: "Use the owner's local Node toolchain and do not occupy port 3000.",
		goals: [{ id: "goal-1", name: "Reliable agent workflows", status: "active", progress: 60 }],
		autopilot: { branch_prefix: "DUPLICATE-BRANCH", custom_instructions: "DUPLICATE-INSTRUCTIONS", token: "secret" },
		local_plugin_settings: { test_commands: ["DUPLICATE-TEST"] },
		large_storage_settings: huge("NEVER-ECHO-STORAGE", 30_000),
	};
	const before = JSON.stringify(payload).length;
	const result = projectedToolResult("get_project_summary", unwrapMcpResult(mcpJson(payload)));
	const text = visible(result);
	assert.ok(before > 30_000);
	assert.ok(text.length <= PROJECTION_BUDGETS.project, `project projection was ${text.length} chars`);
	assert.match(text, /Project: DevSpec \[project-123\]/);
	assert.match(text, /DevSpecAI\/DevSpec-Pi → main/);
	assert.match(text, /kind=supabase_project_ref.*external_id=safe-project-ref.*dashboard=https:\/\/supabase\.com\/dashboard\/project\/safe-project-ref.*env=production.*branch=main/);
	assert.match(text, /\[user-1\] Ada Lovelace/);
	assert.match(text, /\[user-2\] Grace Hopper/);
	assert.match(text, /sessions: 12/);
	assert.match(text, /action items: 47/);
	assert.match(text, /branch prefix: devspec\//);
	assert.match(text, /commit message prefix: feat:/);
	assert.match(text, /npm test/);
	assert.match(text, /protected paths:[\s\S]*extensions\/generated/);
	assert.match(text, /auto push: true/);
	assert.match(text, /auto merge: false/);
	assert.match(text, /Team principles[\s\S]*Decisions are binding/);
	assert.match(text, /Team execution mechanics[\s\S]*Never commit secrets/);
	assert.match(text, /owner_agent_rules[\s\S]*port 3000/);
	assert.doesNotMatch(text, /postgres|very-secret|private@example|DUPLICATE|NEVER-ECHO|local_plugin|autopilot/i);
	assert.deepEqual(result.details, payload);
});

test("get_action_items combines separate briefs and items and preserves real page counts", () => {
	const payload = {
		summary: { ui_buckets: { open: 8, implemented_awaiting_verify: 3, done: 20 } },
		page: { total_matching: 11, offset: 0, limit: 10, has_more: true, next_offset: 10 },
		briefs: [{ id: "brief-1", title: "Unified review flow", item_type: "brief", lifecycle: "in_progress" }],
		items: [{ id: "item-1", title: "Render brief hierarchy", lifecycle: "open", parent_action_item_id: "brief-1", description_preview: "Keep hierarchy visible." }],
		relationships: [],
	};
	const text = projectModelText({ toolName: "get_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /11 results; 1 additional contextual brief card\(s\)/);
	assert.match(text, /\[brief-1\] Unified review flow/);
	assert.match(text, /\[item-1\] Render brief hierarchy/);
	assert.match(text, /parent\/brief: brief-1/);
	assert.ok(text.indexOf("[item-1]") < text.indexOf("[brief-1]"), "context briefs must not jump ahead of the ordered page");
	assert.match(text, /open=8/);
	assert.match(text, /next offset\/page/);
});

test("compact action-item chronology keeps temporal signals and does not double-count a brief already in the page", () => {
	const payload = {
		page: { fields: "compact", total_matching: 2, offset: 0, limit: 100, has_more: false, next_offset: null },
		items: [
			{ id: "older", title: "Older work", lifecycle: "done", age: "8mo", last_activity: "3mo" },
			{ id: "brief-1", title: "Later brief", lifecycle: "open", age: "2d", last_activity: "1h" },
		],
		briefs: [{ id: "brief-1", title: "Later brief", lifecycle: "open" }],
	};
	const text = projectModelText({ toolName: "get_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /^get_action_items: 2 results\./);
	assert.equal(text.match(/\[brief-1\]/g)?.length, 1);
	assert.ok(text.indexOf("[older]") < text.indexOf("[brief-1]"));
	assert.match(text, /age 8mo · last activity 3mo/);
});

test("an off-page brief is contextual and never inflates the server's paginated result total", () => {
	const payload = {
		page: { fields: "compact", total_matching: 10, offset: 0, limit: 1, has_more: true, next_offset: 1 },
		items: [{ id: "item-1", title: "First page item", lifecycle: "open", age: "1d" }],
		briefs: [{ id: "off-page-brief", title: "Context from outside this page", lifecycle: "open" }],
	};
	const text = projectModelText({ toolName: "get_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /^get_action_items: 10 results; 1 additional contextual brief card\(s\)/);
	assert.doesNotMatch(text, /11 result/);
	assert.match(text, /Omitted 9 action-item result\(s\)/);
});

test("action-item search renders bounded compact cards with an exact fetch path", () => {
	const items = Array.from({ length: 20 }, (_, index) => ({
		id: `item-${String(index + 1).padStart(2, "0")}`,
		title: `Implement focused change ${index + 1}`,
		lifecycle: index % 2 ? "in_progress" : "open",
		type: index === 0 ? "brief" : "task",
		priority: index < 3 ? "high" : "normal",
		parent_action_item_id: index === 0 ? null : "brief-01",
		why_matched: `Matched result shaping terms for candidate ${index + 1}.`,
		description: huge(`full-description-${index}`, 900),
		embedding: Array.from({ length: 250 }, () => 0.12345),
	}));
	const payload = { results: items, total_matching: 20 };
	const before = JSON.stringify(payload).length;
	const result = projectedToolResult("search_action_items", unwrapMcpResult(mcpJson(payload)));
	const text = visible(result);
	assert.ok(before > 25_000);
	assert.ok(text.length <= PROJECTION_BUDGETS.collection);
	assert.match(text, /20 results; showing 7/);
	assert.match(text, /\[item-01\] Implement focused change 1/);
	assert.match(text, /Omitted 13 result/);
	assert.match(text, /get_action_item\(id\)/);
	assert.doesNotMatch(text, /item-08|embedding|full-description/);
	assert.deepEqual(result.details, payload);
});

test("action-item search preserves intent, parent title, and created chronology without full descriptions", () => {
	const payload = {
		count: 1,
		results: [{
			id: "item-intent",
			title: "Keep retrieval selective",
			lifecycle: "implemented",
			type: "improvement",
			created_at: "2026-08-14T12:54:36.630085+00:00",
			intent: "Preserve project awareness without flooding model context.",
			parent_action_item_id: "brief-1",
			parent_title: "Pi-native retrieval",
			description: huge("MUST-NOT-BE-VISIBLE"),
		}],
	};
	const text = projectModelText({ toolName: "search_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /parent\/brief: Pi-native retrieval/);
	assert.match(text, /created 2026-08-14T12:54:36.630085\+00:00/);
	assert.match(text, /Preserve project awareness without flooding model context/);
	assert.doesNotMatch(text, /MUST-NOT-BE-VISIBLE/);
});

test("long selection cards preserve parent, chronology, and intent before optional signals", () => {
	const payload = {
		count: 1,
		results: [{
			id: huge("long-id", 500),
			title: huge("long-title", 500),
			lifecycle: huge("long-lifecycle", 200),
			type: huge("long-type", 200),
			priority: huge("long-priority", 200),
			parent_title: huge("LOAD-BEARING-PARENT", 500),
			created_at: "2026-08-14T12:54:36.630085+00:00",
			last_activity_at: "2026-08-14T19:54:36.630085+00:00",
			intent: huge("LOAD-BEARING-INTENT", 1_000),
			review_signals: [{ type: huge("OPTIONAL-SIGNAL", 500) }],
		}],
	};
	const text = projectModelText({ toolName: "search_action_items", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.collection);
	assert.match(text, /LOAD-BEARING-PARENT/);
	assert.match(text, /created 2026-08-14T12:54:36.630085\+00:00/);
	assert.match(text, /last activity 2026-08-14T19:54:36.630085\+00:00/);
	assert.match(text, /LOAD-BEARING-INTENT/);
});

test("resource search projects both corpora and their matching passages instead of dropping the hit arrays", () => {
	const payload = {
		query: "Pi result shaping",
		mode: "search",
		counts: { documents: 2, artifacts: 2 },
		documents: [
			{ id: "doc-1", title: "Context study", resource_type: "reference", source: "uploaded", summary: "Study summary", matching_passage: "Measured passage about result costs." },
			{ id: "doc-2", title: "Second study", resource_type: "reference", source: "uploaded", matching_passage: "Second measured passage." },
		],
		artifacts: [
			{ id: "artifact-1", title: "Projection ADR", resource_type: "adr", source: "ai_generated", summary: "Projection decision." },
			{ id: "artifact-2", title: "Projection plan", resource_type: "plan", source: "ai_generated", summary: "Projection plan summary." },
		],
	};
	const text = projectModelText({ toolName: "search_resources", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.collection);
	assert.match(text, /^search_resources: 4 results\./);
	assert.match(text, /\[doc-1\] Context study — reference · uploaded/);
	assert.match(text, /Measured passage about result costs/);
	assert.match(text, /\[artifact-1\] Projection ADR — adr · ai_generated/);
	assert.ok(text.indexOf("[doc-1]") < text.indexOf("[artifact-1]"));
	assert.ok(text.indexOf("[artifact-1]") < text.indexOf("[doc-2]"), "resource corpora should be interleaved");
	assert.doesNotMatch(text, /Unrecognized result shape|fallback field/);
});

test("create/update projections keep decision, reconciliation, conflict, and duplicate gates", () => {
	const payload = {
		action_item: { id: "created-123", title: "Project structured results", lifecycle: "staged", parent_action_item_id: "brief-456", description: huge("REPEATED-INPUT") },
		review_before_proceeding: { required: true, instruction: "Review candidates before creating." },
		check_against_decisions: "Read the related decisions before implementation.",
		related_decisions: [{ id: "decision-1", title: "Preserve criterion evidence", memory_type: "decision", summary: "Promotion follows evidence." }],
		memory_reconciliation: { required: true, instruction: "Reconcile the closest memory first." },
		reconcile_required: true,
		closest_match: { id: "memory-1", title: "Existing result projection", memory_type: "convention" },
		potential_conflicts: [{ id: "conflict-1", title: "Existing adapter work", why: "Touches the same pipeline" }],
		near_duplicates: [{ id: "duplicate-1", title: "Compact result cards", why: "Very similar scope" }],
		unresolved_conflicts: [{ conflicting_item_id: "item-conflict", reason: "May overlap the current adapter" }],
		related_candidates: Array.from({ length: 5 }, (_, index) => ({ id: `candidate-${index + 1}`, title: `Candidate ${index + 1}`, lifecycle: "open" })),
	};
	for (const verb of ["create_action_item", "update_action_item"]) {
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.ok(text.length <= PROJECTION_BUDGETS.ack);
		assert.match(text, /id=created-123 title=Project structured results state=staged/);
		assert.match(text, /review_before_proceeding.*required: true.*Review candidates/);
		assert.match(text, /check_against_decisions.*related decisions/i);
		assert.match(text, /Related decisions:[\s\S]*decision-1/);
		assert.match(text, /memory reconciliation.*required: true/i);
		assert.match(text, /Closest memory match:[\s\S]*memory-1/);
		assert.match(text, /Potential conflicts:[\s\S]*conflict-1/);
		assert.match(text, /Near duplicates:[\s\S]*duplicate-1/);
		assert.match(text, /item-conflict.*overlap/);
		assert.match(text, /Related candidates: 5; showing top 3/);
		assert.doesNotMatch(text, /candidate-4|REPEATED-INPUT/);
	}
});

test("record_implementation clearly preserves own and brief criterion follow-through plus human steps", () => {
	const payload = {
		item: { id: "work-789", title: "Shape lifecycle response", lifecycle: "implemented" },
		action_item_id: "work-789",
		own_criteria_follow_through: {
			action_item_id: "work-789",
			criteria_total: 3,
			criteria_settled: 1,
			go_and_check: [
				{ criterion_id: "criterion-1", text: "Run npm test and record its exit code.", reason: "not_yet_checked" },
			],
			weak_evidence: [
				{ criterion_id: "criterion-2", text: "Query the projection and record the returned size.", reason: "inference_only" },
			],
			failed: [],
			leave_for_a_person: [],
			instruction: "Run observable checks, then call record_criterion_verdicts for this item.",
		},
		brief_follow_through: {
			brief_id: "brief-456",
			brief_title: "Compact common outputs",
			band: "final",
			children_total: 4,
			children_resolved: 4,
			percent_complete: 100,
			instruction: "This was the last open child; check the brief criteria now.",
			unsettled_criteria: [{ criterion_id: "brief-criterion-1", text: "Compare representative before/after payload sizes." }],
		},
		human_actions_required: [{ kind: "required_step", description: "Enable the production flag after deployment." }],
		manual_followup_steps: [{ kind: "note", description: "This alternate key must not replace human_actions_required." }],
		completion_summary: huge("ECHOED-COMPLETION"),
	};
	const result = projectedToolResult("record_implementation", unwrapMcpResult(mcpJson(payload)));
	const text = visible(result);
	assert.ok(text.length <= PROJECTION_BUDGETS.ack);
	assert.match(text, /Own-criteria follow-through \(act before reporting\)/);
	assert.match(text, /item: \[work-789\]/);
	assert.match(text, /go_and_check: \[criterion-1\] Run npm test and record its exit code.*not_yet_checked/);
	assert.match(text, /weak_evidence: \[criterion-2\] Query the projection.*inference_only/);
	assert.match(text, /Brief follow-through \(act before reporting\)/);
	assert.match(text, /brief: \[brief-456\] Compact common outputs/);
	assert.match(text, /last open child/);
	assert.match(text, /unsettled_criteria: \[brief-criterion-1\] Compare representative before\/after/);
	assert.match(text, /Manual\/human follow-up:[\s\S]*required_step: Enable the production flag/);
	assert.match(text, /note: This alternate key must not replace human_actions_required/);
	assert.doesNotMatch(text, /ECHOED-COMPLETION/);
	assert.deepEqual(result.details, payload);
});

test("record_implementation reserves every own and brief criterion under its explicit safety budget", () => {
	const own = Array.from({ length: 30 }, (_, index) => ({
		criterion_id: `own-${String(index + 1).padStart(2, "0")}`,
		text: huge(`own criterion ${index + 1}`, 2_000),
		reason: index % 2 ? "not_yet_checked" : "inference_only",
	}));
	const brief = Array.from({ length: 30 }, (_, index) => ({
		criterion_id: `brief-${String(index + 1).padStart(2, "0")}`,
		text: huge(`brief criterion ${index + 1}`, 2_000),
		reason: "not_yet_checked",
	}));
	const payload = {
		item: { id: "work-max", title: "Maximum follow-through", lifecycle: "implemented" },
		own_criteria_follow_through: {
			action_item_id: "work-max", criteria_total: 30, criteria_settled: 0,
			go_and_check: own.slice(0, 15), weak_evidence: own.slice(15),
			instruction: huge("Act on every own criterion before reporting", 4_000),
		},
		brief_follow_through: {
			brief_id: "brief-max", brief_title: "Maximum brief", band: "final",
			children_total: 4, children_resolved: 4, percent_complete: 100,
			unsettled_criteria: brief,
			instruction: huge("Act on every brief criterion before reporting", 4_000),
		},
		related_candidates: Array.from({ length: 20 }, (_, index) => ({ id: `optional-${index}`, title: huge("optional", 2_000) })),
	};
	const text = projectModelText({ toolName: "record_implementation", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.recordImplementation, `record_implementation projection was ${text.length}`);
	assert.match(text, /item: \[work-max\]/);
	assert.match(text, /brief: \[brief-max\] Maximum brief/);
	for (const entry of own) assert.match(text, new RegExp(`\\[${entry.criterion_id}\\]`), entry.criterion_id);
	for (const entry of brief) assert.match(text, new RegExp(`\\[${entry.criterion_id}\\]`), entry.criterion_id);
	assert.match(text, /go_and_check/);
	assert.match(text, /weak_evidence/);
	assert.match(text, /unsettled_criteria/);
	assert.match(text, /instruction: Act on every own criterion/);
	assert.match(text, /instruction: Act on every brief criterion/);
});

test("acknowledgements reserve every simultaneous reconciliation category", () => {
	const candidates = (prefix: string) => Array.from({ length: 8 }, (_, index) => ({
		id: `${prefix}-${index + 1}`,
		title: huge(`${prefix} title ${index + 1}`, 2_000),
		why: huge(`${prefix} reason ${index + 1}`, 2_000),
	}));
	const payload = {
		action_item: { id: "created-gates", title: "All gates", lifecycle: "staged" },
		review_before_proceeding: { required: true, instruction: huge("review first", 2_000), candidates: candidates("review") },
		check_against_decisions: { required: true, instruction: huge("check decisions", 2_000), decisions: candidates("check") },
		memory_reconciliation: {
			required: true,
			instruction: huge("reconcile", 2_000),
			potential_conflicts: candidates("memory-conflict"),
			near_duplicates: candidates("memory-duplicate"),
			closest_match: candidates("closest")[0],
		},
		related_decisions: candidates("decision"),
		potential_conflicts: candidates("conflict"),
		near_duplicates: candidates("duplicate"),
		related_candidates: candidates("related"),
	};
	const text = projectModelText({ toolName: "create_action_item", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.ack, `ack projection was ${text.length}`);
	for (const [label, id] of [
		["Review-before-proceeding candidates", "review-1"],
		["Decisions to check", "check-1"],
		["Related decisions", "decision-1"],
		["Potential conflicts", "conflict-1"],
		["Near duplicates", "duplicate-1"],
		["Related candidates", "related-1"],
		["Closest memory match", "closest-1"],
	] as const) {
		assert.match(text, new RegExp(`Gate category — ${label}:[^\\n]*\\[${id}\\]`), label);
	}
	assert.match(text, /7 more omitted from this mandatory summary/);
	assert.match(text, /Gate — review_before_proceeding/);
	assert.match(text, /Gate — check_against_decisions/);
	assert.match(text, /Gate — memory reconciliation/);
});

test("claim_work_item remains a realistic lossless implementation-context read", () => {
	const payload = {
		id: "claim-123",
		title: "Apply accepted review fixes",
		description: huge("FULL-IMPLEMENTATION-CONTEXT", 8_000),
		intent: "Compact common results without losing implementation context.",
		acceptance_criteria: [{ id: "criterion-1", text: "All exact reads remain lossless." }],
		ai_instructions: "Preserve compact output without losing load-bearing context.",
		agent_activity: "implementing",
		agent_branch: "devspec/claim-123",
		claim_success: true,
		relevant_memories: [{ id: "memory-1", title: "Binding projection decision", body: "Do not hide mandatory rules." }],
		relevant_artifacts: [{ id: "resource-1", title: "Review findings", content: "Fix follow-through rendering." }],
		review_signals: [{ type: "needs_attention", reason: "Accepted blocker fixes remain." }],
		project_custom_instructions: "Team principles are mandatory.",
		project_agent_rules: "Run npm test and typecheck before reporting.",
		owner_agent_rules: "Use the local Node toolchain.",
	};
	const text = projectModelText({ toolName: "claim_work_item", text: JSON.stringify(payload), details: payload });
	assert.deepEqual(JSON.parse(text), payload);
	assert.match(text, /FULL-IMPLEMENTATION-CONTEXT/);
	assert.match(text, /ai_instructions/);
	assert.match(text, /relevant_memories/);
	assert.match(text, /relevant_artifacts/);
	assert.match(text, /project_custom_instructions/);
	assert.match(text, /project_agent_rules/);
	assert.match(text, /owner_agent_rules/);
});

test("full exact decision, instruction, transcript, and schema reads are never capped", () => {
	const payload = { id: "exact", body: huge("LOSSLESS-EXACT-CONTENT", 9_000) };
	for (const verb of [
		"get_action_item", "get_session_transcript", "preview_conflict_resolution", "get_project_instruction_rules",
		"get_personal_instructions", "get_workflow_rules", "get_database_schema",
	]) {
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.ok(text.length > PROJECTION_BUDGETS.fallback, verb);
		assert.deepEqual(JSON.parse(text), payload, verb);
	}
});

test("create_session and read-like writes preserve their complete load-bearing responses", () => {
	const session = {
		session_id: "session-123",
		session_url: "https://app.devspec.ai/projects/project-1/sessions/session-123",
		title: "Colorful Possum · Pi",
		session_type: "agent_remote_control",
		project_custom_instructions: huge("PROJECT-PRINCIPLES", 7_000),
		project_custom_instructions_note: "Inject team principles.",
		project_agent_rules: huge("PROJECT-AGENT-RULES", 7_000),
		project_agent_rules_note: "Inject team execution mechanics.",
		owner_custom_instructions: huge("OWNER-STYLE", 7_000),
		owner_custom_instructions_note: "Inject owner chat style.",
		owner_agent_rules: huge("OWNER-AGENT-RULES", 7_000),
		owner_agent_rules_note: "Inject owner machine rules.",
	};
	const sessionText = projectModelText({ toolName: "create_session", text: JSON.stringify(session), details: session });
	assert.deepEqual(JSON.parse(sessionText), session);
	assert.match(sessionText, /session_url/);
	assert.match(sessionText, /PROJECT-PRINCIPLES/);
	assert.match(sessionText, /OWNER-AGENT-RULES/);

	for (const verb of ["claim_playbook_run", "claim_review", "import_instruction_rules", "update_personal_instructions"]) {
		const payload = { id: `${verb}-1`, permission: "look_only", preview: huge(`${verb}-LOAD-BEARING`, 8_000) };
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.deepEqual(JSON.parse(text), payload, verb);
	}
});

test("write_project_instruction_rule acknowledgement preserves committed versus queued outcome", () => {
	for (const outcome of ["committed", "queued_for_review"]) {
		const payload = { id: `rule-${outcome}`, title: "Run typecheck before push", outcome };
		const text = projectModelText({ toolName: "write_project_instruction_rule", text: JSON.stringify(payload), details: payload });
		assert.match(text, new RegExp(`outcome=${outcome}`));
		assert.ok(text.length <= PROJECTION_BUDGETS.ack);
	}
});

test("goal reads preserve authoritative exact items, project vision, and every current goal", () => {
	const exactGoal = {
		project_id: "project-1",
		goal: { id: "goal-1", title: "Reliable workflows", description: huge("GOAL-DESCRIPTION", 4_000), progress: { total: 20, done: 5 } },
		items: Array.from({ length: 20 }, (_, index) => ({ id: `goal-item-${index + 1}`, title: `Counting item ${index + 1}`, lifecycle: "open", source: index ? "inherited" : "direct" })),
		items_total: 20,
	};
	const exactText = projectModelText({ toolName: "get_goals", text: JSON.stringify(exactGoal), details: exactGoal });
	assert.deepEqual(JSON.parse(exactText), exactGoal);
	assert.match(exactText, /goal-item-20/);
	assert.match(exactText, /GOAL-DESCRIPTION/);

	const projectGoals = {
		project: { id: "project-1", name: "DevSpec", vision: huge("PROJECT-VISION", 5_000) },
		current_goals: Array.from({ length: 12 }, (_, index) => ({ id: `goal-${index + 1}`, title: `Goal ${index + 1}`, success_criteria: [`Criterion ${index + 1}`] })),
	};
	const projectText = projectModelText({ toolName: "get_project_goals", text: JSON.stringify(projectGoals), details: projectGoals });
	assert.deepEqual(JSON.parse(projectText), projectGoals);
	assert.match(projectText, /PROJECT-VISION/);
	assert.match(projectText, /goal-12/);
});

test("manual follow-up arrays stay bounded with IDs, kinds, counts, and an exact recovery path", () => {
	const steps = Array.from({ length: 100 }, (_, index) => ({
		id: `step-${index + 1}`,
		kind: index % 3 === 0 ? "required_step" : index % 3 === 1 ? "separate_work" : "note",
		description: huge(`follow-up ${index + 1}`, 2_000),
	}));
	const payload = {
		item: { id: "work-followups", title: "Bound follow-up output", lifecycle: "implemented" },
		manual_followup_steps: steps,
	};
	const text = projectModelText({ toolName: "record_implementation", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.recordImplementation);
	assert.match(text, /Manual\/human follow-up: 100; showing 3/);
	assert.match(text, /\[step-1\] required_step/);
	assert.match(text, /\[step-2\] separate_work/);
	assert.match(text, /\[step-3\] note/);
	assert.match(text, /97 additional follow-up step\(s\) omitted; use get_action_item\(work-followups\)/);
	assert.doesNotMatch(text, /step-4/);
});

test("DevSpec help projection keeps citeable URLs and bounded section content", () => {
	const results = Array.from({ length: 12 }, (_, index) => ({
		doc: `Guide ${index + 1}`,
		section: `Configure workflow ${index + 1}`,
		url: `https://docs.devspec.ai/guides/workflows#section-${index + 1}`,
		category: "workflows",
		content: `${index === 0 ? "Authoritative answer: use staged work and record implementation." : `Supporting section ${index + 1}.`}\n\n${huge(`HELP-${index}`, 2_000)}`,
	}));
	const payload = { query: "how do staged workflows complete", count: results.length, results };
	const text = projectModelText({ toolName: "devspec_help_search", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.help);
	assert.match(text, /Guide 1 — Configure workflow 1 \[workflows\]/);
	assert.match(text, /URL: https:\/\/docs\.devspec\.ai\/guides\/workflows#section-1/);
	assert.match(text, /Authoritative answer: use staged work and record implementation/);
	assert.match(text, /section character\(s\) omitted/);
	assert.match(text, /narrower query/);
	assert.match(text, /Omitted 4 lower-ranked section/);
});

test("known-family unknown shapes fall back transparently instead of inventing empty/ack responses", () => {
	for (const [verb, payload] of [
		["search_action_items", { entries: [{ uuid: "future-item", label: "Future shape" }] }],
		["create_action_item", { created_entity: { uuid: "future-created" } }],
		["get_project_summary", { orientation_v2: { uuid: "future-project" } }],
	] as const) {
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.match(text, /future-/);
		assert.doesNotMatch(text, /No matching entities|acknowledged|Project: \(name not returned\)/);
	}
});

test("production family budgets hold on adversarial selected fields without arbitrary JSON cuts", () => {
	const noisyItems = Array.from({ length: 30 }, (_, index) => ({
		id: huge(`id-${index}`, 2_000), title: huge(`title-${index}`, 3_000), lifecycle: huge("state", 1_000),
		why: huge("why", 4_000), signals: [huge("signal", 2_000)],
	}));
	const collection = projectModelText({ toolName: "search_action_items", text: "", details: { results: noisyItems, total: 30 } });
	assert.ok(collection.length <= PROJECTION_BUDGETS.collection);
	assert.match(collection, /omitted/i);

	const project = projectModelText({
		toolName: "get_project_summary",
		text: "",
		details: {
			id: huge("project-id", 2_000), name: huge("project-name", 4_000),
			repos: noisyItems, database_targets: noisyItems, members: noisyItems, goals: noisyItems,
			execution: {
				branch_prefix: huge("branch", 2_000), test_commands: noisyItems.map((_, index) => huge(`test-${index}`, 2_000)),
				protected_paths: noisyItems.map((_, index) => huge(`path-${index}`, 2_000)),
				custom_instructions: huge("principles", 9_000), agent_rules: huge("agent-rules", 9_000),
			},
			owner_agent_rules: huge("owner-rules", 9_000),
		},
	});
	assert.ok(project.length <= PROJECTION_BUDGETS.project);
	assert.match(project, /Team principles[\s\S]*complete team principles/);
	assert.match(project, /Team execution mechanics[\s\S]*complete team agent rules/);
	assert.match(project, /owner_agent_rules[\s\S]*complete personal agent rules/);
	assert.match(project, /additional repo\(s\) omitted.*Repeating this fixed summary will not reveal them model-visibly/);
	assert.match(project, /additional member\(s\) omitted.*name\/disambiguate the assignee/);
	assert.match(project, /additional execution value\(s\) omitted.*repository's agent rules/);

	const ack = projectModelText({
		toolName: "create_action_item",
		text: "",
		details: {
			action_item: { id: huge("id", 2_000), title: huge("title", 3_000), lifecycle: huge("state", 2_000) },
			review_before_proceeding: { required: true, instruction: huge("instruction", 5_000) },
			related_candidates: noisyItems,
			potential_conflicts: noisyItems,
			near_duplicates: noisyItems,
		},
	});
	assert.ok(ack.length <= PROJECTION_BUDGETS.ack);
	assert.match(ack, /omitted/i);
});

test("unknown structured fallback omits whole fields and non-JSON fallback is truthful", () => {
	const structured = projectModelText({
		toolName: "future_server_verb",
		text: "",
		details: { small: "kept", huge_field: huge("large", 10_000), tail: "also-kept" },
	});
	assert.ok(structured.length <= PROJECTION_BUDGETS.fallback);
	assert.match(structured, /"small": "kept"/);
	assert.match(structured, /"tail": "also-kept"/);
	assert.match(structured, /complete payload is host-retained in details, which is not a model-visible continuation/);
	assert.doesNotMatch(structured, /large: internal payload internal paylo$/);

	const plain = projectModelText({ toolName: "future_server_verb", text: "x".repeat(9_000), details: null });
	assert.ok(plain.length <= PROJECTION_BUDGETS.fallback);
	assert.match(plain, /Non-JSON source truncated; no structured details are available/);
	assert.match(plain, /narrower parameters/);
	assert.doesNotMatch(plain, /remains in tool result details/i);
});

test("full details still drive conflict flags and work status", () => {
	const payload = {
		item: { id: "work-789", title: "Shape lifecycle response", lifecycle: "implemented" },
		action_item_id: "work-789",
		unresolved_conflicts: [{ conflicting_item_id: "work-older", reason: "Potentially superseded" }],
	};
	const result = projectedToolResult("record_implementation", unwrapMcpResult(mcpJson(payload)));
	assert.deepEqual(extractItemRef(result), { id: "work-789", title: "Shape lifecycle response" });
	assert.deepEqual(extractFlags("record_implementation", result.details), [{
		key: "item_conflict:work-older",
		kind: "item_conflict",
		label: "item …rk-older: Potentially superseded (settle with resolve_action_item_conflict)",
	}]);
	clearAllFlags();
	resetStatus();
	const claim = projectedToolResult("claim_work_item", unwrapMcpResult(mcpJson(payload)));
	consumeResultMechanics("claim_work_item", claim);
	assert.equal(getStatusSnapshot().workId, "work-789");
	assert.equal(listFlags()[0]?.key, "item_conflict:work-older");
	consumeResultMechanics("record_implementation", result);
	assert.equal(getStatusSnapshot().workId, undefined);
	clearAllFlags();
	resetStatus();
});

test("Pi OpenAI completions, Codex/responses, and Google adapters serialize content, never details", () => {
	const secret = "DETAILS-MUST-NOT-ENTER-MODEL-CONTEXT";
	const context = toolContext(secret);
	const openAI = convertOpenAICompletionsMessages(model("openai-completions") as never, context as never, {} as never);
	// Codex and OpenAI Responses use this exported shared converter.
	const codex = convertResponsesMessages(model("openai-codex-responses") as never, context as never, new Set(["test"]));
	const google = convertGoogleMessages(model("google-generative-ai") as never, context as never);
	for (const [provider, wire] of [["OpenAI completions", openAI], ["OpenAI Codex", codex], ["Google", google]] as const) {
		const encoded = JSON.stringify(wire);
		assert.match(encoded, /compact visible content/, provider);
		assert.doesNotMatch(encoded, new RegExp(secret), provider);
		assert.doesNotMatch(encoded, /hidden/, provider);
	}
});

test("Pi Anthropic adapter payload hook observes content, never details", async () => {
	const secret = "ANTHROPIC-DETAILS-MUST-STAY-HIDDEN";
	let captured: unknown;
	const sentinel = new Error("captured-before-network");
	const events = streamAnthropic(model("anthropic-messages") as never, toolContext(secret) as never, {
		client: {} as never,
		onPayload(payload) {
			captured = payload;
			throw sentinel;
		},
	} as never);
	const terminal = await events.result();
	assert.equal(terminal.stopReason, "error");
	assert.match(terminal.errorMessage ?? "", /captured-before-network/);
	const wire = JSON.stringify(captured);
	assert.match(wire, /compact visible content/);
	assert.doesNotMatch(wire, new RegExp(secret));
	assert.doesNotMatch(wire, /hidden/);
});
