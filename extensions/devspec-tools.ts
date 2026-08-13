/**
 * DevSpec Pi — native tools (item 7de79db6).
 *
 * The generated catalog is the WIRE map. This file is the model surface:
 * a small hot set of everyday verbs, plus one `devspec` gateway for the
 * rest. Pump/lifecycle verbs stay extension-internal. post_session_message
 * is never registered — conversational delivery is mechanical (cc9e8c43).
 *
 * Headless: tools work in every mode — errors come back as text the model can
 * act on (e.g. "run /devspec.login"), never as UI-only state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { getBond } from "./core/bond-state.ts";
import { connectionsUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { callDevspec } from "./core/client.ts";
import { repoResolver, validateCommitSha } from "./core/commit-ledger.ts";
import { addFlags, extractFlags } from "./core/conflict-watch.ts";
import { jsonSchemaToTypebox } from "./core/json-schema.ts";
import {
	GATEWAY_DESCRIPTION,
	GATEWAY_TOOL_NAME,
	SCOPE_KEY_SET,
	gatewayInputSchema,
	modelFacingSurface,
	rareModelVerbs,
	resolveGatewayVerb,
} from "./core/model-surface.ts";
import { toolErrorResult, toolTextResult, unwrapMcpResult } from "./core/result.ts";
import {
	clearPlaybook,
	clearWork,
	extractItemRef,
	extractPlaybookRef,
	notePlaybook,
	noteWork,
	paintStatus,
} from "./core/status-line.ts";
import type { CatalogEntry } from "./generated/mcp-catalog.ts";

/** Unwrap a DevSpec MCP result, converting isError payloads into thrown errors. */
function unwrapOrThrow(name: string, raw: unknown) {
	const { text, details, isError } = unwrapMcpResult(raw);
	if (isError) throw new Error(text || `DevSpec tool ${name} failed.`);
	return toolTextResult(text || "(empty response)", details ?? {});
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

function applyWorkStatus(name: string, result: unknown): void {
	const ref = extractItemRef(result);
	if (name === "claim_work_item") {
		noteWork(ref);
	} else if (name === "record_implementation" || name === "release_work_item" || name === "fail_work_item") {
		clearWork(ref.id);
	} else if (name === "claim_playbook_run") {
		if (claimFlag(result) !== false) notePlaybook(extractPlaybookRef(result));
	} else if (name === "record_playbook_run") {
		clearPlaybook(extractPlaybookRef(result).runId);
	}
	paintStatus();
}

const NOT_CONNECTED =
	`Not connected to DevSpec. Run /devspec.login, or set ${TOKEN_ENV_VAR}. ` +
	`Tokens are minted at ${connectionsUrl()}.`;

type CallCtx = { sessionManager: { getSessionId(): string }; cwd: string };

/** Per-verb argument stamps that cannot live in the generated catalog. */
const AUGMENTS: Record<string, (params: Record<string, unknown>, ctx: CallCtx) => Record<string, unknown>> = {
	claim_work_item: (params, ctx) => ({
		local_session_id: ctx.sessionManager.getSessionId(),
		...params,
	}),
	record_implementation: (params, ctx) => {
		// The ledger guard (item efe7e0a7): never let a transcribed SHA reach
		// the server unverified. Throws → the model gets the candidate list
		// back as the tool error and corrects immediately.
		const verdict = validateCommitSha(params.commit_sha as string | undefined, repoResolver(ctx.cwd));
		if (!verdict.ok) throw new Error(verdict.error);
		return { local_session_id: ctx.sessionManager.getSessionId(), ...params, commit_sha: verdict.sha };
	},
};

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
	if (!resolved) return toolErrorResult(NOT_CONNECTED);
	try {
		const augment = AUGMENTS[name];
		const args = stampKnownScope(augment ? augment(params, ctx) : params);
		const raw = await callDevspec(resolved.token, name, args, { cwd: ctx.cwd });
		const result = unwrapOrThrow(name, raw);
		watchForSignals(name, result);
		applyWorkStatus(name, result);
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return toolErrorResult(message);
	}
}

function registerCatalogTool(pi: ExtensionAPI, def: CatalogEntry): void {
	pi.registerTool({
		name: def.name,
		label: def.label,
		description: def.description,
		promptSnippet: def.promptSnippet,
		parameters: jsonSchemaToTypebox(def.inputSchema),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeVerb(def.name, params as Record<string, unknown>, ctx);
		},
	});
}

function registerGateway(pi: ExtensionAPI): void {
	const rare = rareModelVerbs();
	if (rare.length === 0) return;
	pi.registerTool({
		name: GATEWAY_TOOL_NAME,
		label: "DevSpec: other verbs",
		description: GATEWAY_DESCRIPTION,
		promptSnippet: GATEWAY_DESCRIPTION,
		parameters: jsonSchemaToTypebox(gatewayInputSchema()),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = resolveGatewayVerb(String((params as { verb?: unknown }).verb ?? ""));
			if (!resolved.ok) return toolErrorResult(resolved.error);
			const args = (params as { args?: unknown }).args;
			const record =
				args && typeof args === "object" && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {};
			return executeVerb(resolved.verb, record, ctx);
		},
	});
}

/** Always-on tools the model sees. Not the full catalog. */
export function modelFacingCatalog(): CatalogEntry[] {
	return modelFacingSurface();
}

export default function (pi: ExtensionAPI) {
	for (const entry of modelFacingSurface()) {
		registerCatalogTool(pi, entry);
	}
	registerGateway(pi);
}
