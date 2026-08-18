/**
 * DevSpec Pi — native tools.
 *
 * The generated catalog is the WIRE map. Every safe model-facing verb is a
 * real Pi tool, but only a small everyday hot set starts active. One tiny
 * search tool additively loads less-common tools on demand. Pump/lifecycle
 * verbs and post_session_message are never registered.
 *
 * Headless: tools work in every mode — errors come back as text the model can
 * act on (e.g. "run /devspec.login"), never as UI-only state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { getBond } from "./core/bond-state.ts";
import { connectionsUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { callDevspec, MODEL_TIMEOUT_MS } from "./core/client.ts";
import { repoResolver, validateCommitSha } from "./core/commit-ledger.ts";
import { addFlags, extractFlags } from "./core/conflict-watch.ts";
import { jsonSchemaToTypebox } from "./core/json-schema.ts";
import { consumeDeliveryLifecycle } from "./core/active-deliveries.ts";
import {
	claimAuthorityScope,
	observeSuccessfulWorkResult,
	type ClaimAuthorityScope,
} from "./core/claim-authority.ts";
import {
	HOT_SET_VERBS,
	SCOPE_KEY_SET,
	TOOL_LOADER_DESCRIPTION,
	TOOL_LOADER_NAME,
	TOOL_LOADER_PROMPT_METADATA,
	allModelFacingTools,
	hotToolPromptMetadata,
	searchRareModelTools,
	toolLoaderInputSchema,
} from "./core/model-surface.ts";
import { projectedToolResult, toolErrorResult, toolTextResult, unwrapMcpResult } from "./core/result.ts";
import {
	noteModelToolResult,
	registerContextBudgetToolNames,
} from "./core/context-budget.ts";
import {
	clearPlaybook,
	clearWork,
	extractItemRef,
	extractPlaybookRef,
	notePlaybook,
	noteWork,
	paintStatus,
} from "./core/status-line.ts";
import { MODEL_VERB_NAMES, type CatalogEntry } from "./generated/mcp-catalog.ts";

/** Unwrap and project a DevSpec result, retaining complete data in details. */
function unwrapOrThrow(name: string, raw: unknown) {
	const { text, details, isError } = unwrapMcpResult(raw);
	// Errors intentionally stay full rather than passing through a size-oriented
	// success projection: the model must see every actionable server detail.
	if (isError) {
		let structuredError = "";
		try {
			structuredError = details == null ? "" : JSON.stringify(details, null, 2);
		} catch {
			/* parsed JSON should be serializable; retain the generic fallback if not */
		}
		throw new Error(text || structuredError || `DevSpec tool ${name} failed.`);
	}
	return projectedToolResult(name, { text, details, isError });
}

/** Feed the conflict watch: signals in results become structural flags. */
function watchForSignals(name: string, result: unknown): void {
	try {
		const details = (result as { details?: unknown }).details;
		addFlags(extractFlags(name, details));
	} catch {
		/* never let the watch break a tool call */
	}
}

function claimFlag(result: unknown): unknown {
	if (!result || typeof result !== "object") return undefined;
	const root = result as { claimed?: unknown; details?: { claimed?: unknown } };
	return root.details && typeof root.details === "object" ? root.details.claimed : root.claimed;
}

function applyWorkStatus(name: string, result: unknown, claimArmed: boolean): void {
	const ref = extractItemRef(result);
	if (name === "claim_work_item") {
		// Footer state is a view of authority, never its source. A rejected claim
		// must not look active or accidentally become mutation permission.
		if (claimArmed) noteWork(ref);
	} else if (name === "record_implementation" || name === "release_work_item" || name === "fail_work_item") {
		clearWork(ref.id);
	} else if (name === "claim_playbook_run") {
		if (claimFlag(result) !== false) notePlaybook(extractPlaybookRef(result));
	} else if (name === "record_playbook_run") {
		clearPlaybook(extractPlaybookRef(result).runId);
	}
	paintStatus();
}

