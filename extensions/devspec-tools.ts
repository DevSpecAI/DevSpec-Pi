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
}

function registerDevspecTool(pi: ExtensionAPI, def: DevspecToolDef): void {
	pi.registerTool({
		name: def.name,
		label: def.label,
		description: def.description,
		promptSnippet: def.promptSnippet,
		parameters: def.parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const resolved = await resolveToken();
			if (!resolved) return toolErrorResult(NOT_CONNECTED);
			try {
				const raw = await callDevspec(resolved.token, def.name, params as Record<string, unknown>);
				const { text, details, isError } = unwrapMcpResult(raw);
				if (isError) return toolErrorResult(text || `DevSpec tool ${def.name} failed.`);
				return toolTextResult(text || "(empty response)", details ?? {});
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
