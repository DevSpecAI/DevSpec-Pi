/**
 * DevSpec Pi — native tools.
 *
 * The generated catalog is the WIRE map. Every safe model-facing verb is a
 * real Pi tool, immediately active when its context permits. Optional hybrid
 * search recommends among those tools without changing activation. Pump/lifecycle
 * verbs and post_session_message are never registered.
 *
 * Headless: tools work in every mode — errors come back as text the model can
 * act on (e.g. "run /devspec.login"), never as UI-only state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { selectTools } from "./core/tool-selection.ts";
import { getBond } from "./core/bond-state.ts";
import { registerRoomReader } from "./core/room-tools.ts";
import { ROOM_READ_TOOL } from "./core/room-reader.ts";
import { agentsSettingsUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { callDevspec, MODEL_TIMEOUT_MS } from "./core/client.ts";
import { repoResolver, validateCommitSha } from "./core/commit-ledger.ts";
import { observeReviewResult, listFlags, type ConflictFlag } from "./core/conflict-watch.ts";
import { reviewScope, reviewData } from "./core/review-context.ts";
import { jsonSchemaToTypebox } from "./core/json-schema.ts";
import { consumeDeliveryLifecycle } from "./core/active-deliveries.ts";
import { observeSuccessfulWorkResult } from "./core/work-state.ts";
import { guardWriteRefs, observeResultClaimRefs } from "./core/provenance-refs.ts";
import {
	activeRequestChain,
	SERVE_REQUEST_DESCRIPTION,
	SERVE_REQUEST_SCHEMA,
	SERVE_REQUEST_TOOL,
	stampRequestRef,
} from "./core/request-chain.ts";
import { directedQuestionTranscriptReceiptId } from "./core/question-receipt-lifecycle.ts";
import {
	catalogEntry,
	DIRECTED_QUESTION_TOOL_NAME,
	HOT_SET_VERBS,
	isConnectionBoundTool,
	scopeKeysForTool,
	TOOL_LOADER_DESCRIPTION,
	TOOL_LOADER_NAME,
	TOOL_LOADER_PROMPT_METADATA,
	allModelFacingTools,
	hotToolPromptMetadata,
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
import { toolVersionMismatchNote } from "./core/version-mismatch.ts";

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
		reviewData({ proposal_id: proposalId, reason }),
		"Relay the proposal id and the reason to the user and say a maintainer has to accept it on the project's Review page, under Proposed changes, before it applies; do not report this change as done.",
	].filter(Boolean).join(" ");
}

/** Unwrap and project a DevSpec result, retaining complete data in details. */
export function unwrapOrThrow(name: string, raw: unknown) {
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
		// A refusal caused by DevSpec and this extension describing the tool
		// differently says so, so the model can tell the person to update
		// (item 39c05c1f). Ordinary mistakes carry no such note.
		const mismatch = toolVersionMismatchNote(name, details, catalogEntry(name)?.inputSchema);
		const reason = text || structuredError || `DevSpec tool ${name} failed.`;
		throw new Error(mismatch ? `${reason}\n\n${mismatch}` : reason);
	}
	const projected = projectedToolResult(name, { text: unwrapped.text, details, isError });
	// Append AFTER projection: ack/full projections intentionally read details,
	// so putting the relay into input.text silently threw it away.
	return relay ? toolTextResult(`${relay}\n\n${projected.content[0].text}`, details) : projected;
}

