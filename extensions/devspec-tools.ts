/**
 * DevSpec Pi — native DevSpec tools (Phase 2: read + memory surface).
 *
 * Every tool here is a native pi tool backed by the DevSpec MCP verb of the
 * SAME NAME (the MCP tool surface is the interop contract across all DevSpec
 * plugins — VISION.md principle 3). Schemas mirror the server definitions in
 * devspecv2 apps/web/lib/mcp/tool-definitions.ts; descriptions are condensed
 * but keep the load-bearing rules.
 *
 * Phase 2 scope: read-only project/action-item/memory/search verbs plus the
 * memory write trio (record / supersede / retract). Claim/work/remote verbs
 * land with the workflow commands (Phase 3) and remote control (Phase 4).
 *
 * Headless: tools work in every mode — errors come back as text the model can
 * act on (e.g. "run /devspec.login"), never as UI-only state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { resolveToken } from "./core/auth-store.ts";
import { connectionsUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { callDevspec } from "./core/client.ts";
import { toolErrorResult, toolTextResult, unwrapMcpResult } from "./core/result.ts";
import { getBond } from "./core/bond-state.ts";

/** Unwrap a DevSpec MCP result, converting isError payloads into thrown errors. */
function unwrapOrThrow(name: string, raw: unknown) {
	const { text, details, isError } = unwrapMcpResult(raw);
	if (isError) throw new Error(text || `DevSpec tool ${name} failed.`);
	return toolTextResult(text || "(empty response)", details ?? {});
}

const NOT_CONNECTED =
	`Not connected to DevSpec. Run /devspec.login, or set ${TOKEN_ENV_VAR}. ` +
	`Tokens are minted at ${connectionsUrl()}.`;

interface DevspecToolDef {
	/** MCP verb name — also the pi tool name. */
	name: string;
	label: string;
	/** What the model sees. Keep the server's load-bearing rules. */
	description: string;
	/** One-liner for the system prompt's Available tools section. */
	promptSnippet: string;
	parameters: TSchema;
	/** Per-call argument augmentation (e.g. stamping the pi session id on claims). */
	augment?: (params: Record<string, unknown>, ctx: { sessionManager: { getSessionId(): string } }) => Record<string, unknown>;
}

function registerDevspecTool(pi: ExtensionAPI, def: DevspecToolDef): void {
	pi.registerTool({
		name: def.name,
		label: def.label,
		description: def.description,
		promptSnippet: def.promptSnippet,
		parameters: def.parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = await resolveToken();
			if (!resolved) return toolErrorResult(NOT_CONNECTED);
			try {
				const args = def.augment ? def.augment(params as Record<string, unknown>, ctx) : (params as Record<string, unknown>);
				// Project scoping (git_remote retry on multi-project errors) is
				// centralized in callDevspec.
				const raw = await callDevspec(resolved.token, def.name, args, { cwd: ctx.cwd });
				return unwrapOrThrow(def.name, raw);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return toolErrorResult(message);
			}
		},
	});
}

const MEMORY_TYPES = [
	"decision", "convention", "architecture", "risk", "preference",
	"insight", "goal", "unresolved", "reference",
	"user_observation", "team_observation", "org_context",
] as const;