/** Consume complete structured details for conflict and footer mechanics. */
export function consumeResultMechanics(
	name: string,
	result: unknown,
	args: Record<string, unknown> = {},
	authorityScope?: ClaimAuthorityScope,
): void {
	watchForSignals(name, result);
	// executeVerb calls this only after unwrapOrThrow has established MCP success.
	// This is the sole bridge from server result to scoped mutation authority.
	const claimArmed = authorityScope
		? observeSuccessfulWorkResult(name, args, result, authorityScope) && name === "claim_work_item"
		: false;
	applyWorkStatus(name, result, claimArmed);
	consumeDeliveryLifecycle(name, args, result);
}

const NOT_CONNECTED =
	`Not connected to DevSpec. Run /devspec.login, or set ${TOKEN_ENV_VAR}. ` +
	`Tokens are minted at ${connectionsUrl()}.`;

type CallCtx = { sessionManager: { getSessionId(): string }; cwd: string };

type PiToolResult = { content?: Array<{ type?: string; text?: string }> };

/** Attribute model-visible characters only; details/args never enter telemetry. */
function measuredToolResult<T extends PiToolResult>(name: string, result: T): T {
	const chars = (result.content ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
	noteModelToolResult(name, chars);
	return result;
}

/** Per-verb argument transforms that cannot live in the generated catalog. */
const AUGMENTS: Record<string, (params: Record<string, unknown>, ctx: CallCtx) => Record<string, unknown>> = {
	record_implementation: (params, ctx) => {
		// The ledger guard (item efe7e0a7): never let a transcribed SHA reach
		// the server unverified. Throws → the model gets the candidate list
		// back as the tool error and corrects immediately.
		const verdict = validateCommitSha(params.commit_sha as string | undefined, repoResolver(ctx.cwd));
		if (!verdict.ok) throw new Error(verdict.error);
		return { ...params, commit_sha: verdict.sha };
	},
};

const LOCAL_SESSION_STAMPED_VERBS: ReadonlySet<string> = new Set([
	"update_action_item",
	"record_playbook_run",
	"claim_work_item",
	"record_implementation",
]);

/** The current Pi runtime, never model parameters, owns local resume identity. */
export function stampHostLocalSession(
	name: string,
	params: Record<string, unknown>,
	localSessionId: string,
): Record<string, unknown> {
	if (!LOCAL_SESSION_STAMPED_VERBS.has(name)) return params;
	return { ...params, local_session_id: localSessionId };
}

/**
 * This host is Pi. `provider` on these verbs is not a model choice — it is a
 * fact about which coding agent is running, and DevSpec renders it as the tool
 * logo on the Agents page, active-agent tiles and provenance chips. A model that
 * omits it leaves the work unattributed; a model that guesses it attributes Pi's
 * work to another tool. So it is stamped here, after the model's params, and
 * always wins — the same treatment the commit ledger gives commit_sha.
 *
 * NOT included: create_playbook / update_playbook take `preferred_provider`,
 * which is "which agent is this playbook written FOR" — a genuine authoring
 * choice that belongs to the caller, not the host's identity.
 */
const HOST_PROVIDER = "pi";

const PROVIDER_STAMPED_VERBS: ReadonlySet<string> = new Set([
	// Attribution: persisted to action_items.provider.
	"claim_work_item",
	"record_implementation",
	"record_completed_work",
	// Playbook runs: free-text "your coding agent", used to match a run's
	// provider constraint and to build the resume affordance.
	"get_playbook_runs",
	"claim_playbook_run",
	"record_playbook_run",
]);

/** Stamp the host's own provider identity on the verbs that record or filter it. */
export function stampHostProvider(
	name: string,
	params: Record<string, unknown>,
): Record<string, unknown> {
	if (!PROVIDER_STAMPED_VERBS.has(name)) return params;
	return { ...params, provider: HOST_PROVIDER };
}

/** Drop scope the extension already knows, then stamp bond/cwd values. */
export function stampKnownScope(params: Record<string, unknown>): Record<string, unknown> {
	const stamped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (SCOPE_KEY_SET.has(key)) continue;
		stamped[key] = value;
	}
	const bond = getBond();
	if (bond?.sessionId) stamped.session_id = bond.sessionId;
	if (bond?.connectionId) stamped.connection_id = bond.connectionId;
	return stamped;
}

