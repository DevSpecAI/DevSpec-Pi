/**
 * DevSpec Pi — native tools over the MCP verb surface (item 523f1512).
 *
 * Every model-facing DevSpec verb is a native pi tool, generated from the
 * server's own tool-definitions (extensions/generated/mcp-catalog.ts). The
 * MCP surface remains the interop contract; this file is a projection of it,
 * not a handwritten mirror.
 *
 * Pump/lifecycle verbs stay extension-internal (the remote pump already
 * calls them). post_session_message is never registered — conversational
 * delivery is mechanical (item cc9e8c43).
 *
 * Headless: tools work in every mode — errors come back as text the model can
 * act on (e.g. "run /devspec.login"), never as UI-only state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { connectionsUrl, TOKEN_ENV_VAR } from "./core/config.ts";
import { callDevspec } from "./core/client.ts";
import { repoResolver, validateCommitSha } from "./core/commit-ledger.ts";
import { addFlags, extractFlags } from "./core/conflict-watch.ts";
import { jsonSchemaToTypebox } from "./core/json-schema.ts";
import { toolErrorResult, toolTextResult, unwrapMcpResult } from "./core/result.ts";
import { MCP_CATALOG, type CatalogEntry } from "./generated/mcp-catalog.ts";

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

const NOT_CONNECTED =
	`Not connected to DevSpec. Run /devspec.login, or set ${TOKEN_ENV_VAR}. ` +
	`Tokens are minted at ${connectionsUrl()}.`;

type Augment = (
	params: Record<string, unknown>,
	ctx: { sessionManager: { getSessionId(): string }; cwd: string },
) => Record<string, unknown>;

/** Per-verb argument stamps that cannot live in the generated catalog. */
const AUGMENTS: Record<string, Augment> = {
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

function registerCatalogTool(pi: ExtensionAPI, def: CatalogEntry): void {
	const augment = AUGMENTS[def.name];
	pi.registerTool({
		name: def.name,
		label: def.label,
		description: def.description,
		promptSnippet: def.promptSnippet,
		parameters: jsonSchemaToTypebox(def.inputSchema),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = await resolveToken();
			if (!resolved) return toolErrorResult(NOT_CONNECTED);
			try {
				const args = augment
					? augment(params as Record<string, unknown>, ctx)
					: (params as Record<string, unknown>);
				const raw = await callDevspec(resolved.token, def.name, args, { cwd: ctx.cwd });
				const result = unwrapOrThrow(def.name, raw);
				watchForSignals(def.name, result);
				return result;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return toolErrorResult(message);
			}
		},
	});
}

export function modelFacingCatalog(): CatalogEntry[] {
	return MCP_CATALOG.filter((e) => e.kind === "model");
}

export default function (pi: ExtensionAPI) {
	for (const entry of modelFacingCatalog()) {
		registerCatalogTool(pi, entry);
	}
}
