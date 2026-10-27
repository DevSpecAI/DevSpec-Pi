/**
 * Pure, model-visible projections for structured DevSpec MCP results.
 *
 * Pi persists `details` for extension/session consumers, while provider adapters
 * send tool-result `content` to the model. What the server returns reaches the
 * model: exact reads stay lossless, a write's receipt passes every field through,
 * an unrecognised result is shown whole, and a list shows every row the server
 * returned. The only condensing is lossless or visibly declared — a list row is a
 * card that names the exact read for its full record, and a receipt leaves out
 * empty fields and values identical to the call's own arguments, and says which.
 * There is no output budget: a field the server wants read is never dropped to
 * save tokens (DevSpec item 5a9eaa57, convention 8958f7b1).
 */

import { disagreementBlock, reviewData } from "./review-context.ts";

export interface ProjectionInput {
	toolName: string;
	text: string;
	details: unknown;
	/** The arguments the call was sent with, when known: a receipt names fields equal to them instead of repeating them. */
	args?: Record<string, unknown>;
}

export type ProjectionFamily = "project" | "collection" | "help" | "ack" | "full" | "fallback";

/**
 * A list card is a preview whose purpose is choosing which exact read to pay for.
 * Its optional metadata (repositories, signals) yields to its required lines at
 * this size and says so; the full record is always one exact read away.
 */
const CARD_BUDGET = 560;
const LINE_LIMIT = 240;

const COLLECTION_VERBS = new Set([
	"list_projects",
	"get_tasks",
	"search_tasks",
	"get_resources",
	"search_resources",
	"search_memories",
	"get_decisions",
	"get_conventions",
	"get_recent_sessions",
	"search_sessions",
	"search_discussion_points",
	"get_automation_runs",
	"get_automations",
]);

const FULL_READ_VERBS = new Set([
	// Exact implementation/decision inputs are intentionally exempt from compact
	// family budgets. Arbitrary truncation would not have a lossless continuation.
	"get_task",
	// A pull request's provenance umbrella is one exact entity read; every list in it
	// is already bounded by the joins, and its `absent` sentences must reach the model whole.
	"get_pull_request",
	"get_memory",
	"get_resource",
	"get_testing_brief",
	"get_task_history",
	"get_task_siblings",
	"get_automation",
	"get_goals",
	"get_project_goals",
	"claim_work_item",
	"get_session_transcript",
	"get_discussion_point",
	// A read-only consequence preview: who decides, what closes, any refusal and
	// what is not affected. Every sentence is the decision input, so it stays whole.
	"preview_supersession",
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
	// Exact ownership receipts: keep who adopted, revision, scope and refusals.
	// Already small; no generic acknowledgement projection (988ad64c).
	"manage_protected_intent",
	// A decision receipt: accepted, declined, refused, not_decided or unknown, with
	// what happened and what the person can do next. Already small, and a refusal
	// or an unconfirmed outcome must never read as done, so it stays whole (60fb0935).
	"decide_proposal",
	// A duplicate resolution either previews the exact snapshots, the planned
	// closure and who decides, or returns its receipt. Projection cannot see which
	// action was called, so both stay whole, as for preview_supersession (fce58a2f).
	"resolve_duplicate",
]);

const ACK_VERBS = new Set([
	"update_task",
	"create_task",
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
	"reopen_task",
	"spin_off_task",
	// A receipt: committed with the closure and tense, or queued with a proposal_id.
	"supersede_task",
	"link_tasks",
	"unlink_tasks",
	"verify_task",
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
	// An explicit not-a-duplicate ruling returns a receipt, like the flag rulings (fce58a2f).
	"record_duplicate_nonmatch",
	"surface_session_tasks",
	"reserve_work_items",
	"write_project_instruction_rule",
]);

