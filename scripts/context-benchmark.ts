#!/usr/bin/env node
/**
 * Deterministic, zero-network context benchmark for DevSpec-Pi development.
 *
 * This complements assertions in the unit suite with a human-readable baseline
 * that can be compared while refining tool schemas and projections. It contains
 * synthetic data only. Sizes are diagnostic, never a quota (convention 8958f7b1):
 * a projection fails here only when content it must carry is missing.
 */

import { buildDevspecInstructions } from "../extensions/core/instructions.ts";
import { estimatePrefixTokens } from "../extensions/core/model-surface.ts";
import { projectModelText } from "../extensions/core/result-projection.ts";

function repeat(label: string, chars: number): string {
	return `${label}: ${"representative content ".repeat(Math.ceil(chars / 23))}`.slice(0, chars);
}

function projected(toolName: string, details: unknown): string {
	return projectModelText({ toolName, text: JSON.stringify(details), details });
}

const actionResults = Array.from({ length: 20 }, (_, index) => ({
	id: `item-${String(index + 1).padStart(2, "0")}`,
	title: `Representative task result ${index + 1}`,
	lifecycle: index % 3 === 0 ? "implemented" : "open",
	type: index === 0 ? "brief" : "improvement",
	priority: index < 3 ? "high" : "medium",
	created_at: `2026-08-${String(Math.min(index + 1, 28)).padStart(2, "0")}T12:00:00.000Z`,
	intent: repeat(`Intent ${index + 1}`, 260),
	parent_title: index === 0 ? null : "Context-quality brief",
	description: repeat("full description deliberately excluded", 2_000),
}));

const resourceResults = Array.from({ length: 10 }, (_, index) => ({
	id: `resource-${index + 1}`,
	title: `Representative resource ${index + 1}`,
	resource_type: index % 2 ? "plan" : "reference",
	source: index % 2 ? "ai_generated" : "uploaded",
	summary: repeat(`Summary ${index + 1}`, 300),
	matching_passage: repeat(`Matching passage ${index + 1}`, 500),
}));

const projectSummary = {
	id: "project-1",
	name: "Representative project",
	execution: {
		custom_instructions: repeat("Team principles", 4_000),
		agent_rules: repeat("Team agent rules", 4_000),
		branch_prefix: "devspec/",
	},
	owner_agent_rules: repeat("Owner agent rules", 4_000),
	repos: Array.from({ length: 8 }, (_, index) => ({ full_name: `Org/repo-${index + 1}`, target_branch: "main" })),
	members: [{ id: "user-1", displayName: "Example Person" }],
	goals: [{ id: "goal-1", title: "Ship reliable workflows", status: "current" }],
};

// A create acknowledgement is the record and its receipt: DevSpec no longer
// returns a candidate list (fce58a2f round 2). The richest real one is a create
// saved as suggested work, which carries its proposal and where it is reviewed.
const acknowledgement = {
	outcome: "queued_for_review",
	proposal_id: "proposal-1",
	effect: "suggested_work",
	code: "approval_required",
	fields: ["title", "intent", "acceptance_criteria"],
	review_url: "https://app.example.test/review/proposal-1",
	task: { id: "item-created", title: "Representative write", lifecycle: "suggested" },
};

const help = {
	query: "context budget",
	results: Array.from({ length: 8 }, (_, index) => ({
		title: `Context documentation ${index + 1}`,
		url: `https://docs.example.test/context-${index + 1}`,
		section: `Section ${index + 1}`,
		content: repeat(`Citeable help content ${index + 1}`, 800),
	})),
};

const implementation = {
	item: { id: "item-implemented", title: "Guard context quality", lifecycle: "implemented" },
	own_criteria_follow_through: {
		task_id: "item-implemented",
		criteria_total: 8,
		criteria_settled: 0,
		go_and_check: Array.from({ length: 8 }, (_, index) => ({
			criterion_id: `criterion-${index + 1}`,
			text: `Criterion ${index + 1} retains an exact verification path`,
			reason: "not_yet_checked",
		})),
		instruction: "Call record_criterion_verdicts after observing each criterion.",
	},
	brief_follow_through: {
		brief_id: "brief-context",
		brief_title: "Context quality",
		band: "final",
		children_total: 3,
		children_resolved: 3,
		percent_complete: 100,
		unsettled_criteria: Array.from({ length: 5 }, (_, index) => ({
			criterion_id: `brief-criterion-${index + 1}`,
			text: `Brief criterion ${index + 1} remains visible`,
		})),
		instruction: "Check the brief criteria now.",
	},
	manual_followup_steps: [{ kind: "note", description: "Observe the live numeric telemetry after deployment." }],
};

const fallback = {
	message: repeat("Generated commit message", 4_000),
	metadata: repeat("Optional metadata", 9_000),
};

type BenchmarkRow = {
	name: string;
	value: number;
	unit: "tokens" | "chars";
	missing: string[];
};

function projectionRow(
	name: string,
	toolName: string,
	details: unknown,
	required: string[],
): BenchmarkRow {
	const text = projected(toolName, details);
	return { name, value: text.length, unit: "chars", missing: required.filter((marker) => !text.includes(marker)) };
}

const initialSurfaceTokens = estimatePrefixTokens(buildDevspecInstructions());
const rows: BenchmarkRow[] = [
	projectionRow("task search", "search_tasks", { count: actionResults.length, results: actionResults }, ["Representative task result 1", "Intent 1", "get_task"]),
	projectionRow("resource search", "search_resources", { documents: resourceResults.slice(0, 5), artifacts: resourceResults.slice(5) }, ["Representative resource 1", "Matching passage 1", "get_resource"]),
	projectionRow("project summary", "get_project_summary", projectSummary, ["Team principles", "Team agent rules", "Owner agent rules"]),
	projectionRow("write acknowledgement", "create_task", acknowledgement, ["Representative write", "proposal-1", "review_url"]),
	projectionRow("implementation acknowledgement", "record_implementation", implementation, ["Criterion 1", "Brief criterion 1", "record_criterion_verdicts"]),
	projectionRow("help search", "devspec_help_search", help, ["Context documentation 1", "https://docs.example.test/context-1", "Citeable help content 1"]),
	projectionRow("fallback text", "generate_commit_message", fallback, ["Generated commit message", "Optional metadata"]),
];

function rowFailed(row: BenchmarkRow): boolean {
	return row.missing.length > 0;
}

const failed = rows.filter(rowFailed);
if (process.argv.includes("--json")) {
	process.stdout.write(`${JSON.stringify({ version: 4, initialSurfaceTokens, rows, passed: failed.length === 0 }, null, 2)}\n`);
} else {
	console.log("DevSpec-Pi context benchmark (deterministic synthetic fixtures)");
	console.log(`INFO  initial DevSpec surface: ${initialSurfaceTokens} estimated tokens (diagnostic, not a prose quota)`);
	for (const row of rows) {
		const details = row.missing.length > 0 ? `; missing ${row.missing.join(", ")}` : "";
		console.log(`${rowFailed(row) ? "FAIL" : "PASS"}  ${row.name}: ${row.value} ${row.unit} (diagnostic)${details}`);
	}
}
if (failed.length > 0) process.exitCode = 1;