/** Feed the conflict watch: signals in results become structural flags. */
function watchForSignals(name: string, result: unknown, args: Record<string, unknown>, scope: string, observed?: readonly ConflictFlag[]): void {
	try {
		const details = (result as { details?: unknown }).details;
		observeReviewResult(name, details, args, scope, observed);
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
	scope = reviewScope(sessionId, projectId),
	observed?: readonly ConflictFlag[],
): void {
	watchForSignals(name, result, args, scope, observed);
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
	`Tokens are minted at ${agentsSettingsUrl()}.`;

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
		// Supplied hints retain their bytes. Only an explicit full object may be
		// locally corroborated; omitted/short inputs need server-scoped evidence.
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
		// The ledger is explicit-object assistance, not a work selector. Omitted
		// SHAs stay omitted; short hints stay short so local context cannot erase
		// project-wide ambiguity. The server owns claim-scoped selection and
		// resolution (e47fcd4e, ADR 60efaed0). Only malformed shape throws.
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
		// The request this write serves (item 7a4d04fd): host-only request_ref,
		// stamped from what woke this turn, on every tool whose wire schema takes
		// it. A turn carrying several people's requests that the agent has not
		// named one of refuses the write here, before the network.
		const stamped = await stampRequestRef({
			params: stampHostLocalSession(name, stampHostProvider(name, augmentedParams), ctx.sessionManager.getSessionId()),
			inputSchema: catalogEntry(name)?.inputSchema,
			connectionId: bond?.connectionId,
		});
		if ("deny" in stamped) return measuredToolResult(name, toolErrorResult(stamped.deny));
		const args = stamped.args;
		const localSessionId = ctx.sessionManager.getSessionId();
		const scope = reviewScope(localSessionId, bond?.projectId ?? ctx.cwd, resolved.token);
		const observed = listFlags(scope);
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
		consumeResultMechanics(name, result, args, localSessionId, bond?.projectId, scope, observed);
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

/** Recover legacy deferred announcements without re-announcing denied tools. */
const RARE_VERB_SET: ReadonlySet<string> = new Set(MODEL_VERB_NAMES);
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = params as { query?: unknown; limit?: unknown; offset?: unknown };
			const query = String(input.query ?? "").trim();
			if (!query || query.length > 1000) return toolErrorResult("query must contain 1–1000 characters");
			const result = await selectTools(query, input.limit, pi.getActiveTools().filter(name => !sessionDeniedTools.has(name)), async args => {
				const token = await resolveToken();
				if (!token) throw new Error("not connected");
				const bond = getBond();
				const raw = await callDevspec(token.token, TOOL_LOADER_NAME, stampKnownScope(args, TOOL_LOADER_NAME), {
					cwd: ctx.cwd, lane: "work", timeoutMs: 5000,
					...(bond?.connectionCapability ? { connectionCapability: bond.connectionCapability } : {}),
				});
				const unwrapped = unwrapMcpResult(raw);
				if (unwrapped.isError) throw new Error("search unavailable");
				return unwrapped.details;
			}, input.offset);
			const lines = [
				result.degraded ? result.reason : "These tools are already available; call the appropriate one directly.",
				...result.matches.map(hit => `${hit.name}: ${hit.description}`),
				!result.matches.length ? "No matching callable tool found. No operation was executed." : "",
				result.unavailable.length ? `Unavailable here: ${result.unavailable.join(", ")}. No substitute was selected.` : "",
				result.page.has_more ? `${result.page.returned} of ${result.page.total_matching} matches; pass offset ${result.page.next_offset} for more.` : "",
			].filter(Boolean);
			return measuredToolResult(TOOL_LOADER_NAME, toolTextResult(lines.join("\n"), result));
		},
	});
}

/**
 * The agent names the request its next writes serve (item 7a4d04fd) when a
 * turn carries several people's requests. A host tool, not a DevSpec verb:
 * the request chain lives in this process. Active only while it can matter
 * (devspec-remote shows it when a second request joins a turn).
 */
function registerServeRequestTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SERVE_REQUEST_TOOL,
		label: "Name the request",
		description: SERVE_REQUEST_DESCRIPTION,
		parameters: jsonSchemaToTypebox(SERVE_REQUEST_SCHEMA as unknown as Record<string, unknown>),
		async execute(_toolCallId, params) {
			const input = params as { message_id?: unknown; terminal?: unknown; none?: unknown };
			const chain = activeRequestChain();
			const bond = getBond();
			if (!chain || !bond || chain.connectionId !== bond.connectionId) {
				return measuredToolResult(SERVE_REQUEST_TOOL, toolErrorResult("This Pi is not carrying any DevSpec requests, so there is nothing to name."));
			}
			const served = await chain.serve({ messageId: input.message_id, terminal: input.terminal, none: input.none });
			return measuredToolResult(SERVE_REQUEST_TOOL, served.ok
				? toolTextResult(`Your next DevSpec writes serve ${served.serving}, until another request reaches you.`, { serving: served.serving })
				: toolErrorResult(served.error));
		},
	});
}

/** Every safe generated model verb, each with its own slim schema. */
export function modelFacingCatalog(): CatalogEntry[] {
	return allModelFacingTools();
}

/** Preserve foreign tools and expose every safe non-contextual operation. */
export function initialActiveTools(active: readonly string[]): string[] {
	const devspecVerbs = new Set(modelFacingCatalog().map((entry) => entry.name));
	return [
		...new Set([
			// serve_request is shown only while a turn carries several requests.
			...active.filter((name) => !devspecVerbs.has(name) && name !== TOOL_LOADER_NAME && name !== ROOM_READ_TOOL && name !== SERVE_REQUEST_TOOL),
			...HOT_SET_VERBS,
			TOOL_LOADER_NAME,
			ROOM_READ_TOOL,
		]),
	];
}

export default function (pi: ExtensionAPI) {
	registerContextBudgetToolNames([...MODEL_VERB_NAMES, TOOL_LOADER_NAME, ROOM_READ_TOOL, SERVE_REQUEST_TOOL]);
	for (const entry of allModelFacingTools()) if (entry.name !== TOOL_LOADER_NAME) registerCatalogTool(pi, entry);
	registerToolLoader(pi);
	registerServeRequestTool(pi);
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
		const withRestored = withRestoredTools(initial, restore).filter(name => !sessionDeniedTools.has(name));
		const attached = Boolean(bond?.sessionId && bond.connectionCapability);
		const withPlan = withPlanToolActive(withRestored, Boolean(bond?.sessionId));
		const withPoll = withPollToolActive(withPlan, attached);
		const withQuestion = withDirectedQuestionToolActive(withPoll, attached);
		pi.setActiveTools(withQuestion.filter(name => !sessionDeniedTools.has(name)));
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
