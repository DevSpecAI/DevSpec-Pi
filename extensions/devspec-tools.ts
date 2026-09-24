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
import { registerRoomReader } from "./core/room-tools.ts";
import { ROOM_READ_TOOL } from "./core/room-reader.ts";
import { connectionsUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { callDevspec, MODEL_TIMEOUT_MS } from "./core/client.ts";
import { repoResolver, validateCommitSha } from "./core/commit-ledger.ts";
import { addFlags, extractFlags } from "./core/conflict-watch.ts";
import { jsonSchemaToTypebox } from "./core/json-schema.ts";
import { consumeDeliveryLifecycle } from "./core/active-deliveries.ts";
import { observeSuccessfulWorkResult } from "./core/work-state.ts";
import { guardWriteRefs, observeResultClaimRefs } from "./core/provenance-refs.ts";
import { directedQuestionTranscriptReceiptId } from "./core/question-receipt-lifecycle.ts";
import {
	DIRECTED_QUESTION_TOOL_NAME,
	HOT_SET_VERBS,
	isConnectionBoundTool,
	scopeKeysForTool,
	TOOL_LOADER_DESCRIPTION,
	TOOL_LOADER_NAME,
	TOOL_LOADER_PROMPT_METADATA,
	allModelFacingTools,
	hotToolPromptMetadata,
	rareModelVerbs,
	searchRareModelTools,
	toolLoaderInputSchema,
	withDirectedQuestionToolActive,
	withPlanToolActive,
	withPollToolActive,
} from "./core/model-surface.ts";
import {
	planDuplicateRecovery,
	RECOVERY_ENTRY_TYPE,
	scanTranscriptToolState,
	withRestoredTools,
} from "./core/activation-recovery.ts";
import { debugRemote } from "./core/debug.ts";
import { projectedToolResult, toolErrorResult, toolTextResult, unwrapMcpResult } from "./core/result.ts";
import {
	noteModelToolResult,
	registerContextBudgetToolNames,
} from "./core/context-budget.ts";
import {
	clearAutomation,
	clearWork,
	extractItemRef,
	extractAutomationRef,
	noteAutomation,
	noteWork,
	paintStatus,
} from "./core/status-line.ts";
import { MODEL_VERB_NAMES, type CatalogEntry } from "./generated/mcp-catalog.ts";

/**
 * A write the server queued instead of committing (DevSpec item 06936ee9). The
 * served authority_contract decides who may commit; Pi's only job is to make the
 * outcome impossible to miss — the model must relay the proposal id and the reason
 * and never report the change as done.
 */
export function queuedForReviewRelay(details: unknown): string | null {
	if (details === null || typeof details !== "object" || Array.isArray(details)) return null;
	const row = details as Record<string, unknown>;
	if (row.outcome !== "queued_for_review") return null;
	const proposalId = typeof row.proposal_id === "string" && row.proposal_id.trim() ? row.proposal_id.trim() : null;
	const reason = typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : null;
	return [
		"QUEUED FOR A MAINTAINER — not in effect.",
		proposalId ? `Proposal ${proposalId}.` : null,
		reason ? `Reason: ${reason}` : null,
		"Relay the proposal id and the reason to the user and say a maintainer has to accept it on the project's Review tab before it applies; do not report this change as done.",
	].filter(Boolean).join(" ");
}

/** Unwrap and project a DevSpec result, retaining complete data in details. */
function unwrapOrThrow(name: string, raw: unknown) {
	const unwrapped = unwrapMcpResult(raw);
	const relay = unwrapped.isError ? null : queuedForReviewRelay(unwrapped.details);
	const { details, isError } = unwrapped;
	const text = relay ? `${relay}\n\n${unwrapped.text}` : unwrapped.text;
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
		// Footer state is a view of observed coordination, never its source. A
		// rejected claim must not look active.
		if (claimArmed) noteWork(ref);
	} else if (name === "record_implementation" || name === "release_work_item" || name === "fail_work_item") {
		clearWork(ref.id);
	} else if (name === "claim_automation_run") {
		if (claimFlag(result) !== false) noteAutomation(extractAutomationRef(result));
	} else if (name === "record_automation_run") {
		clearAutomation(extractAutomationRef(result).runId);
	}
	paintStatus();
}

