/**
 * DevSpec Pi — the model-facing tool surface.
 *
 * The generated catalog (`extensions/generated/mcp-catalog.ts`) is the WIRE
 * map. Every safe model verb is registered as a real Pi tool, while only a
 * small everyday hot set starts active. Less-common tools are found and
 * additively activated through one tiny loader.
 */

import {
	MCP_CATALOG,
	MODEL_VERB_NAMES,
	type CatalogEntry,
} from "../generated/mcp-catalog.ts";

/** Everyday work. Order is the initial prompt order. */
export const HOT_SET_VERBS = [
	"get_project_summary",
	"search_action_items",
	"get_action_item",
	"create_action_item",
	"update_action_item",
	"claim_work_item",
	"record_implementation",
	"search_memories",
	"get_memory",
	"record_memory",
	"search_resources",
	"get_resource",
	"resolve_action_item_conflict",
	"record_criterion_verdicts",
	"get_session_transcript",
] as const;

export type HotSetVerb = (typeof HOT_SET_VERBS)[number];

export const HOT_SET = new Set<string>(HOT_SET_VERBS);

/** Keys the extension stamps. The model must never be asked for these —
 *  except `session_id` on verbs where it names the resource being read
 *  (`MODEL_OWNED_SESSION_ID_VERBS`), not the bonded room. Item 7de79db6
 *  still holds for git_remote / project_id / the current-room default.
 */
export const SCOPE_KEYS = [
	"git_remote",
	"project_id",
	"pinned_project_id",
	"session_id",
	"runner_session_id",
	"connection_id",
	"local_session_id",
	"commit_provenance_source",
	"provenance_source",
] as const;

export const SCOPE_KEY_SET = new Set<string>(SCOPE_KEYS);

/** session_id here is the room to read (bb3cdeea), not host identity. */
export const MODEL_OWNED_SESSION_ID_VERBS = new Set<string>(["get_session_transcript"]);

export function scopeKeysForTool(name?: string): Set<string> {
	if (name && MODEL_OWNED_SESSION_ID_VERBS.has(name)) {
		const keys = new Set<string>(SCOPE_KEYS);
		keys.delete("session_id");
		return keys;
	}
	return SCOPE_KEY_SET;
}

export const TOOL_LOADER_NAME = "search_devspec_tools";
export const PLAN_TOOL_NAME = "manage_plan";
export const POLL_TOOL_NAME = "manage_poll";
export const DIRECTED_QUESTION_TOOL_NAME = "manage_directed_question";
/** Native tools whose lifecycle is mechanical, never loader/search driven. */
export const ACTIVATION_ONLY_VERBS = new Set<string>([PLAN_TOOL_NAME, POLL_TOOL_NAME, DIRECTED_QUESTION_TOOL_NAME]);

/** Connection-bound ledgers: identity is capability-derived, never model arguments. */
export function isConnectionBoundTool(name: string): boolean {
	return name === PLAN_TOOL_NAME || name === POLL_TOOL_NAME || name === DIRECTED_QUESTION_TOOL_NAME;
}
export const TOOL_LOADER_DESCRIPTION =
	"Find and load less-common DevSpec tools for a task described in natural language.";

export interface ToolPromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export const TOOL_LOADER_PROMPT_METADATA: ToolPromptMetadata = {
	promptSnippet: "Search and load less-common DevSpec tools when the active tools cannot perform a task",
};

const SNIPPET_MAX = 140;
// Load one schema by default: deferred loading saves context only when a broad
// natural-language query cannot activate four merely-adjacent tools. Callers
// can request a larger bundle explicitly when one task genuinely needs it.
const DEFAULT_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 10;
const SEARCH_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"devspec",
	"do",
	"does",
	"exist",
	"for",
	"i",
	"in",
	"is",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"please",
	"the",
	"this",
	"to",
	"tool",
	"tools",
	"want",
	"we",
	"what",
	"with",
]);

type ModelVerbName = (typeof MODEL_VERB_NAMES)[number];

