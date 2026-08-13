/**
 * DevSpec Pi — the model-facing tool surface (item 7de79db6).
 *
 * The generated catalog (`extensions/generated/mcp-catalog.ts`) is the WIRE
 * map: every MCP verb, full essays, full schemas. That is not what the model
 * sees. This file is the parallel Pi-shaped projection:
 *
 *   - a small always-on hot set (~15 everyday verbs)
 *   - short snippets, slimed schemas
 *   - scope keys the extension already knows are stripped (git_remote,
 *     project_id, session_id, runner_session_id, connection_id)
 *   - rare verbs stay on the wire and load through one `devspec` gateway
 *
 * Target: tools + workflow block ≈ 2–8k tokens, not ~60k.
 */

import {
	MCP_CATALOG,
	MODEL_VERB_NAMES,
	type CatalogEntry,
} from "../generated/mcp-catalog.ts";

/** Everyday work. Not all 76. Order is the prompt order. */
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

/** Keys the extension stamps. The model must never be asked for these. */
export const SCOPE_KEYS = [
	"git_remote",
	"project_id",
	"session_id",
	"runner_session_id",
	"connection_id",
] as const;

export const SCOPE_KEY_SET = new Set<string>(SCOPE_KEYS);

export const GATEWAY_TOOL_NAME = "devspec";

const SNIPPET_MAX = 140;

export function firstSentence(text: string, max = SNIPPET_MAX): string {
	const trimmed = String(text ?? "")
		.trim()
		.replace(/\s+/g, " ");
	if (!trimmed) return "";
	const cut = trimmed.search(/[.!?](?:\s|$)/);
	const sentence = cut >= 0 ? trimmed.slice(0, cut + 1) : trimmed;
	return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

function slimUnknown(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(slimUnknown);
	if (!value || typeof value !== "object") return value;
	return slimSchema(value as Record<string, unknown>);
}

/** Recursively drop stamped scope keys and shrink description essays. */
export function slimSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
			const props: Record<string, unknown> = {};
			for (const [name, prop] of Object.entries(value as Record<string, unknown>)) {
				if (SCOPE_KEY_SET.has(name)) continue;
				props[name] = slimUnknown(prop);
			}
			out.properties = props;
			continue;
		}
		if (key === "required" && Array.isArray(value)) {
			const required = value.filter((name) => typeof name === "string" && !SCOPE_KEY_SET.has(name));
			if (required.length > 0) out.required = required;
			continue;
		}
		if (key === "description" && typeof value === "string") {
			out.description = firstSentence(value);
			continue;
		}
		if (value && typeof value === "object") {
			out[key] = slimUnknown(value);
			continue;
		}
		out[key] = value;
	}
	return out;
}

export function slimCatalogEntry(entry: CatalogEntry): CatalogEntry {
	return {
		...entry,
		description: firstSentence(entry.promptSnippet || entry.description),
		promptSnippet: firstSentence(entry.promptSnippet || entry.description),
		inputSchema: slimSchema(entry.inputSchema),
	};
}

export function catalogEntry(name: string): CatalogEntry | undefined {
	return MCP_CATALOG.find((entry) => entry.name === name);
}

/** Slimmed hot-set entries, in prompt order. Missing catalog names are skipped. */
export function modelFacingSurface(): CatalogEntry[] {
	const out: CatalogEntry[] = [];
	for (const name of HOT_SET_VERBS) {
		const entry = catalogEntry(name);
		if (!entry || entry.kind !== "model") continue;
		out.push(slimCatalogEntry(entry));
	}
	return out;
}

/** Model-kind catalog verbs that are not in the hot set. */
export function rareModelVerbs(): string[] {
	return MODEL_VERB_NAMES.filter((name) => !HOT_SET.has(name));
}

export function isCallableModelVerb(name: string): boolean {
	const entry = catalogEntry(name);
	return Boolean(entry && entry.kind === "model");
}

export function isHotSetVerb(name: string): boolean {
	return HOT_SET.has(name);
}

export type GatewayVerbResolution =
	| { ok: true; verb: string }
	| { ok: false; error: string };

/** Validate a `devspec` gateway verb before it hits the wire. */
export function resolveGatewayVerb(verb: string): GatewayVerbResolution {
	const name = verb.trim();
	if (!name) return { ok: false, error: "devspec requires a verb." };
	if (isHotSetVerb(name)) {
		return {
			ok: false,
			error: `${name} is a dedicated tool — call it directly, not through devspec.`,
		};
	}
	if (!isCallableModelVerb(name)) {
		return {
			ok: false,
			error: `${name} is not a model-facing DevSpec verb. Everyday work uses the dedicated tools; rare verbs are listed on this tool's verb enum.`,
		};
	}
	return { ok: true, verb: name };
}

/** Schema the `devspec` gateway shows the model — names only, no essays. */
export function gatewayInputSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			verb: {
				type: "string",
				enum: rareModelVerbs(),
				description: "Less-common DevSpec verb (MCP name). Everyday work uses the dedicated tools.",
			},
			args: {
				type: "object",
				description: "Arguments for that verb. Do not pass git_remote, project_id, or session id.",
			},
		},
		required: ["verb"],
	};
}

export const GATEWAY_DESCRIPTION =
	"Call a less-common DevSpec verb (playbooks, reviews, assignments, instruction rules, …). Everyday work uses the dedicated tools. verb is the MCP name; args is that verb's arguments.";

/** Bytes the model pays for: slimed hot-set tools + the gateway + instructions. */
export function estimatePrefixChars(instructions: string): number {
	const tools = modelFacingSurface().map((entry) => ({
		name: entry.name,
		description: entry.description,
		inputSchema: entry.inputSchema,
	}));
	const gateway = {
		name: GATEWAY_TOOL_NAME,
		description: GATEWAY_DESCRIPTION,
		inputSchema: gatewayInputSchema(),
	};
	return JSON.stringify(tools).length + JSON.stringify(gateway).length + instructions.length;
}

/** Conservative token estimate (chars/4). Target band is 2–8k. */
export function estimatePrefixTokens(instructions: string): number {
	return Math.round(estimatePrefixChars(instructions) / 4);
}

export const PREFIX_TOKEN_MAX = 8000;
export const PREFIX_TOKEN_MIN = 1500;