/** Consume complete structured details for conflict and footer mechanics. */
export function consumeResultMechanics(
	name: string,
	result: unknown,
	args: Record<string, unknown> = {},
	sessionId?: string,
	projectId?: string,
): void {
	watchForSignals(name, result);
	// Claim refs are dealt through results, not deliveries — observe them so the
	// guard knows them (item a03ba7ab).
	observeResultClaimRefs(result);
	// executeVerb calls this only after unwrapOrThrow has established MCP success.
	// This observation drives status and nudge suppression only; it grants no permission.
	const claimArmed = sessionId
		? observeSuccessfulWorkResult(name, args, result, sessionId, projectId) && name === "claim_work_item"
		: false;
	applyWorkStatus(name, result, claimArmed);
	consumeDeliveryLifecycle(name, args, result);
}

const NOT_CONNECTED =
	`Not connected to DevSpec. Run /devspec.login, or set ${TOKEN_ENV_VAR}. ` +
	`Tokens are minted at ${connectionsUrl()}.`;

type CallCtx = { sessionManager: { getSessionId(): string }; cwd: string };

type PiToolResult = {
	content?: Array<{ type?: string; text?: string }>;
	terminate?: boolean;
};

/**
 * A created directed-question card is the blocking turn's terminal output. Pi
 * stops only when every result in the same tool batch carries terminate=true,
 * so mixed create/read/work batches remain safe and continue normally.
 */
export function shouldTerminateAfterDirectedQuestionCreate(
	name: string,
	args: Record<string, unknown>,
	result: unknown,
): boolean {
	return name === DIRECTED_QUESTION_TOOL_NAME && args.action === "create" &&
		args.keep_turn !== true &&
		directedQuestionTranscriptReceiptId(result) !== null;
}