/** Ordinary-language concepts that do not occur in the corresponding tool contract. */
const TOOL_SEARCH_ALIASES: Partial<Record<ModelVerbName, readonly string[]>> = {
	get_action_items: ["list action items", "action items created", "chronological action items", "action item chronology", "browse backlog", "oldest work", "stale work"],
	surface_session_action_items: ["surface action items", "post action item cards", "re-post action item cards"],
	release_work_item: ["unclaim", "give up claimed work", "abandon claimed task"],
	fail_work_item: ["could not finish claimed work", "unable to finish claimed task", "stuck on claimed work"],
	get_recent_sessions: ["recent activity", "recent conversations"],
	search_sessions: ["session search", "find conversation", "search transcripts", "which session talked about", "past discussion"],
	search_discussion_points: ["still to discuss", "unsettled loops", "open discussion points", "project discussion list"],
	get_discussion_point: ["discussion point body", "full still to discuss row"],
	manage_discussion_point: ["add to still to discuss", "strike discussed", "reopen discussion", "watch discussion"],
	get_claimable_reviews: ["inspect someone else's changes", "check someone else's changes"],
	get_automations: ["recurring automations", "saved routines"],
	get_project_goals: ["objectives", "working toward", "big picture"],
	get_project_instruction_rules: ["team policies", "agent guidelines", "how agents should behave"],
};

export function firstSentence(text: string, max = SNIPPET_MAX): string {
	const trimmed = String(text ?? "")
		.trim()
		.replace(/\s+/g, " ");
	if (!trimmed) return "";
	const cut = trimmed.search(/[.!?](?:\s|$)/);
	const sentence = cut >= 0 ? trimmed.slice(0, cut + 1) : trimmed;
	return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function slimUnknown(value: unknown, omitKeys: Set<string> = SCOPE_KEY_SET): unknown {
	if (Array.isArray(value)) return value.map((item) => slimUnknown(item, omitKeys));
	if (!value || typeof value !== "object") return value;
	return slimSchema(value as Record<string, unknown>, omitKeys);
}

/** Recursively drop stamped scope keys and shrink description essays. */
export function slimSchema(
	schema: Record<string, unknown> | undefined,
	omitKeys: Set<string> = SCOPE_KEY_SET,
): Record<string, unknown> {
	if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
			const props: Record<string, unknown> = {};
			for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
				if (omitKeys.has(name)) continue;
				props[name] = slimUnknown(prop, omitKeys);
			}
			out.properties = props;
			continue;
		}
		if (key === "required" && Array.isArray(value)) {
			const required = value.filter((name) => typeof name === "string" && !omitKeys.has(name));
			if (required.length > 0) out.required = required;
			continue;
		}
		if (key === "description" && typeof value === "string") {
			out.description = firstSentence(value);
			continue;
		}
		if (value && typeof value === "object") {
			out[key] = slimUnknown(value, omitKeys);
			continue;
		}
		out[key] = value;
	}
	return out;
}

export function slimCatalogEntry(entry: CatalogEntry): CatalogEntry {
	const omitKeys = scopeKeysForTool(entry.name);
	const inputSchema = slimSchema(entry.inputSchema, omitKeys);
	if (MODEL_OWNED_SESSION_ID_VERBS.has(entry.name) && Array.isArray(inputSchema.required)) {
		const required = inputSchema.required.filter((name) => name !== "session_id");
		if (required.length > 0) inputSchema.required = required;
		else delete inputSchema.required;
	}
	return {
		...entry,
		description: firstSentence(entry.promptSnippet || entry.description),
		promptSnippet: firstSentence(entry.promptSnippet || entry.description),
		inputSchema,
	};
}

export function catalogEntry(name: string): CatalogEntry | undefined {
	return MCP_CATALOG.find((entry) => entry.name === name);
}

/** Slimmed hot-set entries, in initial prompt order. */
export function modelFacingSurface(): CatalogEntry[] {
	const out: CatalogEntry[] = [];
	for (const name of HOT_SET_VERBS) {
		const entry = catalogEntry(name);
		if (entry?.kind === "model") out.push(slimCatalogEntry(entry));
	}
	return out;
}

/** All safe model-facing tools, in generated wire-map order. */
export function allModelFacingTools(): CatalogEntry[] {
	return MCP_CATALOG.filter((entry) => entry.kind === "model").map(slimCatalogEntry);
}