async function executeVerb(name: string, params: Record<string, unknown>, ctx: CallCtx) {
	const resolved = await resolveToken();
	if (!resolved) return measuredToolResult(name, toolErrorResult(NOT_CONNECTED));
	try {
		const augment = AUGMENTS[name];
		const scopedParams = stampKnownScope(params);
		const augmentedParams = augment ? augment(scopedParams, ctx) : scopedParams;
		const args = stampHostLocalSession(
			name,
			stampHostProvider(name, augmentedParams),
			ctx.sessionManager.getSessionId(),
		);
		const authorityScope = claimAuthorityScope(ctx.sessionManager.getSessionId(), ctx.cwd);
		const raw = await callDevspec(resolved.token, name, args, {
			cwd: ctx.cwd,
			lane: "work",
			timeoutMs: MODEL_TIMEOUT_MS,
		});
		const result = unwrapOrThrow(name, raw);
		consumeResultMechanics(name, result, args, authorityScope ?? undefined);
		return measuredToolResult(name, result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return measuredToolResult(name, toolErrorResult(message));
	}
}

function registerCatalogTool(pi: ExtensionAPI, def: CatalogEntry): void {
	pi.registerTool({
		name: def.name,
		label: def.label,
		description: def.description,
		// Deferred tools must not mutate the system prompt when activated.
		...hotToolPromptMetadata(def),
		parameters: jsonSchemaToTypebox(def.inputSchema),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeVerb(def.name, params as Record<string, unknown>, ctx);
		},
	});
}

function registerToolLoader(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_LOADER_NAME,
		label: "Search DevSpec tools",
		description: TOOL_LOADER_DESCRIPTION,
		...TOOL_LOADER_PROMPT_METADATA,
		parameters: jsonSchemaToTypebox(toolLoaderInputSchema()),
		async execute(_toolCallId, params) {
			const input = params as { query?: unknown; limit?: unknown };
			const query = String(input.query ?? "").trim();
			const limit = typeof input.limit === "number" ? input.limit : undefined;
			const matches = searchRareModelTools(query, limit).map((entry) => entry.name);
			if (matches.length === 0) {
				return measuredToolResult(TOOL_LOADER_NAME, toolTextResult(`No less-common DevSpec tools found for: ${query}`, {
					matches: [],
					added: [],
				}));
			}

			const active = pi.getActiveTools();
			const activeSet = new Set(active);
			const added = matches.filter((name) => !activeSet.has(name));
			if (added.length > 0) pi.setActiveTools([...active, ...added]);
			return measuredToolResult(TOOL_LOADER_NAME, toolTextResult(
				added.length > 0
					? `Loaded DevSpec tools: ${added.join(", ")}`
					: `Matching DevSpec tools already active: ${matches.join(", ")}`,
				{ matches, added },
			));
		},
	});
}

/** Every safe generated model verb, each with its own slim schema. */
export function modelFacingCatalog(): CatalogEntry[] {
	return allModelFacingTools();
}

/** Preserve non-DevSpec tools while resetting this extension to hot set + loader. */
export function initialActiveTools(active: readonly string[]): string[] {
	const devspecVerbs = new Set(modelFacingCatalog().map((entry) => entry.name));
	return [
		...new Set([
			...active.filter((name) => !devspecVerbs.has(name) && name !== TOOL_LOADER_NAME),
			...HOT_SET_VERBS,
			TOOL_LOADER_NAME,
		]),
	];
}

export default function (pi: ExtensionAPI) {
	registerContextBudgetToolNames([...MODEL_VERB_NAMES, TOOL_LOADER_NAME]);
	for (const entry of allModelFacingTools()) registerCatalogTool(pi, entry);
	registerToolLoader(pi);
	pi.on("session_start", () => {
		pi.setActiveTools(initialActiveTools(pi.getActiveTools()));
	});
}