/** Attribute model-visible characters only; details/args never enter telemetry. */
function measuredToolResult<T extends PiToolResult>(name: string, result: T): T {
	const chars = (result.content ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
	noteModelToolResult(name, chars);
	return result;
}

export function applyCommitLedgerVerdict(
	params: Record<string, unknown>,
	verdict: Extract<ReturnType<typeof validateCommitSha>, { ok: true }>,
): Record<string, unknown> {
	// Provenance source is a host observation, never a model-authored parameter.
	const { commit_provenance_source: _modelSource, commit_sha: _modelSha, ...hostSafeParams } = params;
	return {
		...hostSafeParams,
		// sha null = no sha sent at all: the server's own mechanical fill (or the
		// tag on the landed commit) carries the identity — never write a null key.
		// A non-null value may be ledger-verified, cwd-resolved, or an unverified
		// hint the server resolves project-wide (item b07a518f, ADR 60efaed0).
		...(verdict.sha !== null ? { commit_sha: verdict.sha } : {}),
		// Pi can mechanically attach a recognized commit object's message, but
		// cannot prove that a Bash surface authored its DevSpec reference. Source
		// therefore stays absent and the server records conservative linkage.
		...(verdict.commitMessage ? { commit_message: verdict.commitMessage } : {}),
	};
}

/** Per-verb argument transforms that cannot live in the generated catalog. */
const AUGMENTS: Record<string, (params: Record<string, unknown>, ctx: CallCtx) => Record<string, unknown>> = {
	record_implementation: (params, ctx) => {
		// The ledger (item efe7e0a7) is accuracy assistance, not a gate: a ledger
		// or cwd hit attaches the mechanical message and canonical sha; a miss
		// passes the model's value through as a hint the server resolves across
		// every tracked repo of the project (item b07a518f, ADR 60efaed0). Only
		// shape garbage still throws — never identity.
		const verdict = validateCommitSha(params.commit_sha as string | undefined, repoResolver(ctx.cwd));
		if (!verdict.ok) throw new Error(verdict.error);
		return applyCommitLedgerVerdict(params, verdict);
	},
};

const LOCAL_SESSION_STAMPED_VERBS: ReadonlySet<string> = new Set([
	"update_action_item",
	"record_automation_run",
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
 * NOT included: create_automation / update_automation take `preferred_provider`,
 * which is "which agent is this automation written FOR" — a genuine authoring
 * choice that belongs to the caller, not the host's identity.
 */
const HOST_PROVIDER = "pi";

const PROVIDER_STAMPED_VERBS: ReadonlySet<string> = new Set([
	// Attribution: persisted to action_items.provider.
	"claim_work_item",
	"record_implementation",
	"record_completed_work",
	// Automation runs: free-text "your coding agent", used to match a run's
	// provider constraint and to build the resume affordance.
	"get_automation_runs",
	"claim_automation_run",
	"record_automation_run",
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
export function stampKnownScope(params: Record<string, unknown>, name?: string): Record<string, unknown> {
	const omit = scopeKeysForTool(name);
	const stamped: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (omit.has(key)) continue;
		stamped[key] = value;
	}
	// Connection-bound ledgers derive identity, session and project exclusively
	// from the capability-authenticated connection. Even host-known ids do not
	// become model arguments.
	if (name && isConnectionBoundTool(name)) return stamped;
	const bond = getBond();
	// Target session_id (get_session_transcript) is model-owned; only fill the
	// bonded room when the model omitted it. Other verbs still stamp over.
	if (!stamped.session_id && bond?.sessionId) stamped.session_id = bond.sessionId;
	if (bond?.connectionId) stamped.connection_id = bond.connectionId;
	return stamped;
}

async function executeVerb(name: string, params: Record<string, unknown>, ctx: CallCtx) {
	// The provenance-ref guard (item a03ba7ab): a ref this process was never
	// dealt is a transcription error — refuse it locally, before any network.
	// Omission is always allowed: the server attributes to the open turn.
	const refVerdict = guardWriteRefs(params);
	if (!refVerdict.ok) return measuredToolResult(name, toolErrorResult(refVerdict.message));
	const resolved = await resolveToken();
	if (!resolved) return measuredToolResult(name, toolErrorResult(NOT_CONNECTED));
	try {
		const augment = AUGMENTS[name];
		const bond = getBond();
		const scopedParams = stampKnownScope(params, name);
		const augmentedParams = augment ? augment(scopedParams, ctx) : scopedParams;
		const args = stampHostLocalSession(
			name,
			stampHostProvider(name, augmentedParams),
			ctx.sessionManager.getSessionId(),
		);
		const localSessionId = ctx.sessionManager.getSessionId();
		const raw = await callDevspec(resolved.token, name, args, {
			cwd: ctx.cwd,
			lane: "work",
			timeoutMs: MODEL_TIMEOUT_MS,
			...((isConnectionBoundTool(name)) && bond?.connectionCapability
				? { connectionCapability: bond.connectionCapability }
				: {}),
		});
		const projected = unwrapOrThrow(name, raw);
		const result = shouldTerminateAfterDirectedQuestionCreate(name, args, projected)
			? { ...projected, terminate: true as const }
			: projected;
		consumeResultMechanics(name, result, args, localSessionId, getBond()?.projectId);
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

/** Rare verbs are the loader's domain; transcript-announced restores are scoped to them. */
const RARE_VERB_SET: ReadonlySet<string> = new Set(rareModelVerbs());
const MODEL_VERB_SET: ReadonlySet<string> = new Set([...MODEL_VERB_NAMES, ROOM_READ_TOOL]);

/**
 * Tools deactivated by duplicate-tool recovery (item dc8f52d4). Re-seeded from
 * the transcript on every session_start, so it survives an in-process /reload
 * of the same session but never leaks into a different one.
 */
const sessionDeniedTools = new Set<string>();

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

			// Tools deactivated by duplicate-tool recovery must stay inactive:
			// re-activating re-announces them, and a transcript carrying two
			// announcements for one tool is exactly what bricked dc8f52d4.
			const loadable = matches.filter((name) => !sessionDeniedTools.has(name));
			const unavailable = matches.filter((name) => sessionDeniedTools.has(name));
			if (loadable.length === 0) {
				return measuredToolResult(TOOL_LOADER_NAME, toolTextResult(
					`Matching DevSpec tools are unavailable this session (deactivated after a provider duplicate-tool error): ${unavailable.join(", ")}`,
					{ matches, added: [], unavailable },
				));
			}

			const active = pi.getActiveTools();
			const activeSet = new Set(active);
			const added = loadable.filter((name) => !activeSet.has(name));
			if (added.length > 0) pi.setActiveTools([...active, ...added]);
			const unavailableNote = unavailable.length > 0
				? `; unavailable this session (deactivated after a provider duplicate-tool error): ${unavailable.join(", ")}`
				: "";
			return measuredToolResult(TOOL_LOADER_NAME, toolTextResult(
				(added.length > 0
					? `Loaded DevSpec tools: ${added.join(", ")}`
					: `Matching DevSpec tools already active: ${loadable.join(", ")}`) + unavailableNote,
				{ matches, added, unavailable },
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
			...active.filter((name) => !devspecVerbs.has(name) && name !== TOOL_LOADER_NAME && name !== ROOM_READ_TOOL),
			...HOT_SET_VERBS,
			TOOL_LOADER_NAME,
			ROOM_READ_TOOL,
		]),
	];
}

export default function (pi: ExtensionAPI) {
	registerContextBudgetToolNames([...MODEL_VERB_NAMES, TOOL_LOADER_NAME, ROOM_READ_TOOL]);
	for (const entry of allModelFacingTools()) registerCatalogTool(pi, entry);
	registerToolLoader(pi);
	registerRoomReader(pi, () => {
		if (sessionDeniedTools.has("get_session_transcript")) return false;
		const active = pi.getActiveTools();
		if (!active.includes("get_session_transcript")) pi.setActiveTools([...active, "get_session_transcript"]);
		return true;
	});
	pi.on("session_start", (_event, ctx) => {
		const bond = getBond();
		const initial = initialActiveTools(pi.getActiveTools());
		// Resume/reload: the transcript keeps every addedToolNames announcement
		// forever, so re-activate exactly what this branch already announced
		// (item dc8f52d4) — otherwise the loader re-announces a stripped tool and
		// Kimi-mode serializers put the same definition on the wire twice. Fresh
		// sessions have no announcements, so the happy path is unchanged.
		const { restore, denied } = scanTranscriptToolState(
			ctx?.sessionManager?.getBranch?.() ?? [],
			(name) => RARE_VERB_SET.has(name) || name === ROOM_READ_TOOL,
		);
		sessionDeniedTools.clear();
		for (const name of denied) sessionDeniedTools.add(name);
		const withRestored = withRestoredTools(initial, restore);
		const attached = Boolean(bond?.sessionId && bond.connectionCapability);
		const withPlan = withPlanToolActive(withRestored, Boolean(bond?.sessionId));
		const withPoll = withPollToolActive(withPlan, attached);
		const withQuestion = withDirectedQuestionToolActive(withPoll, attached);
		pi.setActiveTools(sessionDeniedTools.has(ROOM_READ_TOOL) ? withQuestion.filter(name => name !== ROOM_READ_TOOL) : withQuestion);
	});

	// Safety net (item dc8f52d4): if a duplicate-tools provider error still
	// occurs — e.g. a transcript poisoned before the resume fix — deactivate the
	// named tools and continue the turn instead of letting the session brick.
	// Compensates for Pi's Kimi deferred-tools serializer re-injecting a tool
	// definition after every announcing toolResult group; the serializer-side
	// fix is upstream (see the follow-up item linked from dc8f52d4).
	pi.on("agent_end", async (event, ctx) => {
		const plan = planDuplicateRecovery(event.messages, {
			isCatalogTool: (name) => MODEL_VERB_SET.has(name),
			isActive: (name) => pi.getActiveTools().includes(name),
			isDenied: (name) => sessionDeniedTools.has(name),
		});
		if (!plan) return;
		for (const name of plan.names) sessionDeniedTools.add(name);
		pi.setActiveTools(pi.getActiveTools().filter((name) => !plan.names.includes(name)));
		debugRemote("duplicate-tool recovery", { count: plan.names.length });
		// Persist the denial with the session (appendEntry never reaches the
		// model) so a later resume does not restore a twice-announced tool.
		try {
			pi.appendEntry(RECOVERY_ENTRY_TYPE, { denied: plan.names, error: plan.errorMessage });
		} catch (err) {
			debugRemote("duplicate-tool recovery persist failed", { errorPresent: Boolean(err) });
		}
		if (ctx.hasUI) {
			ctx.ui.notify(
				`DevSpec recovered from a provider error — deactivated for this session: ${plan.names.join(", ")}`,
				"warning",
			);
		}
		try {
			pi.sendUserMessage(
				`DevSpec recovery: the provider rejected the last request because the tool${plan.names.length === 1 ? "" : "s"} ${plan.names.join(", ")} ${plan.names.length === 1 ? "was" : "were"} defined twice. ${plan.names.length === 1 ? "It is" : "They are"} deactivated for the rest of this session and cannot be re-loaded here — please continue without ${plan.names.length === 1 ? "it" : "them"}.`,
				{ deliverAs: "followUp" },
			);
		} catch (err) {
			debugRemote("duplicate-tool recovery continue failed", { errorPresent: Boolean(err) });
		}
	});
}