/** Slimmed, searchable tools that stay inactive at session start. */
export function rareModelSurface(): CatalogEntry[] {
	return allModelFacingTools().filter((entry) =>
		!HOT_SET.has(entry.name) && !ACTIVATION_ONLY_VERBS.has(entry.name)
	);
}

export function rareModelVerbs(): string[] {
	return MODEL_VERB_NAMES.filter((name) =>
		!HOT_SET.has(name) && !ACTIVATION_ONLY_VERBS.has(name)
	);
}

export function isCallableModelVerb(name: string): boolean {
	const entry = catalogEntry(name);
	return Boolean(entry && entry.kind === "model");
}

export function isHotSetVerb(name: string): boolean {
	return HOT_SET.has(name);
}

/** Prompt metadata used by both Pi registration and prefix accounting. */
export function hotToolPromptMetadata(entry: CatalogEntry): ToolPromptMetadata {
	return HOT_SET.has(entry.name) ? { promptSnippet: entry.promptSnippet } : {};
}

function canonicalSearchToken(token: string): string {
	if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
	if (
		token.length > 3 &&
		token.endsWith("s") &&
		!token.endsWith("ss") &&
		!token.endsWith("us") &&
		!token.endsWith("is")
	) {
		return token.slice(0, -1);
	}
	return token;
}

function searchTokens(text: string): string[] {
	return [
		...new Set(
			text
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.map(canonicalSearchToken)
				.filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)),
		),
	];
}

function schemaSearchText(schema: Record<string, unknown>): string {
	const parts: string[] = [];
	const addStrings = (value: unknown): void => {
		if (typeof value === "string") parts.push(value);
		else if (Array.isArray(value)) value.forEach(addStrings);
	};
	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
				for (const [propertyName, propertySchema] of Object.entries(child as Record<string, unknown>)) {
					if (SCOPE_KEY_SET.has(propertyName)) continue;
					parts.push(propertyName);
					visit(propertySchema);
				}
			} else if (key === "description" || key === "title" || key === "enum" || key === "const") {
				addStrings(child);
			} else if (key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf") {
				if (Array.isArray(child)) child.forEach(visit);
				else visit(child);
			}
		}
	};
	visit(schema);
	return parts.join(" ");
}

function searchScore(entry: CatalogEntry, query: string, terms: string[]): number {
	const name = entry.name.toLowerCase();
	const orderedNameTokens = searchTokens(name);
	const nameTokens = new Set(orderedNameTokens);
	const labelTokens = new Set(searchTokens(entry.label));
	const descriptionTokens = new Set(searchTokens(`${entry.description} ${entry.promptSnippet}`));
	const schemaTokens = new Set(searchTokens(schemaSearchText(entry.inputSchema)));
	const aliases = TOOL_SEARCH_ALIASES[entry.name as ModelVerbName] ?? [];
	const aliasTokens = new Set(searchTokens(aliases.join(" ")));
	const normalized = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	const normalizedWords = normalized.replace(/_/g, " ");
	let score = normalized === name ? 1000 : name.includes(normalized) && normalized.length > 2 ? 40 : 0;
	// An explicit imperative matching the tool-name verb is stronger than topical
	// overlap. This keeps "surface …" on the surfacing write even when the rest of
	// the sentence also contains read-oriented words such as oldest/chronological.
	if (terms[0] && orderedNameTokens[0] === terms[0]) score += 100;
	if (aliases.some((alias) => normalizedWords.includes(alias))) score += 50;
	for (const term of terms) {
		if (nameTokens.has(term)) score += 12;
		if (labelTokens.has(term)) score += 6;
		if (aliasTokens.has(term)) score += 8;
		if (descriptionTokens.has(term)) score += 3;
		if (
			schemaTokens.has(term) &&
			!nameTokens.has(term) &&
			!labelTokens.has(term) &&
			!aliasTokens.has(term) &&
			!descriptionTokens.has(term)
		) {
			score += 1;
		}
	}
	return score;
}

