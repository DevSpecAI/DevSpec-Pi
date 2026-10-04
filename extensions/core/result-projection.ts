/**
 * Pure, model-visible projections for structured DevSpec MCP results.
 *
 * Pi persists `details` for extension/session consumers, while provider adapters
 * send tool-result `content` to the model. These projections therefore remove
 * repeated/storage-only data only where the verb contract permits it. Exact
 * reads stay lossless, and every compact family has a production output budget.
 */

import { disagreementBlock, reviewData } from "./review-context.ts";

export interface ProjectionInput {
	toolName: string;
	text: string;
	details: unknown;
}

export type ProjectionFamily = "project" | "collection" | "help" | "ack" | "full" | "fallback";

export const PROJECTION_BUDGETS = {
	project: 28_000,
	collection: 4_500,
	help: 12_000,
	ack: 5_000,
	// record_implementation can carry up to 30 own and 30 brief criteria.
	// Their actionable follow-through is load-bearing, not acknowledgement noise.
	recordImplementation: 28_000,
	fallback: 6_000,
} as const;

const CARD_LIMIT = 7;
const CARD_BUDGET = 560;
const RELATED_LIMIT = 3;
const MANUAL_FOLLOWUP_LIMIT = 3;
const PENDING_PROPOSAL_LIMIT = 2;
const LINE_LIMIT = 240;
// High on purpose: these are binding inputs, not repeated metadata. The cap is
// only a pathological-payload guard and carries an exact recovery instruction.

const COLLECTION_VERBS = new Set([
	"list_projects",
	"get_action_items",
	"search_action_items",
	"get_resources",
	"search_resources",
	"search_memories",
	"get_decisions",
	"get_conventions",
	"get_unresolved_questions",
	"get_recent_sessions",
	"search_sessions",
	"search_discussion_points",
	"get_automation_runs",
	"get_automations",
]);

const FULL_READ_VERBS = new Set([
	// Exact implementation/decision inputs are intentionally exempt from compact
	// family budgets. Arbitrary truncation would not have a lossless continuation.
	"get_action_item",
	// A pull request's provenance umbrella is one exact entity read; every list in it
	// is already bounded by the joins, and its `absent` sentences must reach the model whole.
	"get_pull_request",
	"get_memory",
	"get_resource",
	"get_testing_brief",
	"get_action_item_history",
	"get_action_item_siblings",
	"get_automation",
	"get_goals",
	"get_project_goals",
	"claim_work_item",
	"get_session_transcript",
	"get_discussion_point",
	"preview_conflict_resolution",
	"get_project_instruction_rules",
	"get_personal_instructions",
	"get_workflow_rules",
	"search_devspec_tools",
	"validate_commit_reference",
	// Projection does not receive call parameters, so conservatively keep both
	// focused query/table reads and whole-schema reads lossless.
	"get_database_schema",
	// These mutate/claim, but their responses are read-like contracts containing
	// briefing, permission, previews, resulting text, or mandatory instructions.
	"create_session",
	"claim_automation_run",
	// Every review-queue entry is a decision waiting on a person; a dropped row
	// reads as "nothing outstanding", so the whole queue survives projection.
	"get_review_queue",
	"import_instruction_rules",
	"update_personal_instructions",
	// Knowledge writes can return an exact preview/receipt or a new version id.
	// Keep update_memory lossless: an acknowledgement alone would drop the
	// preview that must be reviewed before an overrule, or its stale context.
	"update_memory",
	// Every connection-bound ledger mutation/read returns the authoritative
	// revisioned object; there is no safe continuation for omitted state.
	"manage_plan",
	"manage_poll",
	"manage_directed_question",
	// Same shape: revisioned link mutations plus `list`, whose companion rows
	// must reach the model whole — a silently dropped link reads as "not linked".
	"manage_knowledge_links",
]);

const ACK_VERBS = new Set([
	"update_action_item",
	"create_action_item",
	"add_commit_reference",
	"add_implementation_note",
	"record_automation_run",
	"create_automation",
	"update_automation",
	"delete_automation",
	"create_resource",
	"release_work_item",
	"record_implementation",
	"fail_work_item",
	"report_progress",
	"record_completed_work",
	"send_agent_message",
	"submit_plan_review",
	"reopen_action_item",
	"spin_off_action_item",
	"resolve_action_item_conflict",
	"resolve_action_item_decision_flag",
	"link_action_items",
	"unlink_action_items",
	"verify_action_item",
	"record_criterion_verdicts",
	"classify_criterion",
	"record_memory",
	"manage_discussion_point",
	"supersede_memory",
	"retract_memory",
	"update_resource",
	"supersede_resource",
	"archive_resource",
	"resolve_resource_flag",
	"resolve_memory_flag",
	"surface_session_action_items",
	"control_connection",
	"reserve_work_items",
	"write_project_instruction_rule",
]);

const ROW_KEYS = [
	"results", "items", "action_items", "memories", "resources", "projects", "goals", "sessions",
	"automations", "runs", "reviews", "matches", "data",
] as const;
const COUNT_KEYS = ["total_matching", "total", "count"] as const;
const ACK_GATE_KEYS = [
	"review_before_proceeding",
	"check_against_decisions",
	"related_decisions",
	"memory_reconciliation",
	"reconcile_required",
	"closest_match",
	"potential_conflicts",
	"near_duplicates",
	"unresolved_conflicts",
	"related_candidates",
	"human_actions_required",
	"manual_followup_steps",
	"own_criteria_follow_through",
	"brief_follow_through",
	"blocked",
	"is_blocked",
	"claimed",
] as const;

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function hasOwn(row: Row, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(row, key);
}