export default function (pi: ExtensionAPI) {
	// ---- Projects ----------------------------------------------------------

	registerDevspecTool(pi, {
		name: "list_projects",
		label: "DevSpec: List Projects",
		description:
			"List the DevSpec projects you can access: { projects: [{ id, name, description, repos }] }. " +
			"Pass git_remote (from `git remote get-url origin`) to also get remote_match { resolved_project_id } " +
			"for the current checkout.",
		promptSnippet: "List accessible DevSpec projects",
		parameters: Type.Object({
			git_remote: Type.Optional(Type.String({ description: "This checkout's git remote URL, to resolve which project it belongs to." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "get_project_summary",
		label: "DevSpec: Project Summary",
		description:
			"High-level project summary: repo count, indexed files, members (resolve assignees), repos with " +
			"target_branch (push each repo to ITS branch), database_targets (point your own db tooling at the " +
			"matching identity for migrations — never guess), and the execution settings (branch_prefix, " +
			"commit_message_prefix, custom_instructions = team principles, agent_rules = mandatory execution " +
			"mechanics, test_commands, protected_paths, auto_push/auto_merge). Read before starting work.",
		promptSnippet: "Get project summary, members, repos, and execution rules",
		parameters: Type.Object({}),
	});

	// ---- Action items (read) ------------------------------------------------

	registerDevspecTool(pi, {
		name: "get_action_items",
		label: "DevSpec: Action Items",
		description:
			"List action items as a project SUMMARY plus a token-bounded page. Report counts from " +
			"summary.ui_buckets (open / done / etc.), NEVER from items.length — items is one PAGE " +
			"(use page.next_offset, or fields:\"compact\" to scan a large slice cheaply). " +
			"Sorted by queue priority by default. To find items by topic, prefer search_action_items.",
		promptSnippet: "List DevSpec action items (paged, with summary counts)",
		parameters: Type.Object({
			lifecycle: Type.Optional(StringEnum(["open", "in_progress", "done", "dismissed", "deferred", "blocked", "all"] as const)),
			fields: Type.Optional(StringEnum(["full", "compact"] as const)),
			order_by: Type.Optional(StringEnum(["priority", "created", "last_activity", "due"] as const)),
			order_dir: Type.Optional(StringEnum(["asc", "desc"] as const)),
			limit: Type.Optional(Type.Number({ description: "Page size. Default 25 (full) / 100 (compact)." })),
			offset: Type.Optional(Type.Number({ description: "Use page.next_offset from a prior response." })),
			agent_activity: Type.Optional(StringEnum(["idle", "staged", "implementing", "reporting", "finished", "failed"] as const)),
			assigned_to: Type.Optional(Type.String({ description: '"me" | user UUID | "anyone".' })),
			parent_id: Type.Optional(Type.String({ description: "Restrict to children of this brief/item." })),
			include_briefs: Type.Optional(Type.Boolean({ description: "Include brief rows (hidden by default)." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "get_action_item",
		label: "DevSpec: Action Item",
		description:
			"Fetch one action item by UUID: FULL description and all structured fields, plus review_signals, " +
			"unresolved_conflicts (held out of the work queue while unresolved), and goals { direct, inherited }. " +
			"List/search results only carry a truncated preview — read the item before working it.",
		promptSnippet: "Read one DevSpec action item in full",
		parameters: Type.Object({
			action_item_id: Type.String({ description: "UUID of the action item." }),
		}),
	});

	registerDevspecTool(pi, {
		name: "search_action_items",
		label: "DevSpec: Search Action Items",
		description:
			"Find action items by topic/keyword. Returns cards with a truncated preview — use get_action_item " +
			"for the full text. Prefer this over paging get_action_items when you know what you're looking for.",
		promptSnippet: "Search DevSpec action items by topic",
		parameters: Type.Object({
			query: Type.String({ description: "Keywords or natural language." }),
			lifecycle: Type.Optional(StringEnum(["open", "in_progress", "done", "dismissed", "deferred", "blocked", "all"] as const)),
			limit: Type.Optional(Type.Number()),
		}),
	});

	registerDevspecTool(pi, {
		name: "get_next_work_item",
		label: "DevSpec: Next Work Item",
		description:
			"Next highest-priority staged action item with full implementation context: description, " +
			"ai_instructions, affected_files, relevant_memories + relevant_artifacts (READ BEFORE implementing — " +
			"binding decisions/conventions), review_signals, repos with target_branch, database_targets, and the " +
			"project instruction tiers (custom_instructions, agent_rules — treat both as mandatory). " +
			"Empty means nothing available (stop signal).",
		promptSnippet: "Get the next staged action item with full context",
		parameters: Type.Object({
			priority: Type.Optional(StringEnum(["low", "medium", "high", "critical"] as const)),
			type: Type.Optional(StringEnum(["bug", "feature", "improvement", "task", "query"] as const)),
			tags: Type.Optional(Type.Array(Type.String())),
			created_by: Type.Optional(Type.String({ description: '"me" or a user UUID.' })),
			assigned_to: Type.Optional(Type.String({ description: '"me" (default) | "anyone" | user UUID.' })),
		}),
	});

	// ---- Memory -------------------------------------------------------------

	registerDevspecTool(pi, {
		name: "search_memories",
		label: "DevSpec: Search Memory",
		description:
			"Hybrid (keyword + semantic) search over project memory: decisions, conventions, risks, patterns. " +
			"Returns CARDS (id, title, summary, type, state, tags), not bodies — call get_memory to read one in " +
			"full, and always do that before superseding or contradicting it.",
		promptSnippet: "Search DevSpec project memory",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language or keywords; both work." }),
			type: Type.Optional(StringEnum([...MEMORY_TYPES, "all"] as const)),
			include_superseded: Type.Optional(Type.Boolean()),
			limit: Type.Optional(Type.Number({ description: "Default 20." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "get_memory",
		label: "DevSpec: Read Memory",
		description:
			"Fetch one memory's FULL body by id (UUID or the 8-char short code). Includes lineage: superseded_by " +
			"(read that instead) and supersedes. Search/list tools return cards only — this is how you read what " +
			"a decision actually says.",
		promptSnippet: "Read one DevSpec memory in full",
		parameters: Type.Object({
			id: Type.String({ description: "Memory UUID or 8-char short code." }),
		}),
	});

	registerDevspecTool(pi, {
		name: "record_memory",
		label: "DevSpec: Record Memory",
		description:
			"Record a project memory. A hybrid recall runs FIRST: on near-duplicate the memory is NOT recorded " +
			"(reconcile_required + closest_match) — prefer supersede_memory, or re-call with confirm_new:true and " +
			"a reason if genuinely distinct. Interactive writes may land \"decided\". Record deviations, discovered " +
			"constraints, non-obvious findings — NOT transient details or things obvious from code. In interactive " +
			"sessions, propose the memory to the user before recording.",
		promptSnippet: "Record a DevSpec decision/convention/risk",
		parameters: Type.Object({
			type: StringEnum(MEMORY_TYPES),
			title: Type.String({ description: "Single-line name a person would cite in conversation (max 200 chars). NOT the first line of the body." }),
			body: Type.String({ description: "Full memory text (markdown)." }),
			summary: Type.Optional(Type.String({ description: "Standalone one-line restatement (max 400 chars)." })),
			tags: Type.Optional(Type.Array(Type.String())),
			confidence: Type.Optional(Type.Number({ description: "0-1, default 0.8." })),
			state: Type.Optional(StringEnum(["in_discussion", "decided"] as const)),
			affected_files: Type.Optional(Type.Array(Type.String())),
			confirm_new: Type.Optional(Type.Boolean()),
		}),
	});

	registerDevspecTool(pi, {
		name: "supersede_memory",
		label: "DevSpec: Supersede Memory",
		description:
			"Supersede a memory with a new version (non-destructive; prior version kept, marked superseded). " +
			"If a DIFFERENT entry is closer to your new content, nothing happens (reconcile_required + " +
			"closest_match) — supersede that one, or pass confirm_new:true to proceed anyway.",
		promptSnippet: "Replace a DevSpec memory with a new version",
		parameters: Type.Object({
			id: Type.String({ description: "Id of the memory to supersede." }),
			title: Type.String({ description: "Single-line name for the NEW version (max 200 chars)." }),
			body: Type.String({ description: "Replacement body (markdown)." }),
			summary: Type.Optional(Type.String()),
			tags: Type.Optional(Type.Array(Type.String())),
			confidence: Type.Optional(Type.Number()),
			state: Type.Optional(StringEnum(["in_discussion", "decided"] as const)),
			affected_files: Type.Optional(Type.Array(Type.String())),
			confirm_new: Type.Optional(Type.Boolean()),
		}),
	});

	registerDevspecTool(pi, {
		name: "retract_memory",
		label: "DevSpec: Retract Memory",
		description:
			"Retract a memory that is no longer true (non-destructive soft-delete; state becomes \"retracted\").",
		promptSnippet: "Retract a stale DevSpec memory",
		parameters: Type.Object({
			id: Type.String({ description: "Id of the memory to retract." }),
			reason: Type.Optional(Type.String({ description: "Why it is being retracted." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "get_decisions",
		label: "DevSpec: Decisions",
		description:
			"List recorded architecture/design decisions, most recent first (cards only — get_memory to read).",
		promptSnippet: "List project decisions",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Default 20." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "get_conventions",
		label: "DevSpec: Conventions",
		description:
			"List recorded coding conventions and standards (cards only — get_memory to read).",
		promptSnippet: "List project conventions",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Default 20." })),
		}),
	});

	// ---- Search -------------------------------------------------------------

	registerDevspecTool(pi, {
		name: "search_resources",
		label: "DevSpec: Search Documents",
		description:
			"Hybrid search over documents and artifacts (uploads + DevSpec ADRs/plans). Hits return the MATCHING " +
			"PASSAGE inline. OMIT query to list what exists (most recent first).",
		promptSnippet: "Search project documents and artifacts",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Keywords or a natural-language question. Omit to LIST." })),
			source: Type.Optional(StringEnum(["uploaded", "ai_generated", "all"] as const)),
			scope: Type.Optional(StringEnum(["all", "project", "session"] as const)),
			limit: Type.Optional(Type.Number({ description: "Default 20, max 50." })),
		}),
	});

	// ---- Workflow verbs (Phase 3) ------------------------------------------

	registerDevspecTool(pi, {
		name: "create_action_item",
		label: "DevSpec: Create Action Item",
		description:
			"Create a tracked action item (optionally under a brief via parent_action_item_id). The response " +
			"carries related_candidates — REVIEW IT: prefer updating an existing item over duplicating, and " +
			"raise contradictions rather than proceeding silently. One unit of work = one item.",
		promptSnippet: "Create a tracked DevSpec action item",
		parameters: Type.Object({
			title: Type.String({ description: "Action item title." }),
			description: Type.Optional(Type.String({ description: "The WHAT and HOW. Keep the why in `intent`, the definition of done in `acceptance_criteria`." })),
			intent: Type.Optional(Type.String({ description: "The WHY — the problem and desired outcome." })),
			acceptance_criteria: Type.Optional(Type.String({ description: "Definition of done." })),
			type: Type.Optional(StringEnum(["bug", "feature", "improvement", "task", "query"] as const)),
			priority: Type.Optional(StringEnum(["low", "medium", "high", "critical"] as const)),
			tags: Type.Optional(Type.Array(Type.String())),
			parent_action_item_id: Type.Optional(Type.String({ description: "Attach under this brief/parent item." })),
			due_date: Type.Optional(Type.String({ description: "ISO date (YYYY-MM-DD)." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "claim_work_item",
		label: "DevSpec: Claim Work Item",
		description:
			"Atomically claim a staged item (staged → in_progress). FAILS if another agent claimed it, and is " +
			"REJECTED on unresolved possible_conflict — do not force past that; resolve the pair first " +
			"(resolve_action_item_conflict) or surface it. The claim returns the project instruction tiers " +
			"(custom_instructions = principles, agent_rules = execution mechanics) — both are MANDATORY while " +
			"implementing. force:true (with reason) only for deliberate takeovers.",
		promptSnippet: "Claim a DevSpec action item for implementation",
		parameters: Type.Object({
			action_item_id: Type.String({ description: "Action item ID to claim." }),
			agent_branch: Type.String({ description: "Git branch created for this item (respect the project branch_prefix)." }),
			force: Type.Optional(Type.Boolean({ description: "Deliberate takeover only. Requires reason." })),
			reason: Type.Optional(Type.String({ description: "Required when force is true." })),
		}),
		augment: (params, ctx) => ({ local_session_id: ctx.sessionManager.getSessionId(), ...params }),
	});

	registerDevspecTool(pi, {
		name: "release_work_item",
		label: "DevSpec: Release Work Item",
		description:
			"Release your claim on an item without completing it (back to staged/idle). Only the current " +
			"claimant can release; takeovers go through claim_work_item with force:true.",
		promptSnippet: "Release a claimed DevSpec item",
		parameters: Type.Object({
			action_item_id: Type.String({ description: "Action item ID to release." }),
			reason: Type.Optional(Type.String({ description: "Recorded on the released activity row." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "record_implementation",
		label: "DevSpec: Record Implementation",
		description:
			"Record that a claimed item is IMPLEMENTED (written + pushed). Lands at lifecycle 'implemented', " +
			"NOT 'done' — a human verifies via verify_action_item. After recording, ACT ON " +
			"own_criteria_follow_through / brief_follow_through in the response (check what you can with " +
			"record_criterion_verdicts, naming what you ran and what came back), then report 'implemented' " +
			"and STOP. Vocabulary: implemented → verified → done.",
		promptSnippet: "Record an implemented DevSpec item (commit SHA, files, testing notes)",
		parameters: Type.Object({
			action_item_id: Type.String({ description: "Action item ID." }),
			commit_sha: Type.String({ description: "Final commit SHA." }),
			commit_message: Type.Optional(Type.String()),
			agent_merged: Type.Optional(Type.Boolean({ description: "true = merged to target branch, false = push-only." })),
			affected_files: Type.Optional(Type.Array(Type.String({ description: "From git diff --name-only." }))),
			goal_ids: Type.Optional(Type.Array(Type.String({ description: "Goal UUIDs this work serves (full reconciled set)." }))),
			completion_note: Type.Optional(Type.String({ description: "Summary of what was done." })),
			completion_confidence: Type.Optional(Type.Number({ description: "0-100; lower signals uncertainty to the reviewer." })),
			completion_disposition: Type.Optional(StringEnum(["implemented", "already_correct", "partial", "workaround"] as const)),
			completion_summary: Type.Optional(Type.String({ description: "Changelog-style, 2-4 sentences, written for non-developers." })),
			testing_notes: Type.Optional(Type.String({ description: "Numbered markdown steps to VERIFY the change." })),
		}),
		augment: (params, ctx) => ({ local_session_id: ctx.sessionManager.getSessionId(), ...params }),
	});

	registerDevspecTool(pi, {
		name: "update_action_item",
		label: "DevSpec: Update Action Item",
		description:
			"Refine an action item's fields (title, description, intent, acceptance, type, priority, due_date, " +
			"testing_notes, usage_notes). Prefer careful rewrites over wholesale replacement when refining.",
		promptSnippet: "Update a DevSpec action item's fields",
		parameters: Type.Object({
			action_item_id: Type.String({ description: "Action item ID." }),
			title: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			intent: Type.Optional(Type.String()),
			type: Type.Optional(StringEnum(["bug", "feature", "improvement", "task", "query"] as const)),
			priority: Type.Optional(StringEnum(["low", "medium", "high", "critical"] as const)),
			due_date: Type.Optional(Type.String({ description: "ISO date (YYYY-MM-DD), empty string clears." })),
			testing_notes: Type.Optional(Type.String({ description: "Markdown verification steps; empty string clears." })),
			usage_notes: Type.Optional(Type.String({ description: "Where users find the feature; empty string clears." })),
			is_brief: Type.Optional(Type.Boolean({ description: "Make this item a grouping brief." })),
		}),
	});

	registerDevspecTool(pi, {
		name: "post_session_message",
		label: "DevSpec: Post Session Message",
		description:
			"Post a message into your bonded DevSpec session (you are the SOLE content authority when bonded — " +
			"final answers go through this, never chrome/status). connection_id defaults to your active bond; " +
			"pass complete_turn:true on the FINAL answer so Working… clears with the bubble. " +
			"phase:'trail' grows one live work-trail bubble mid-turn (cumulative output, ~1 call/sec max).",
		promptSnippet: "Post a message to the bonded DevSpec session",
		parameters: Type.Object({
			message: Type.String({ description: "Message content (markdown)." }),
			connection_id: Type.Optional(Type.String({ description: "Defaults to your active bond when omitted." })),
			session_id: Type.Optional(Type.String({ description: "Legacy/explicit room id; prefer connection_id." })),
			turn_kind: Type.Optional(StringEnum(["agent", "local_prompt"] as const)),
			complete_turn: Type.Optional(Type.Boolean({ description: "Set true on the FINAL answer." })),
			phase: Type.Optional(StringEnum(["trail", "needs_input", "answer", "error"] as const)),
		}),
		augment: (params, _ctx) => {
			const bond = getBond();
			if (bond && !params.connection_id && !params.session_id) {
				return { ...params, connection_id: bond.connectionId };
			}
			return params;
		},
	});

	registerDevspecTool(pi, {
		name: "devspec_help_search",
		label: "DevSpec: Product Help",
		description:
			"Search DevSpec's own product help docs (projects, sessions, autopilot, integrations, billing, MCP " +
			"setup). Returns relevant sections with text and deep links. Use for \"how do I … in DevSpec?\".",
		promptSnippet: "Search DevSpec product help",
		parameters: Type.Object({
			query: Type.String({ description: 'Natural-language question, e.g. "how do I set up autopilot".' }),
			limit: Type.Optional(Type.Number({ description: "1-20, default 8." })),
		}),
	});
}