/** Deterministic lexical search over full generated metadata; results remain slim. */
export function searchRareModelTools(query: string, limit = DEFAULT_SEARCH_LIMIT): CatalogEntry[] {
	const terms = searchTokens(query);
	if (terms.length === 0) return [];
	const boundedLimit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit) || DEFAULT_SEARCH_LIMIT));
	return MCP_CATALOG.filter((entry) =>
		entry.kind === "model" && !HOT_SET.has(entry.name) && !ACTIVATION_ONLY_VERBS.has(entry.name)
	)
		.map((entry, index) => ({ entry, index, score: searchScore(entry, query, terms) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, boundedLimit)
		.map(({ entry }) => slimCatalogEntry(entry));
}

export function toolLoaderInputSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Task or capability to find DevSpec tools for.",
			},
			limit: {
				type: "integer",
				minimum: 1,
				maximum: MAX_SEARCH_LIMIT,
				default: DEFAULT_SEARCH_LIMIT,
			},
		},
		required: ["query"],
	};
}

function normalizePromptLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function activePromptContribution(entries: Array<{ name: string; metadata: ToolPromptMetadata }>): string {
	const snippets = entries.flatMap(({ name, metadata }) => {
		const snippet = metadata.promptSnippet ? normalizePromptLine(metadata.promptSnippet) : "";
		return snippet ? [`- ${name}: ${snippet}`] : [];
	});
	const guidelines = [
		...new Set(
			entries.flatMap(({ metadata }) =>
				(metadata.promptGuidelines ?? []).map(normalizePromptLine).filter(Boolean),
			),
		),
	].map((guideline) => `- ${guideline}`);
	return [...snippets, ...guidelines].join("\n");
}

/** Bytes paid initially: slim schemas, instructions, and Pi's active prompt contributions. */
export function estimatePrefixChars(instructions: string): number {
	const hotTools = modelFacingSurface();
	const tools = hotTools.map((entry) => ({
		name: entry.name,
		description: entry.description,
		inputSchema: entry.inputSchema,
	}));
	const loader = {
		name: TOOL_LOADER_NAME,
		description: TOOL_LOADER_DESCRIPTION,
		inputSchema: toolLoaderInputSchema(),
	};
	const promptContribution = activePromptContribution([
		...hotTools.map((entry) => ({ name: entry.name, metadata: hotToolPromptMetadata(entry) })),
		{ name: TOOL_LOADER_NAME, metadata: TOOL_LOADER_PROMPT_METADATA },
	]);
	return (
		JSON.stringify(tools).length +
		JSON.stringify(loader).length +
		instructions.length +
		promptContribution.length
	);
}

/** Serialized model-prefix delta paid only while plan management is active. */
export function estimatePlanToolChars(): number {
	const entry = catalogEntry(PLAN_TOOL_NAME);
	if (!entry || entry.kind !== "model") return 0;
	const slimmed = slimCatalogEntry(entry);
	return JSON.stringify({
		name: slimmed.name,
		description: slimmed.description,
		inputSchema: slimmed.inputSchema,
	}).length;
}

/** Add/remove only the plan schema while preserving every unrelated active tool. */
export function withPlanToolActive(active: readonly string[], enabled: boolean): string[] {
	const withoutPlan = active.filter((name) => name !== PLAN_TOOL_NAME);
	return enabled ? [...withoutPlan, PLAN_TOOL_NAME] : withoutPlan;
}

/** Add/remove only the question schema; its lifecycle is independent of plans. */
export function withDirectedQuestionToolActive(active: readonly string[], enabled: boolean): string[] {
	const withoutQuestion = active.filter((name) => name !== DIRECTED_QUESTION_TOOL_NAME);
	return enabled ? [...withoutQuestion, DIRECTED_QUESTION_TOOL_NAME] : withoutQuestion;
}

/** Add/remove only the poll schema; collaborative shared state, never a question wake. */
export function withPollToolActive(active: readonly string[], enabled: boolean): string[] {
	const withoutPoll = active.filter((name) => name !== POLL_TOOL_NAME);
	return enabled ? [...withoutPoll, POLL_TOOL_NAME] : withoutPoll;
}

/** Conservative token estimate (chars/4). Target band is 2–8k. */
export function estimatePrefixTokens(instructions: string): number {
	return Math.ceil(estimatePrefixChars(instructions) / 4);
}

export const PREFIX_TOKEN_MAX = 8000;
export const PREFIX_TOKEN_MIN = 2000;