function scalar(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function first(row: Row, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = scalar(row[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function oneLine(value: unknown, max = LINE_LIMIT): string | undefined {
	const raw = scalar(value);
	if (!raw) return undefined;
	const flat = raw.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function json(value: unknown): string | null {
	try {
		const encoded = JSON.stringify(value, null, 2);
		return encoded === undefined ? null : encoded;
	} catch {
		return null;
	}
}

function safeDashboardUrl(value: unknown): string | undefined {
	const raw = scalar(value);
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function safeCiteUrl(value: unknown): string | undefined {
	const raw = scalar(value);
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		parsed.username = "";
		parsed.password = "";
		return oneLine(parsed.toString(), 500);
	} catch {
		return undefined;
	}
}

/** Join whole blocks only. Known projections are never sliced mid-JSON/card. */
function withinBudget(blocks: readonly string[], budget: number, family: string): string {
	const nonempty = blocks.filter((block) => block.trim().length > 0);
	const complete = nonempty.join("\n");
	if (complete.length <= budget) return complete;

	const included: string[] = [];
	let omitted = 0;
	for (let index = 0; index < nonempty.length; index += 1) {
		const block = nonempty[index];
		const prospectiveOmitted = omitted + 1;
		const remaining = nonempty.length - index - 1;
		const note = `[${prospectiveOmitted + remaining} ${family} block(s) omitted from model-visible content to stay within the ${budget}-character budget; complete data is host-retained in details, which is not a model-visible continuation.]`;
		const candidate = [...included, block, note].join("\n");
		if (candidate.length <= budget) included.push(block);
		else omitted += 1;
	}
	const note = `[${omitted} ${family} block(s) omitted from model-visible content to stay within the ${budget}-character budget; complete data is host-retained in details, which is not a model-visible continuation.]`;
	while (included.length > 0 && [...included, note].join("\n").length > budget) included.pop();
	return [...included, note].join("\n");
}

/** Required blocks are reserved before optional detail and are never dropped. */
function withinBudgetRequired(
	requiredBlocks: readonly string[],
	optionalBlocks: readonly string[],
	budget: number,
	family: string,
): string {
	const required = requiredBlocks.filter((block) => block.trim().length > 0);
	const requiredText = required.join("\n");
	if (requiredText.length > budget) {
		// Known required fields are individually bounded. Reaching this guard means
		// the server exceeded its documented cardinality; preserve truth over a lie.
		return `${requiredText}\n[Required ${family} data exceeded the ${budget}-character safety budget; nothing mandatory was hidden.]`;
	}
	const optional = optionalBlocks.filter((block) => block.trim().length > 0);
	if (!optional.length) return requiredText;
	const included = [...required];
	let omitted = 0;
	for (let index = 0; index < optional.length; index += 1) {
		const block = optional[index];
		const note = `[${omitted + 1 + optional.length - index - 1} optional ${family} block(s) omitted to preserve mandatory data within the ${budget}-character budget.]`;
		if ([...included, block, note].join("\n").length <= budget) included.push(block);
		else omitted += 1;
	}
	if (!omitted) return included.join("\n");
	const note = `[${omitted} optional ${family} block(s) omitted to preserve mandatory data within the ${budget}-character budget.]`;
	while (included.length > required.length && [...included, note].join("\n").length > budget) included.pop();
	return [...included, note].join("\n");
}

export function projectionFamily(toolName: string): ProjectionFamily {
	if (toolName === "get_project_summary") return "project";
	if (toolName === "devspec_help_search") return "help";
	if (COLLECTION_VERBS.has(toolName)) return "collection";
	if (FULL_READ_VERBS.has(toolName)) return "full";
	if (ACK_VERBS.has(toolName)) return "ack";
	return "fallback";
}

function nestedEntity(root: Row): Row {
	for (const key of ["item", "action_item", "memory", "resource", "automation", "goal", "project", "session", "assignment", "run"]) {
		const found = record(root[key]);
		if (found) return found;
	}
	return root;
}

function boundedId(row: Row, outer: Row = row): string | undefined {
	return oneLine(
		first(row, ["id", "action_item_id", "memory_id", "resource_id", "project_id", "session_id", "run_id", "criterion_id"])
			?? first(outer, ["id", "action_item_id", "memory_id", "resource_id", "project_id", "session_id", "run_id", "criterion_id"]),
		90,
	);
}

function signalLabels(row: Row): string[] {
	const labels: string[] = [];
	const unresolved = Array.isArray(row.unresolved_conflicts) ? row.unresolved_conflicts : [];
	if (unresolved.length > 0) labels.push(`${unresolved.length} unresolved conflict${unresolved.length === 1 ? "" : "s"}`);
	const review = Array.isArray(row.review_signals)
		? row.review_signals
		: Array.isArray(row.signals)
			? row.signals
			: [];
	for (const raw of review.slice(0, 2)) {
		const signal = typeof raw === "string" ? oneLine(raw, 80) : oneLine(first(record(raw) ?? {}, ["type", "signal_type", "kind"]), 80);
		if (signal) labels.push(signal.replace(/_/g, " "));
	}
	if (row.reconcile_required === true) labels.push("reconcile required");
	if (row.claimed === false) labels.push("not claimed");
	if (row.blocked === true || row.is_blocked === true) labels.push("blocked");
	if (Array.isArray(row.human_actions_required) && row.human_actions_required.length > 0) {
		labels.push(`${row.human_actions_required.length} human action${row.human_actions_required.length === 1 ? "" : "s"}`);
	}
	return [...new Set(labels)].slice(0, 4);
}

/**
 * A change someone has PROPOSED against this record, awaiting a maintainer
 * (DevSpec item 38576d61). The card still shows the decided record; these lines
 * say a change is waiting on it, who proposed it and which proposal.
 *
 * The server writes each `line` for exactly this purpose, so Pi renders what it
 * was sent rather than composing its own sentence about proposals — the wording
 * of what a queued write means belongs to the served contract, not to a plugin.
 * Only when a row arrives without a `line` does this compose one from the parts.
 *
 * These go in a card's REQUIRED blocks: an annotation that is dropped under
 * budget pressure is the bug this fixes, not a smaller version of it.
 */
function pendingProposalLines(row: Row, outer: Row): string[] {
	const source = Array.isArray(row.pending_proposals)
		? row.pending_proposals
		: Array.isArray(outer.pending_proposals)
			? outer.pending_proposals
			: [];
	const lines: string[] = [];
	for (const raw of source.slice(0, PENDING_PROPOSAL_LIMIT)) {
		const entry = record(raw);
		if (!entry) continue;
		const served = oneLine(entry.line, LINE_LIMIT);
		if (served) {
			lines.push(served);
			continue;
		}
		const what = oneLine(first(entry, ["what", "kind"]), 80) ?? "proposed change";
		const by = oneLine(entry.by, 80);
		const id = oneLine(entry.proposal_id, 90);
		lines.push(
			`\u26a0 ${what}${by ? ` by ${by}` : ""}, awaiting a maintainer${id ? ` (proposal ${id})` : ""}`,
		);
	}
	const remaining = source.length - lines.length;
	if (lines.length && remaining > 0) {
		lines.push(`\u26a0 ${remaining} further proposed change(s) awaiting a maintainer.`);
	}
	return lines;
}

/**
 * Suggested work that is not agreed yet, or that a Maintainer declined (DevSpec
 * decision 2ec0e288). The server attaches `agreement` only to such rows and writes
 * its `line`, so Pi renders what it was sent, the same way as a pending proposal.
 * A required block: dropping it under budget would show a suggestion as agreed work.
 */
function agreementLine(row: Row, outer: Row): string | null {
	const entry = record(row.agreement) ?? record(outer.agreement);
	if (!entry) return null;
	const served = oneLine(entry.line, LINE_LIMIT);
	if (served) return `\u26a0 ${served}`;
	const state = oneLine(entry.state, 40);
	return state ? `\u26a0 Not agreed work (${state}).` : null;
}

function card(raw: unknown, index: number): string {
	const outer = record(raw) ?? { value: raw };
	const row = nestedEntity(outer);
	const id = boundedId(row, outer);
	const title = oneLine(first(row, ["title", "name", "key", "subject"]), 140) ?? "Untitled";
	const metadata: string[] = [];
	for (const keys of [
		["lifecycle", "lifecycle_state"],
		["state", "status"],
		["type", "item_type", "memory_type", "resource_type"],
		["priority"],
		["source", "source_type"],
		["matched_by", "matchedBy"],
	] as const) {
		const value = oneLine(first(row, keys), 70);
		if (value && !metadata.includes(value)) metadata.push(value);
	}
	const matchCount = Number(first(row, ["match_count", "matchCount"]));
	if (Number.isFinite(matchCount) && matchCount > 0) {
		const label = `${matchCount} match${matchCount === 1 ? "" : "es"}`;
		if (!metadata.includes(label)) metadata.push(label);
	}
	const parentRow = record(row.parent) ?? record(row.brief);
	const parent = oneLine(
		first(row, ["parent_title", "brief_title", "parent_action_item_id", "parent_id"])
			?? (parentRow ? first(parentRow, ["title", "name", "id"]) : undefined),
		140,
	);
	const why = oneLine(
		first(outer, ["why", "why_matched", "match_reason", "matching_passage", "intent", "snippet", "summary", "description_preview", "content_preview", "excerpt"])
			?? first(row, ["why", "matching_passage", "intent", "summary", "snippet", "description_preview", "content_preview", "excerpt"]),
		200,
	);
	const created = oneLine(first(row, ["created_at", "createdAt"]), 40);
	const started = created ? undefined : oneLine(first(row, ["started_at", "startedAt"]), 40);
	const age = created || started ? undefined : oneLine(first(row, ["age"]), 30);
	const lastActivity = oneLine(first(row, ["last_activity_at", "lastActivityAt", "last_activity"]), 40);
	const timeline = [created && `created ${created}`, started && `started ${started}`, age && `age ${age}`, lastActivity && `last activity ${lastActivity}`]
		.filter((value): value is string => Boolean(value));
	const signals = [...new Set([...signalLabels(outer), ...signalLabels(row)])];
	const required = [`${index + 1}. ${id ? `[${id}] ` : ""}${title}${metadata.length ? ` — ${metadata.join(" · ")}` : ""}`];
	// A card exists to decide whether an exact read is worth paying for. Parent,
	// chronology, intent/matching passage and a pending proposal against the record
	// are therefore selection inputs, not decorative fields that may disappear
	// before optional repo/signal metadata.
	if (parent) required.push(`   parent/brief: ${parent}`);
	if (timeline.length) required.push(`   ${timeline.join(" · ")}`);
	if (why) required.push(`   ${why}`);
	const agreement = agreementLine(row, outer);
	if (agreement) required.push(`   ${agreement}`);
	for (const line of pendingProposalLines(row, outer)) required.push(`   ${line}`);
	const disagreements = disagreementBlock(row, 1_600);
	if (disagreements) required.push(disagreements);
	const optional: string[] = [];
	const repos = Array.isArray(row.repos) ? row.repos : [];
	if (repos.length) {
		const names = repos.slice(0, 2)
			.map((entry) => oneLine(first(record(entry) ?? {}, ["full_name", "name", "url"]), 120))
			.filter((entry): entry is string => Boolean(entry));
		if (names.length) optional.push(`   repos: ${names.join(", ")}`);
	}
	if (signals.length) optional.push(`   signals: ${signals.join(", ")}`);
	return withinBudgetRequired(required, optional, CARD_BUDGET, "card field");
}

interface FoundRows {
	rows: unknown[];
	recognized: boolean;
	briefCount: number;
}

function genericRows(root: Row): FoundRows {
	for (const key of ROW_KEYS) {
		if (Array.isArray(root[key])) return { rows: root[key] as unknown[], recognized: true, briefCount: 0 };
	}
	for (const key of ["page", "result"] as const) {
		const nested = record(root[key]);
		if (!nested) continue;
		const found = genericRows(nested);
		if (found.recognized) return found;
	}
	const hasCount = [root, record(root.page)].some((container) =>
		container && COUNT_KEYS.some((key) => typeof container[key] === "number" && Number.isFinite(container[key])),
	);
	return { rows: [], recognized: hasCount, briefCount: 0 };
}

function collectionRows(toolName: string, root: Row): FoundRows {
	if (toolName === "search_resources") {
		const hasDocuments = Array.isArray(root.documents);
		const hasArtifacts = Array.isArray(root.artifacts);
		if (!hasDocuments && !hasArtifacts) return genericRows(root);
		const documents = hasDocuments ? root.documents as unknown[] : [];
		const artifacts = hasArtifacts ? root.artifacts as unknown[] : [];
		const rows: unknown[] = [];
		// The server searches these as two independent corpora. Interleave them so
		// one full corpus cannot hide every hit from the other at the card budget.
		for (let index = 0; index < Math.max(documents.length, artifacts.length); index += 1) {
			if (index < documents.length) rows.push(documents[index]);
			if (index < artifacts.length) rows.push(artifacts[index]);
		}
		return { rows, recognized: true, briefCount: 0 };
	}
	if (toolName !== "get_action_items") return genericRows(root);
	const hasItems = Array.isArray(root.items);
	const hasBriefs = Array.isArray(root.briefs);
	if (!hasItems && !hasBriefs) return genericRows(root);
	const combined: unknown[] = [];
	const seen = new Set<string>();
	let briefCount = 0;
	// Page rows carry the caller's requested queue/chronological order. Briefs are
	// contextual rollups, so they must never jump ahead and destroy that order.
	for (const raw of hasItems ? root.items as unknown[] : []) {
		const row = record(raw);
		const id = row ? boundedId(nestedEntity(row), row) : undefined;
		if (id && seen.has(id)) continue;
		if (id) seen.add(id);
		combined.push(raw);
	}
	for (const raw of hasBriefs ? root.briefs as unknown[] : []) {
		const row = record(raw);
		const id = row ? boundedId(nestedEntity(row), row) : undefined;
		if (id && seen.has(id)) continue;
		if (id) seen.add(id);
		combined.push(raw);
		briefCount += 1;
	}
	return { rows: combined, recognized: true, briefCount };
}

function totalRows(root: Row, found: number): number {
	for (const container of [record(root.page), root]) {
		if (!container) continue;
		for (const key of COUNT_KEYS) {
			const value = container[key];
			if (typeof value === "number" && Number.isFinite(value)) return Math.max(value, found);
		}
	}
	return found;
}

function fetchHint(toolName: string): string {
	if (toolName.includes("action_item")) return "Fetch an exact item with get_action_item(id); rerun with a narrower filter or next offset/page for more.";
	if (toolName.includes("memor") || ["get_decisions", "get_conventions", "get_unresolved_questions"].includes(toolName)) {
		return "Fetch an exact memory with get_memory(id); rerun the list/search with a narrower filter for more.";
	}
	if (toolName.includes("resource")) return "Fetch an exact resource with get_resource(id); rerun the list/search with a narrower filter for more.";
	if (toolName.includes("project")) return "Use get_project_summary for an exact project; refine project scope or pagination for more.";
	if (toolName === "search_sessions" || toolName === "get_recent_sessions") {
		return "Call get_session_transcript with a session_id to read one room.";
	}
	return `Rerun ${toolName} with a narrower filter or pagination to fetch more; use the entity's exact get tool when available.`;
}

function collectionProjection(toolName: string, details: unknown): string | null {
	const root = record(details) ?? (Array.isArray(details) ? { results: details } : null);
	if (!root) return null;
	const found = collectionRows(toolName, root);
	if (!found.recognized) return null;
	const shown = found.rows.slice(0, CARD_LIMIT);
	const primaryCount = toolName === "get_action_items"
		? Math.max(0, found.rows.length - found.briefCount)
		: found.rows.length;
	const total = totalRows(root, primaryCount);
	const summary = record(root.summary);
	const counts = summary ? record(summary.ui_buckets) ?? record(summary.lifecycle_breakdown) : null;
	const heading = toolName === "get_action_items" && found.briefCount > 0
		? `${toolName}: ${total} result${total === 1 ? "" : "s"}; ${found.briefCount} additional contextual brief card(s); showing ${shown.length} combined card(s).`
		: `${toolName}: ${total} result${total === 1 ? "" : "s"}${shown.length < total ? `; showing ${shown.length}` : ""}.`;
	const blocks = [heading];
	if (counts) {
		const compactCounts = Object.entries(counts)
			.filter(([, value]) => typeof value === "number")
			.slice(0, 8)
			.map(([key, value]) => `${oneLine(key.replace(/_/g, " "), 60)}=${value}`);
		if (compactCounts.length) blocks.push(`Counts: ${compactCounts.join(", ")}`);
	}
	for (const [index, row] of shown.entries()) blocks.push(card(row, index));
	if (total === 0 && found.briefCount === 0) blocks.push("No matching entities returned (recognized empty result set).");
	if (toolName === "get_action_items") {
		const shownPrimary = Math.min(shown.length, primaryCount);
		const shownBriefs = Math.max(0, shown.length - shownPrimary);
		const omittedPrimary = Math.max(0, total - shownPrimary);
		const omittedBriefs = Math.max(0, found.briefCount - shownBriefs);
		if (omittedPrimary > 0) blocks.push(`Omitted ${omittedPrimary} action-item result(s) from model-visible content.`);
		if (omittedBriefs > 0) blocks.push(`Omitted ${omittedBriefs} contextual brief card(s) from model-visible content.`);
	} else {
		const omitted = Math.max(total - shown.length, found.rows.length - shown.length);
		if (omitted > 0) blocks.push(`Omitted ${omitted} result(s) from model-visible content.`);
	}
	blocks.push(fetchHint(toolName));
	return withinBudget(blocks, PROJECTION_BUDGETS.collection, "collection");
}

function sectionExcerpt(value: unknown, max = 1_100): string | undefined {
	const source = scalar(value);
	if (!source) return undefined;
	if (source.length <= max) return source;
	let boundary = source.lastIndexOf("\n\n", max);
	if (boundary < max / 2) boundary = source.lastIndexOf(". ", max);
	if (boundary < max / 2) boundary = source.lastIndexOf(" ", max);
	if (boundary < max / 2) boundary = max;
	return `${source.slice(0, boundary).trimEnd()}…\n[${source.length - boundary} section character(s) omitted; rerun devspec_help_search with a narrower query and cite the returned URL.]`;
}

function helpProjection(details: unknown): string | null {
	const root = record(details);
	if (!root || !Array.isArray(root.results)) return null;
	const query = oneLine(root.query, 240);
	const total = typeof root.count === "number" ? Math.max(root.count, root.results.length) : root.results.length;
	const shown = (root.results as unknown[]).slice(0, 8);
	const blocks = [`DevSpec help${query ? ` for “${query}”` : ""}: ${total} section${total === 1 ? "" : "s"}; showing ${shown.length}.`];
	for (const [index, raw] of shown.entries()) {
		const hit = record(raw);
		if (!hit) continue;
		const doc = oneLine(first(hit, ["doc", "document", "title"]), 160) ?? "DevSpec help";
		const section = oneLine(first(hit, ["section", "section_title", "heading"]), 180);
		const category = oneLine(hit.category, 80);
		const url = safeCiteUrl(hit.url);
		const content = sectionExcerpt(first(hit, ["content", "text", "body"]));
		const lines = [`${index + 1}. ${doc}${section ? ` — ${section}` : ""}${category ? ` [${category}]` : ""}`];
		if (url) lines.push(`   URL: ${url}`);
		if (content) lines.push(content);
		blocks.push(lines.join("\n"));
	}
	if (total > shown.length) blocks.push(`Omitted ${total - shown.length} lower-ranked section(s).`);
	blocks.push("For more or fuller text, rerun devspec_help_search with a narrower query; cite the returned URL in the answer.");
	return withinBudget(blocks, PROJECTION_BUDGETS.help, "help section");
}

function selectedScalars(source: Row | null, keys: readonly string[]): string[] {
	if (!source) return [];
	const lines: string[] = [];
	for (const key of keys) {
		const value = oneLine(source[key], 160);
		if (value !== undefined) lines.push(`${key.replace(/_/g, " ")}: ${value}`);
	}
	return lines;
}

function completeProjectSummary(details: unknown): string | null {
	const root = record(details);
	if (!root) return null;
	const omitted: string[] = [];
	function safe(value: unknown, path = ""): unknown {
		if (Array.isArray(value)) return value.map((v, i) => safe(v, `${path}[${i}]`));
		const row = record(value);
		if (!row) return value;
		return Object.fromEntries(Object.entries(row).flatMap(([key, v]) => {
			const field = path ? `${path}.${key}` : key;
			// Redaction is explicit and semantic, never a content-size quota.
			if (/^(password|token|access_token|refresh_token|api_key|authorization|connection_string|email)$/i.test(key)
				|| (!path && ["autopilot", "local_plugin_settings"].includes(key))
				|| (path === "execution" && key === "test_commands")) {
				omitted.push(field); return [];
			}
			if (/url$/i.test(key) && typeof v === "string" && /^https?:/.test(v)) {
				const cleaned = safeDashboardUrl(v);
				if (cleaned !== v) omitted.push(`${field} (URL credentials/query/fragment)`);
				return [[key, cleaned ?? null]];
			}
			return [[key, safe(v, field)]];
		}));
	}
	const data = safe(root);
	const json = JSON.stringify(data, null, 2).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
	return `Project summary data (complete, except explicitly listed security/retired compatibility fields).\n<devspec-project-data>\n${json}\n</devspec-project-data>${omitted.length ? `\nOmitted security/retired compatibility fields:\n<devspec-omitted-fields>\n${JSON.stringify(omitted).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}\n</devspec-omitted-fields>` : ""}`;
}

function conflictBlocks(root: Row): string[] {
	const disagreements = disagreementBlock(root);
	const blocks: string[] = disagreements ? [disagreements] : [];
	const unresolved = Array.isArray(root.unresolved_conflicts) ? root.unresolved_conflicts : [];
	if (unresolved.length) {
		const lines = [`Gate — unresolved conflicts: ${unresolved.length}; showing top ${Math.min(unresolved.length, RELATED_LIMIT)}.`];
		for (const raw of unresolved.slice(0, RELATED_LIMIT)) {
			const row = record(raw) ?? {};
			const id = oneLine(first(row, ["conflicting_item_id", "item_id", "id"]), 90) ?? "unknown";
			lines.push(`- [${id}] ${oneLine(first(row, ["reason", "summary", "title"]), 180) ?? "possible conflict"}`);
		}
		if (unresolved.length > RELATED_LIMIT) lines.push(`- ${unresolved.length - RELATED_LIMIT} additional unresolved conflict(s) omitted; fetch the exact item and inspect its unresolved_conflicts before proceeding.`);
		blocks.push(lines.join("\n"));
	}
	// The write gate stops memory AND document writes alike (devspecv2 134f4454).
	// Nothing was written, and the closest record is named below.
	if (root.reconcile_required === true) blocks.push("Gate — the write check named a close existing record; nothing was written. Read it, then supersede/update it, or re-call with confirm_new if it is genuinely separate.");
	if (root.claimed === false) blocks.push("Gate — claim rejected/not acquired.");
	if (root.blocked === true || root.is_blocked === true) blocks.push("Gate — result is blocked.");
	return blocks;
}

function gateValue(label: string, value: unknown): string {
	if (Array.isArray(value)) return `${label}: ${value.length} item(s).`;
	const row = record(value);
	if (row) {
		const facts = selectedScalars(row, ["required", "status", "action", "instruction", "reason", "message"]);
		return `${label}:${facts.length ? ` ${facts.join(" · ")}` : " present; inspect the candidate summaries below and fetch exact entities before proceeding."}`;
	}
	return `${label}: ${oneLine(value, 260) ?? "present"}`;
}

function relatedBlock(label: string, values: unknown[], fetch: string): string {
	const lines = [`${label}: ${values.length}; showing top ${Math.min(values.length, RELATED_LIMIT)}.`];
	for (const [index, value] of values.slice(0, RELATED_LIMIT).entries()) lines.push(card(value, index));
	if (values.length > RELATED_LIMIT) lines.push(`${values.length - RELATED_LIMIT} additional ${label.toLowerCase()} omitted; ${fetch}.`);
	return lines.join("\n");
}

function mandatoryCategoryBlock(label: string, values: unknown[], category = "Gate category"): string {
	const firstValue = record(values[0]);
	const entity = firstValue ? nestedEntity(firstValue) : null;
	const id = entity && firstValue ? boundedId(entity, firstValue) : undefined;
	const reason = oneLine(
		firstValue
			? first(firstValue, ["why", "reason", "why_matched", "match_reason", "summary", "title"])
				?? (entity ? first(entity, ["why", "reason", "summary", "title", "name"]) : undefined)
			: values[0],
		160,
	) ?? "reason not returned";
	return `${category} — ${label}: ${values.length}; first=${id ? `[${id}] ` : ""}${reason}${values.length > 1 ? `; ${values.length - 1} more omitted from this mandatory summary` : ""}.`;
}

function candidateRows(value: unknown, keys: readonly string[] = ["candidates", "items", "results"]): unknown[] {
	if (Array.isArray(value)) return value;
	const container = record(value);
	if (!container) return [];
	const rows: unknown[] = [];
	for (const key of keys) if (Array.isArray(container[key])) rows.push(...container[key] as unknown[]);
	return rows;
}

function uniqueRows(values: readonly unknown[]): unknown[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const row = record(value);
		const id = row ? boundedId(nestedEntity(row), row) : undefined;
		if (!id) return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

function criterionLines(value: unknown): string[] {
	const container = record(value);
	const groups: Array<[string, unknown[]]> = [];
	if (Array.isArray(value)) groups.push(["criteria", value]);
	if (container) {
		for (const key of [
			"criteria", "unchecked_criteria", "criteria_to_check", "criterion_ids",
			"go_and_check", "weak_evidence", "failed", "leave_for_a_person", "unsettled_criteria",
		] as const) {
			if (Array.isArray(container[key])) groups.push([key, container[key] as unknown[]]);
		}
	}
	if (!groups.length) return [];
	const lines: string[] = [];
	for (const [group, candidates] of groups) {
		for (const raw of candidates) {
			const criterion = record(raw);
			if (!criterion) {
				lines.push(`- ${group}: [${oneLine(raw, 100) ?? "unknown"}] check and record an observed verdict.`);
				continue;
			}
			const id = oneLine(first(criterion, ["criterion_id", "id", "acceptance_criterion_id"]), 90) ?? "unknown";
			const instruction = oneLine(first(criterion, ["instruction", "prompt", "action", "text", "description", "criterion"]), 180) ?? "check this criterion and record an observed verdict";
			const reason = oneLine(first(criterion, ["reason", "status"]), 100);
			lines.push(`- ${group}: [${id}] ${instruction}${reason ? ` (reason: ${reason})` : ""}`);
		}
	}
	return lines;
}

function followThroughBlock(kind: "own" | "brief", value: unknown): string {
	const label = kind === "own" ? "Own-criteria follow-through" : "Brief follow-through";
	if (value === false) return `${label}: none requested.`;
	const row = record(value);
	const lines = [`${label} (act before reporting):`];
	if (row) {
		const brief = record(row.brief);
		if (kind === "brief") {
			const id = oneLine(first(row, ["brief_action_item_id", "action_item_id", "brief_id", "id"]) ?? (brief ? first(brief, ["id", "action_item_id"]) : undefined), 90);
			const title = oneLine(first(row, ["brief_title", "title", "name"]) ?? (brief ? first(brief, ["title", "name"]) : undefined), 160);
			if (id || title) lines.push(`- brief: ${id ? `[${id}]` : ""}${id && title ? " " : ""}${title ?? ""}`);
		} else {
			const id = oneLine(first(row, ["action_item_id", "item_id", "id"]), 90);
			if (id) lines.push(`- item: [${id}]`);
		}
		for (const key of [
			"band", "children_total", "children_resolved", "percent_complete", "criteria_total", "criteria_settled",
			"action", "instruction", "prompt", "message", "status",
		] as const) {
			const text = oneLine(row[key], 360);
			if (text) lines.push(`- ${key}: ${text}`);
		}
	}
	lines.push(...criterionLines(value));
	if (lines.length === 1) lines.push(`- ${oneLine(value, 400) ?? "follow-through required; fetch the exact item and inspect its acceptance criteria before reporting"}`);
	return lines.join("\n");
}

function manualFollowUpBlock(root: Row): string | null {
	const human = [
		...(Array.isArray(root.human_actions_required) ? root.human_actions_required : []),
		...(Array.isArray(root.manual_followup_steps) ? root.manual_followup_steps : []),
	];
	if (!human.length) return null;
	const lines = [`Manual/human follow-up: ${human.length}; showing ${Math.min(human.length, MANUAL_FOLLOWUP_LIMIT)}.`];
	for (const raw of human.slice(0, MANUAL_FOLLOWUP_LIMIT)) {
		const row = record(raw);
		const id = row ? oneLine(first(row, ["id", "step_id"]), 90) : undefined;
		const kind = row ? oneLine(first(row, ["kind", "type"]), 60) : undefined;
		const description = oneLine(row ? first(row, ["description", "text", "title", "instruction"]) : raw, 180) ?? "unspecified action";
		lines.push(`- ${id ? `[${id}] ` : ""}${kind ? `${kind}: ` : ""}${description}`);
	}
	if (human.length > MANUAL_FOLLOWUP_LIMIT) {
		const itemId = boundedId(nestedEntity(root), root);
		lines.push(`- ${human.length - MANUAL_FOLLOWUP_LIMIT} additional follow-up step(s) omitted; ${itemId ? `use get_action_item(${itemId})` : "fetch the exact action item"} to read every step before reporting.`);
	}
	return lines.join("\n");
}

function ackProjection(toolName: string, details: unknown): string | null {
	const root = record(details);
	if (!root) return null;
	const entity = nestedEntity(root);
	const id = boundedId(entity, root);
	const title = oneLine(first(entity, ["title", "name", "subject", "key"]), 160);
	const state = oneLine(first(entity, ["lifecycle", "lifecycle_state", "state", "status"]) ?? first(root, ["lifecycle", "lifecycle_state", "state", "status"]), 80);
	const outcome = oneLine(first(root, ["outcome", "result", "disposition"]) ?? first(entity, ["outcome", "result", "disposition"]), 100);
	const recognizedGate = ACK_GATE_KEYS.some((key) => hasOwn(root, key) || hasOwn(entity, key));
	if (!id && !title && !state && !outcome && !recognizedGate) return null;

	const required: string[] = [];
	const optional: string[] = [];
	const parent = oneLine(first(entity, ["parent_action_item_id", "parent_id", "parent_title", "brief_title"])
		?? first(root, ["parent_action_item_id", "parent_id", "parent_title", "brief_title"]), 140);
	const facts = [id && `id=${id}`, title && `title=${title}`, state && `state=${state}`, outcome && `outcome=${outcome}`].filter(Boolean);
	required.push(`${toolName}: ${facts.length ? facts.join(" ") : "recognized response (see gates/follow-through below)"}.`);
	if (parent) required.push(`Parent/brief: ${parent}`);
	// R7: these are operation receipts, not optional card metadata. In particular,
	// never lose the proposal/reason or an exact preview to the ack budget.
	const receipt: Row = {};
	for (const key of [
		"committed", "applied", "success", "created", "updated", "recorded", "superseded", "resolved",
		"proposal_id", "reason", "note", "authority_note", "authority", "warnings", "flag_still_lit", "marks_cleared",
		"closure", "tense", "verdict", "signal_type", "basis", "superseding_item_id", "superseded_item_id", "conflicting_id",
		"receipt", "receipt_id", "operation_id", "draft_id", "read_status", "status_url", "preview",
		"expires_at", "current_head", "expected_version", "version", "previous_id", "lineage",
		"assessment", "assessment_receipt", "comparison_pending", "needs_clarification",
	]) if (hasOwn(root, key)) receipt[key] = root[key];
	if (Object.keys(receipt).length) required.push(`Operation details (server data):\n${reviewData(receipt)}`);
	required.push(...conflictBlocks(root));
	if (entity !== root) required.push(...conflictBlocks(entity));

	for (const key of ["review_before_proceeding", "check_against_decisions"] as const) {
		if (!hasOwn(root, key)) continue;
		required.push(`Gate — ${gateValue(key, root[key])}`);
		const rows = candidateRows(root[key], key === "check_against_decisions"
			? ["decisions", "related_decisions", "candidates", "items"]
			: ["candidates", "related_candidates", "near_duplicates", "items"]);
		if (rows.length) {
			const label = key === "check_against_decisions" ? "Decisions to check" : "Review-before-proceeding candidates";
			required.push(mandatoryCategoryBlock(label, rows));
			optional.push(relatedBlock(
				label,
				rows,
				key === "check_against_decisions" ? "use get_memory(id) for the exact decision" : "fetch the exact candidate before proceeding",
			));
		}
	}
	const memoryReconciliation = record(root.memory_reconciliation);
	if (hasOwn(root, "memory_reconciliation")) required.push(`Gate — ${gateValue("memory reconciliation", root.memory_reconciliation)}`);

	if (hasOwn(root, "own_criteria_follow_through") && root.own_criteria_follow_through != null) {
		required.push(followThroughBlock("own", root.own_criteria_follow_through));
	}
	if (hasOwn(root, "brief_follow_through") && root.brief_follow_through != null) {
		required.push(followThroughBlock("brief", root.brief_follow_through));
	}
	const manual = manualFollowUpBlock(root);
	if (manual) required.push(manual);

	const relatedContainer = record(root.related_candidates);
	const groupedCandidates: Array<[string, unknown[], string]> = [
		["Related decisions", uniqueRows([
			...candidateRows(root.related_decisions),
			...candidateRows(relatedContainer?.decisions),
			...candidateRows(relatedContainer?.related_decisions),
		]), "use get_memory(id) for the full decision"],
		["Potential conflicts", uniqueRows([
			...candidateRows(root.potential_conflicts),
			...candidateRows(memoryReconciliation?.potential_conflicts),
		]), "resolve/reconcile them or fetch the exact entity"],
		["Near duplicates", uniqueRows([
			...candidateRows(root.near_duplicates),
			...candidateRows(memoryReconciliation?.near_duplicates),
		]), "search and fetch the exact candidate before proceeding"],
		["Related candidates", uniqueRows([
			...candidateRows(root.related_candidates, ["candidates", "items", "results", "action_items", "artifacts", "resources", "memories"]),
		]), "search/list then fetch the exact candidate by id"],
	];
	for (const [label, values, fetch] of groupedCandidates) {
		if (!values.length) continue;
		required.push(mandatoryCategoryBlock(label, values, "Related context (advisory)"));
		optional.push(relatedBlock(label, values, fetch));
	}
	const closestMatch = root.closest_match ?? memoryReconciliation?.closest_match;
	if (closestMatch != null) {
		// Which corpus decides which reader to name. Sending a document id to
		// get_memory returns nothing, which reads as "the gate matched something
		// that does not exist" — the exact dead end 134f4454 removed.
		const isDocument = toolName.includes("resource");
		const label = isDocument ? "Closest existing document" : "Closest existing memory";
		const fetch = isDocument
			? "use get_resource(id) and read it, then update/supersede it — or confirm_new if it is genuinely separate"
			: "use get_memory(id) and read it, then supersede it — or confirm_new if it is genuinely separate";
		required.push(mandatoryCategoryBlock(label, [closestMatch]));
		optional.push(relatedBlock(label, [closestMatch], fetch));
	}

	const budget = toolName === "record_implementation"
		? PROJECTION_BUDGETS.recordImplementation
		: PROJECTION_BUDGETS.ack;
	return withinBudgetRequired(required, optional, budget, "acknowledgement");
}

/** Structured fallbacks omit only complete top-level fields/array elements. */
function structuredFallback(toolName: string, details: unknown): string {
	const encoded = json(details) ?? "(unserializable structured payload)";
	if (encoded.length <= PROJECTION_BUDGETS.fallback) return encoded;
	const header = `Unrecognized result shape for ${toolName}; showing complete top-level fields/elements that fit the fallback budget.`;
	const blocks = [header];
	if (Array.isArray(details)) {
		for (const [index, value] of details.entries()) {
			const block = json({ index, value });
			if (block) blocks.push(block);
		}
	} else {
		const root = record(details);
		if (root) for (const [key, value] of Object.entries(root)) {
			const block = json({ [key]: value });
			if (block) blocks.push(block);
		}
	}
	blocks.push(fallbackRecovery(toolName));
	return withinBudget(blocks, PROJECTION_BUDGETS.fallback, "fallback field/element");
}

function fallbackRecovery(toolName: string): string {
	if (ACK_VERBS.has(toolName)) return "Presentation is incomplete, not evidence that the operation failed. Do not repeat this mutation. Verify with the exact record's read tool or get_review_queue; if no record/status handle was returned, report the outcome as unknown.";
	return `Rerun ${toolName} with narrower parameters if available. The complete payload is host-retained in details, which is not a model-visible continuation.`;
}

function boundedFallback(toolName: string, text: string, details: unknown): string {
	if (details != null) return structuredFallback(toolName, details);
	const source = text || "(empty response)";
	if (source.length <= PROJECTION_BUDGETS.fallback) return source;
	const note = `\n\n[Non-JSON source truncated; no structured details are available. ${fallbackRecovery(toolName)}]`;
	const available = Math.max(0, PROJECTION_BUDGETS.fallback - note.length);
	return `${source.slice(0, available)}${note}`;
}

/** Project a successful result. The caller must retain `details` unchanged. */
export function projectModelText(input: ProjectionInput): string {
	const family = projectionFamily(input.toolName);
	if (family === "full") {
		return input.details == null
			? input.text || "(empty response)"
			: (json(input.details) ?? input.text) || "(empty response)";
	}
	if (family === "project") return completeProjectSummary(input.details) ?? input.text;
	if (family === "collection") return collectionProjection(input.toolName, input.details) ?? boundedFallback(input.toolName, input.text, input.details);
	if (family === "help") return helpProjection(input.details) ?? boundedFallback(input.toolName, input.text, input.details);
	if (family === "ack") return ackProjection(input.toolName, input.details) ?? boundedFallback(input.toolName, input.text, input.details);
	return boundedFallback(input.toolName, input.text, input.details);
}