const ROW_KEYS = [
	"results", "items", "tasks", "memories", "resources", "projects", "goals", "sessions",
	"automations", "runs", "reviews", "matches", "data",
] as const;
const COUNT_KEYS = ["total_matching", "total", "count"] as const;
const ACK_GATE_KEYS = [
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

/** A sentence DevSpec wrote to be read (a label, an instruction): flattened to one line, never clipped. */
function whole(value: unknown): string | undefined {
	const raw = scalar(value);
	return raw ? raw.replace(/\s+/g, " ").trim() : undefined;
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
		return parsed.toString();
	} catch {
		return undefined;
	}
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

/** Where a response carries the record it is about. */
const NESTED_ENTITY_KEYS: readonly string[] = ["item", "task", "memory", "resource", "automation", "goal", "project", "session", "assignment", "run"];

function nestedEntity(root: Row): Row {
	for (const key of NESTED_ENTITY_KEYS) {
		const found = record(root[key]);
		if (found) return found;
	}
	return root;
}

function boundedId(row: Row, outer: Row = row): string | undefined {
	return oneLine(
		first(row, ["id", "task_id", "memory_id", "resource_id", "project_id", "session_id", "run_id", "criterion_id"])
			?? first(outer, ["id", "task_id", "memory_id", "resource_id", "project_id", "session_id", "run_id", "criterion_id"]),
		90,
	);
}

function signalLabels(row: Row): string[] {
	const labels: string[] = [];
	const review = Array.isArray(row.review_signals)
		? row.review_signals
		: Array.isArray(row.signals)
			? row.signals
			: [];
	for (const raw of review.slice(0, 2)) {
		const signal = typeof raw === "string" ? oneLine(raw, 80) : oneLine(first(record(raw) ?? {}, ["type", "signal_type", "kind"]), 80);
		if (signal) labels.push(signal.replace(/_/g, " "));
	}
	if (row.claimed === false) labels.push("not claimed");
	if (row.blocked === true || row.is_blocked === true) labels.push("blocked");
	if (Array.isArray(row.human_actions_required) && row.human_actions_required.length > 0) {
		labels.push(`${row.human_actions_required.length} human action${row.human_actions_required.length === 1 ? "" : "s"}`);
	}
	return [...new Set(labels)].slice(0, 4);
}

/**
 * A change someone has PROPOSED against this record, awaiting review
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
	for (const raw of source) {
		const entry = record(raw);
		if (!entry) continue;
		const served = whole(entry.line);
		if (served) {
			lines.push(served);
			continue;
		}
		const what = oneLine(first(entry, ["what", "kind"]), 80) ?? "proposed change";
		const by = oneLine(entry.by, 80);
		const id = oneLine(entry.proposal_id, 90);
		lines.push(
			// Who it waits on is DevSpec's to say (contract 4.31.0: not always a Maintainer).
			`\u26a0 ${what}${by ? ` by ${by}` : ""}, awaiting review${id ? ` (proposal ${id})` : ""}`,
		);
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
	const served = whole(entry.line);
	if (served) return `\u26a0 ${served}`;
	const state = oneLine(entry.state, 40);
	return state ? `\u26a0 Not agreed work (${state}).` : null;
}

/**
 * Work that waits for an OK, or is an experiment (contract 4.31.0,
 * core.waiting-work-stays-on-its-branch; ADR "Protecting intent" §6.2, §6.9).
 * DevSpec writes the label ("Experiment", or "Waiting for <name>'s OK") and the
 * instruction; Pi shows them as sent. Required wherever it appears: dropping it
 * would let an agent merge waiting work into the tracking branch. The done
 * blocker follows in the same required lines (see doneBlockerLine).
 */
function waitingLines(row: Row, outer: Row = row): string[] {
	const waiting = record(row.waiting_for_ok) ?? record(outer.waiting_for_ok);
	const lines: string[] = [];
	if (waiting) {
		const label = whole(waiting.label) ?? "Waiting for an OK";
		const on = whole(waiting.waiting_on);
		const instruction = whole(waiting.instruction);
		lines.push(`\u26a0 ${label}${on && on !== label ? ` (${on})` : ""}${instruction ? ` — ${instruction}` : ""}`);
	} else if (row.is_experiment === true || outer.is_experiment === true || row.badge === "Experiment" || outer.badge === "Experiment") {
		const branch = oneLine(first(row, ["experiment_branch"]) ?? first(outer, ["experiment_branch"]), 160);
		lines.push(`\u26a0 Experiment${branch ? ` (branch ${branch})` : ""}: build and push it on its own branch; never merge it into the tracking branch until it has the OK.`);
	}
	const blocker = doneBlockerLine(row, outer, lines.length > 0);
	if (blocker) lines.push(blocker);
	return lines;
}

/**
 * What still stands between the work and done: an OK, a merge into a Tracking
 * branch (`not_landed`), or, once merged, a database change or a tracked
 * deployment (`awaiting_delivery`, with what is `outstanding`). DevSpec writes the
 * label ("Waiting to deploy to <target>"); Pi shows it as sent, plus the parts.
 * When done follows is devspec://product/implementation-contract's to say, not
 * Pi's. Required wherever it appears: dropping it let an agent report waiting
 * work as done.
 */
function doneBlockerLine(row: Row, outer: Row, waitingShown: boolean): string | null {
	const blocker = record(row.done_blocker) ?? record(outer.done_blocker);
	if (!blocker) return null;
	const layer = oneLine(blocker.layer, 40);
	const label = whole(blocker.label) ?? "Not done yet";
	const parts: string[] = [];
	if (layer === "waiting_for_ok") {
		// The waiting line above already says this, unless it merged before the OK.
		if (blocker.merged !== true && waitingShown) return null;
		if (blocker.merged === true) parts.push(`merged into ${oneLine(blocker.tracking_branch, 80) ?? "the tracking branch"}`);
	} else if (layer === "not_landed") {
		const repos = Array.isArray(blocker.unmerged_repos) ? blocker.unmerged_repos : [];
		const names = repos.map((raw) => {
			const repo = record(raw) ?? {};
			const name = whole(repo.repo_name);
			const branch = whole(repo.tracking_branch);
			return name ? `${name}${branch ? ` \u2192 ${branch}` : ""}` : undefined;
		}).filter((entry): entry is string => Boolean(entry));
		if (names.length) parts.push(`unmerged: ${names.join(", ")}`);
	} else if (layer === "awaiting_delivery") {
		const outstanding = (Array.isArray(blocker.outstanding) ? blocker.outstanding : [])
			.map((raw) => record(raw))
			.filter((entry): entry is Row => entry !== null);
		// Name the repository per entry only when the wait spans more than one.
		const repoNames = new Set(outstanding.map((entry) => oneLine(entry.repo_name, 80)).filter(Boolean));
		const perRepo = repoNames.size > 1;
		const entries = outstanding.map((entry) => {
			const status = oneLine(entry.status, 40)?.replace(/_/g, " ") ?? "pending";
			const repo = perRepo ? oneLine(entry.repo_name, 80) : undefined;
			let what: string;
			if (entry.kind === "deployment") {
				const targets = Array.isArray(entry.target_names)
					? oneLine(entry.target_names.filter((name) => typeof name === "string").join(", "), 120)
					: undefined;
				what = `deployment${targets ? ` to ${targets}` : ""}`;
			} else if (entry.kind === "database_change") {
				const file = oneLine(entry.filename, 100);
				const database = oneLine(entry.database_name, 80);
				what = `database change${file ? ` ${file}` : ""}${database ? ` on ${database}` : ""}`;
			} else {
				what = oneLine(entry.kind, 40)?.replace(/_/g, " ") ?? "delivery";
			}
			return `${repo ? `${repo} ` : ""}${what} (${status})`;
		});
		if (entries.length) {
			const only = repoNames.size === 1 ? [...repoNames][0] : undefined;
			parts.push(`outstanding${only ? ` in ${only}` : ""}: ${entries.join("; ")}`);
		}
	}
	return `\u26a0 done_blocker${layer ? ` (${layer})` : ""}: ${label}${parts.length ? ` \u2014 ${parts.join("; ")}` : ""}`;
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
	// A requirement binds work that would break it, so it is labelled apart from
	// ordinary knowledge (ADR "Protecting intent" §10), never left to read as one.
	if (first(row, ["kind", "memory_kind"]) === "requirement" && !metadata.includes("requirement")) metadata.unshift("requirement");
	const matchCount = Number(first(row, ["match_count", "matchCount"]));
	if (Number.isFinite(matchCount) && matchCount > 0) {
		const label = `${matchCount} match${matchCount === 1 ? "" : "es"}`;
		if (!metadata.includes(label)) metadata.push(label);
	}
	const parentRow = record(row.parent) ?? record(row.brief);
	const parent = oneLine(
		first(row, ["parent_title", "brief_title", "parent_task_id", "parent_id"])
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
	for (const line of waitingLines(row, outer)) required.push(`   ${line}`);
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
	/** The response's own top-level keys the rows came from; every other key is shown as a response note. */
	keys: string[];
}

function genericRows(root: Row): FoundRows {
	for (const key of ROW_KEYS) {
		if (Array.isArray(root[key])) return { rows: root[key] as unknown[], recognized: true, briefCount: 0, keys: [key] };
	}
	for (const key of ["page", "result"] as const) {
		const nested = record(root[key]);
		if (!nested) continue;
		const found = genericRows(nested);
		if (found.recognized) return { ...found, keys: [key] };
	}
	const hasCount = [root, record(root.page)].some((container) =>
		container && COUNT_KEYS.some((key) => typeof container[key] === "number" && Number.isFinite(container[key])),
	);
	return { rows: [], recognized: hasCount, briefCount: 0, keys: [] };
}

function collectionRows(toolName: string, root: Row): FoundRows {
	if (toolName === "search_resources") {
		const hasDocuments = Array.isArray(root.documents);
		const hasArtifacts = Array.isArray(root.artifacts);
		if (!hasDocuments && !hasArtifacts) return genericRows(root);
		const documents = hasDocuments ? root.documents as unknown[] : [];
		const artifacts = hasArtifacts ? root.artifacts as unknown[] : [];
		const rows: unknown[] = [];
		// The server searches these as two independent corpora; interleaving keeps
		// both visible near the top of the list.
		for (let index = 0; index < Math.max(documents.length, artifacts.length); index += 1) {
			if (index < documents.length) rows.push(documents[index]);
			if (index < artifacts.length) rows.push(artifacts[index]);
		}
		return { rows, recognized: true, briefCount: 0, keys: ["documents", "artifacts"] };
	}
	if (toolName !== "get_tasks") return genericRows(root);
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
	return { rows: combined, recognized: true, briefCount, keys: ["items", "briefs"] };
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
	if (toolName.includes("task")) return "Fetch an exact item with get_task(id); rerun with a narrower filter or next offset/page for more.";
	if (toolName.includes("memor") || ["get_decisions", "get_conventions"].includes(toolName)) {
		return "Fetch an exact memory with get_memory(id); rerun the list/search with a narrower filter for more.";
	}
	if (toolName.includes("resource")) return "Fetch an exact resource with get_resource(id); rerun the list/search with a narrower filter for more.";
	if (toolName.includes("project")) return "Use get_project_summary for an exact project; refine project scope or pagination for more.";
	if (toolName === "search_sessions" || toolName === "get_recent_sessions") {
		return "Call get_session_transcript with a session_id to read one room.";
	}
	return `Rerun ${toolName} with a narrower filter or pagination to fetch more; use the entity's exact get tool when available.`;
}

/** Keys a collection projection renders itself: the page, its counts and its completeness. */
const COLLECTION_RENDERED_KEYS = new Set(["page", "pages", "count", "total", "total_matching", "incomplete", "unavailable_note", "query"]);

/**
 * Everything else the server put beside the rows — how to treat a disagreement,
 * that a search ran on keywords alone, that bodies are left out, that an offset is
 * past the end — reaches the model whole, in DevSpec's words.
 */
function collectionNotes(root: Row, found: FoundRows, countsKey: string | null): Row {
	const notes: Row = {};
	for (const [key, value] of Object.entries(root)) {
		if (COLLECTION_RENDERED_KEYS.has(key) || found.keys.includes(key)) continue;
		if (key === "summary" && countsKey) {
			const summary = record(value);
			if (summary) {
				const { [countsKey]: _rendered, ...rest } = summary;
				if (Object.keys(rest).length) notes.summary = rest;
				continue;
			}
		}
		notes[key] = value;
	}
	return notes;
}

function collectionProjection(toolName: string, details: unknown): string | null {
	const root = record(details) ?? (Array.isArray(details) ? { results: details } : null);
	if (!root) return null;
	const found = collectionRows(toolName, root);
	if (!found.recognized) return null;
	// Every row the server returned is shown. The page size is the caller's own
	// `limit`, so a second, smaller page here would hide rows that the server's
	// next offset then skips past.
	const shown = found.rows;
	const primaryCount = toolName === "get_tasks"
		? Math.max(0, found.rows.length - found.briefCount)
		: found.rows.length;
	const total = totalRows(root, primaryCount);
	const summary = record(root.summary);
	const countsKey = summary ? (record(summary.ui_buckets) ? "ui_buckets" : record(summary.lifecycle_breakdown) ? "lifecycle_breakdown" : null) : null;
	const counts = summary && countsKey ? record(summary[countsKey]) : null;
	const heading = toolName === "get_tasks" && found.briefCount > 0
		? `${toolName}: ${total} result${total === 1 ? "" : "s"}; ${primaryCount} on this page plus ${found.briefCount} contextual brief card(s).`
		: `${toolName}: ${total} result${total === 1 ? "" : "s"}${primaryCount < total ? `; ${primaryCount} on this page` : ""}.`;
	const blocks = [heading];
	if (counts) {
		const allCounts = Object.entries(counts)
			.filter(([, value]) => typeof value === "number")
			.map(([key, value]) => `${key.replace(/_/g, " ")}=${value}`);
		if (allCounts.length) blocks.push(`Counts: ${allCounts.join(", ")}`);
	}
	// A search that could not reach part of its corpus says so (DevSpec item 0ab1054e):
	// relay it, so a partial answer is never read as a complete one.
	const incomplete = root.incomplete === true;
	if (incomplete) blocks.push(`Incomplete: ${typeof root.unavailable_note === "string" ? whole(root.unavailable_note) : "part of this search could not be run; do not report that nothing matched."}`);
	const notes = collectionNotes(root, found, countsKey);
	if (Object.keys(notes).length) blocks.push(`Response notes (server data):\n${reviewData(notes)}`);
	for (const [index, row] of shown.entries()) blocks.push(card(row, index));
	if (total === 0 && found.briefCount === 0 && !incomplete) blocks.push("No matching entities returned (recognized empty result set).");
	// DevSpec lists page with an exact continuation (item cc630fb8). Name it, so the
	// model can fetch the rest rather than read one page as the whole list.
	const page = record(root.page);
	if (page && typeof page.next_offset === "number") {
		blocks.push(`Next page: call ${toolName} again with offset ${page.next_offset}${page.total_is_lower_bound === true ? " (the count is a floor: the ranking stopped at its bound; narrow the query to reach beyond it)" : ""}.`);
	} else if (page && page.total_is_lower_bound === true) {
		blocks.push("The count is a floor: the ranking stopped at its bound. Narrow the query to reach beyond it.");
	}
	// search_resources pages its two corpora with one offset, each with its own page
	// (DevSpec item 02526f46). The next offset is the further of the two.
	const corpusPages = page ? null : record(root.pages);
	if (corpusPages) {
		const parts = Object.entries(corpusPages)
			.map(([corpus, raw]) => [corpus, record(raw)] as const)
			.filter((entry): entry is readonly [string, Row] => entry[1] !== null);
		const next = parts.map(([, corpusPage]) => corpusPage.next_offset).filter((value): value is number => typeof value === "number");
		const floor = parts.some(([, corpusPage]) => corpusPage.total_is_lower_bound === true);
		const counts = parts.map(([corpus, corpusPage]) => `${corpus} ${corpusPage.total_matching}${corpusPage.total_is_lower_bound === true ? "+" : ""}`).join(", ");
		if (next.length) blocks.push(`Next page: call ${toolName} again with offset ${Math.max(...next)} (matches: ${counts}).`);
		if (floor) blocks.push("A count marked + is a floor: the ranking stopped at its bound. Narrow the query, or browse with get_resources, to reach beyond it.");
	}
	blocks.push(fetchHint(toolName));
	return blocks.join("\n");
}

function helpProjection(details: unknown): string | null {
	const root = record(details);
	if (!root || !Array.isArray(root.results)) return null;
	const query = oneLine(root.query, 240);
	const page = record(root.page);
	const offset = page && typeof page.offset === "number" ? page.offset : 0;
	const pageTotal = page && typeof page.total_matching === "number" ? page.total_matching : undefined;
	const total = pageTotal ?? (typeof root.count === "number" ? Math.max(root.count, root.results.length) : root.results.length);
	const floor = page?.total_is_lower_bound === true;
	// Every section the server returned, each whole: its page size is the caller's.
	const shown = root.results as unknown[];
	const blocks = [`DevSpec help${query ? ` for “${query}”` : ""}: ${floor ? "at least " : ""}${total} section${total === 1 ? "" : "s"}; ${shown.length} on this page${offset > 0 ? ` from ${offset + 1}` : ""}.`];
	for (const [index, raw] of shown.entries()) {
		const hit = record(raw);
		if (!hit) continue;
		const doc = whole(first(hit, ["doc", "document", "title"])) ?? "DevSpec help";
		const section = whole(first(hit, ["section", "section_title", "heading"]));
		const category = whole(hit.category);
		const url = safeCiteUrl(hit.url);
		const content = scalar(first(hit, ["content", "text", "body"]));
		const lines = [`${index + 1}. ${doc}${section ? ` — ${section}` : ""}${category ? ` [${category}]` : ""}`];
		if (url) lines.push(`   URL: ${url}`);
		if (content) lines.push(content);
		blocks.push(lines.join("\n"));
	}
	// Pages continue from the last section shown (DevSpec item 02526f46).
	if (page && typeof page.next_offset === "number") {
		blocks.push(`More sections: call devspec_help_search again with offset ${page.next_offset}.`);
	}
	blocks.push("Cite the returned URL in the answer.");
	return blocks.join("\n");
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
	if (root.claimed === false) blocks.push("Gate — claim rejected/not acquired.");
	if (root.blocked === true || root.is_blocked === true) blocks.push("Gate — result is blocked.");
	return blocks;
}

/** Response fields a receipt renders in their own block, whole, instead of in the field dump. */
const ACK_OWN_BLOCK_KEYS = new Set(["own_criteria_follow_through", "brief_follow_through", "manual_followup_steps", "human_actions_required"]);

/** null, a blank string, an empty list or an empty object: a field that says nothing. */
function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === "string") return value.trim() === "";
	if (Array.isArray(value)) return value.length === 0;
	const row = record(value);
	return row !== null && Object.keys(row).length === 0;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((value, index) => sameValue(value, b[index]));
	}
	const left = a as Row;
	const right = b as Row;
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every((key) => hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** A value the server returned that is exactly what the call sent (a description, an intent): known to the model already. */
function isEcho(args: Row | undefined, key: string, value: unknown): boolean {
	if (!args || !hasOwn(args, key) || typeof value === "boolean" || typeof value === "number") return false;
	return sameValue(args[key], value);
}

/** The read that shows the stored record a receipt is about. */
function readToolFor(toolName: string): string {
	if (toolName.includes("memory")) return "get_memory";
	if (toolName.includes("resource")) return "get_resource";
	if (toolName.includes("automation")) return "get_automation";
	if (toolName.includes("discussion_point")) return "get_discussion_point";
	if (toolName.includes("instruction_rule")) return "get_project_instruction_rules";
	return "get_task";
}

interface ReceiptFields {
	shown: Row;
	empty: string[];
	echoed: string[];
}

/**
 * Every top-level field of a write's response, so a field the server adds later
 * reaches the model with no Pi change. Two kinds of field are left out, and the
 * receipt names how many and which: an empty one (null, blank, [] or {}) and one
 * identical to the argument the call sent. The record's own read shows both.
 */
function receiptFields(root: Row, args: Row | undefined): ReceiptFields {
	const shown: Row = {};
	const empty: string[] = [];
	const echoed: string[] = [];
	for (const [key, value] of Object.entries(root)) {
		if (ACK_OWN_BLOCK_KEYS.has(key)) continue;
		if (isEmptyValue(value)) {
			empty.push(key);
			continue;
		}
		if (isEcho(args, key, value)) {
			echoed.push(key);
			continue;
		}
		const nested = NESTED_ENTITY_KEYS.includes(key) ? record(value) : null;
		if (!nested) {
			shown[key] = value;
			continue;
		}
		const kept: Row = {};
		for (const [inner, innerValue] of Object.entries(nested)) {
			if (isEmptyValue(innerValue)) empty.push(`${key}.${inner}`);
			else if (isEcho(args, inner, innerValue)) echoed.push(`${key}.${inner}`);
			else kept[inner] = innerValue;
		}
		shown[key] = kept;
	}
	return { shown, empty, echoed };
}

function followThroughBlock(kind: "own" | "brief", value: unknown): string {
	const label = kind === "own" ? "Own-criteria follow-through" : "Brief follow-through";
	if (value === false) return `${label}: none requested.`;
	return `${label} (act on it before you report):\n${reviewData(value)}`;
}

function manualFollowUpBlock(root: Row): string | null {
	const steps: Row = {};
	let count = 0;
	for (const key of ["human_actions_required", "manual_followup_steps"] as const) {
		if (Array.isArray(root[key]) && (root[key] as unknown[]).length > 0) {
			steps[key] = root[key];
			count += (root[key] as unknown[]).length;
		}
	}
	if (!count) return null;
	return `Manual/human follow-up (${count}):\n${reviewData(steps)}`;
}

function ackProjection(toolName: string, details: unknown, args?: Row): string | null {
	const root = record(details);
	if (!root) return null;
	const entity = nestedEntity(root);
	const id = boundedId(entity, root);
	const title = oneLine(first(entity, ["title", "name", "subject", "key"]), 160);
	const state = oneLine(first(entity, ["lifecycle", "lifecycle_state", "state", "status"]) ?? first(root, ["lifecycle", "lifecycle_state", "state", "status"]), 80);
	const outcome = oneLine(first(root, ["outcome", "result", "disposition"]) ?? first(entity, ["outcome", "result", "disposition"]), 100);
	const recognizedGate = ACK_GATE_KEYS.some((key) => hasOwn(root, key) || hasOwn(entity, key));
	if (!id && !title && !state && !outcome && !recognizedGate) return null;

	const blocks: string[] = [];
	const parent = oneLine(first(entity, ["parent_task_id", "parent_id", "parent_title", "brief_title"])
		?? first(root, ["parent_task_id", "parent_id", "parent_title", "brief_title"]), 140);
	const facts = [id && `id=${id}`, title && `title=${title}`, state && `state=${state}`, outcome && `outcome=${outcome}`].filter(Boolean);
	blocks.push(`${toolName}: ${facts.length ? facts.join(" ") : "recognized response (see the fields below)"}.`);
	if (parent) blocks.push(`Parent/brief: ${parent}`);
	// Work that waits for an OK, is an experiment, or is not done yet: said in a
	// line first, and its fields are in the response below as well.
	blocks.push(...waitingLines(entity, root));
	blocks.push(...conflictBlocks(root));
	if (entity !== root) blocks.push(...conflictBlocks(entity));
	if (hasOwn(root, "own_criteria_follow_through") && root.own_criteria_follow_through != null) {
		blocks.push(followThroughBlock("own", root.own_criteria_follow_through));
	}
	if (hasOwn(root, "brief_follow_through") && root.brief_follow_through != null) {
		blocks.push(followThroughBlock("brief", root.brief_follow_through));
	}
	const manual = manualFollowUpBlock(root);
	if (manual) blocks.push(manual);
	const fields = receiptFields(root, args);
	const leftOut = [
		fields.empty.length ? `${fields.empty.length} empty field(s) left out` : null,
		fields.echoed.length ? `left out as identical to what you sent: ${fields.echoed.join(", ")}` : null,
	].filter((part): part is string => part !== null);
	const heading = leftOut.length
		? `DevSpec's response (every other field; ${leftOut.join("; ")} — ${readToolFor(toolName)} shows the stored record):`
		: "DevSpec's response (every field):";
	blocks.push(`${heading}\n${reviewData(fields.shown)}`);
	return blocks.join("\n");
}

/** A result no family recognises reaches the model whole: a field DevSpec adds is never cut off here. */
function wholeFallback(text: string, details: unknown): string {
	if (details != null) return json(details) ?? (text || "(unserializable structured payload)");
	return text || "(empty response)";
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
	if (family === "collection") return collectionProjection(input.toolName, input.details) ?? wholeFallback(input.text, input.details);
	if (family === "help") return helpProjection(input.details) ?? wholeFallback(input.text, input.details);
	if (family === "ack") return ackProjection(input.toolName, input.details, input.args) ?? wholeFallback(input.text, input.details);
	return wholeFallback(input.text, input.details);
}
