/**
 * Capability-honest provenance assistance for Pi.
 *
 * Pi exposes reliable first-class file edit calls, so an explicitly associated
 * project may receive one advisory nudge. This extension never parses shell
 * text, blocks tools, or claims push enforcement. Commit tags are added by Pi's
 * git stand-in when exactly one task is claimed (item df71ab6c), never here.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveEndpoint, resolveToken } from "./core/auth-store.ts";
import { callDevspecAdvisoryOnce } from "./core/client.ts";
import { resolveGitRemote, resolveProjectPin, resolveProjectPinFile, writeProjectPin } from "./core/project-scope.ts";
import { getProjectChoice } from "./core/project-choice.ts";
import { unwrapMcpResult } from "./core/result.ts";
import { hasObservedClaim, markProjectNudged, unmarkProjectNudged } from "./core/work-state.ts";
import { commitTaggingAvailable } from "./core/commit-stamp.ts";

const RELIABLE_EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "notebook"]);
const FULL_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JURISDICTION_CACHE_KEY = "__devspecPiNudgeJurisdiction";
const JURISDICTION_PENDING_KEY = "__devspecPiNudgeJurisdictionPending";
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 50;

export interface ProvenanceRuntime {
	cwd: string;
	sessionManager: { getSessionId(): string };
}

export interface ProvenanceNudge {
	customType: "devspec-provenance-nudge";
	content: string;
	display: true;
	details: { projectId: string };
}

interface JurisdictionDeps {
	resolveToken(): Promise<{ token: string } | null>;
	resolveEndpoint(): Promise<string>;
	resolveGitRemote(cwd: string): Promise<string | null>;
	resolveProjectPin(cwd: string): Promise<string | null>;
	call(token: string, name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface JurisdictionCacheEntry {
	projectId: string | null;
	expiresAt: number;
}

function jurisdictionCache(): Map<string, JurisdictionCacheEntry> {
	const g = globalThis as unknown as Record<string, Map<string, JurisdictionCacheEntry> | undefined>;
	if (!(g[JURISDICTION_CACHE_KEY] instanceof Map)) g[JURISDICTION_CACHE_KEY] = new Map();
	return g[JURISDICTION_CACHE_KEY] as Map<string, JurisdictionCacheEntry>;
}

function jurisdictionPending(): Map<string, Promise<string | null>> {
	const g = globalThis as unknown as Record<string, Map<string, Promise<string | null>> | undefined>;
	if (!(g[JURISDICTION_PENDING_KEY] instanceof Map)) g[JURISDICTION_PENDING_KEY] = new Map();
	return g[JURISDICTION_PENDING_KEY] as Map<string, Promise<string | null>>;
}

const jurisdictionDeps: JurisdictionDeps = {
	resolveToken,
	resolveEndpoint,
	resolveGitRemote,
	resolveProjectPin,
	call: (token, name, args) => callDevspecAdvisoryOnce(token, name, args, 1500),
};

function tokenFingerprint(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function remoteMatch(raw: unknown): { resolved: string | null; candidates: string[] } | null {
	const result = unwrapMcpResult(raw);
	if (result.isError || !result.details || typeof result.details !== "object") return null;
	const match = (result.details as { remote_match?: unknown }).remote_match;
	if (!match || typeof match !== "object") return null;
	const row = match as { resolved_project_id?: unknown; candidate_project_ids?: unknown };
	const resolved = typeof row.resolved_project_id === "string" ? row.resolved_project_id : null;
	const candidates = Array.isArray(row.candidate_project_ids)
		? row.candidate_project_ids.filter((id): id is string => typeof id === "string")
		: [];
	return { resolved, candidates };
}

/** Resolve positive project jurisdiction without writing the folder or guessing. */
export async function resolveNudgeProject(
	cwd: string,
	deps: JurisdictionDeps = jurisdictionDeps,
	now = Date.now(),
): Promise<string | null> {
	const [pin, remote] = await Promise.all([
		deps.resolveProjectPin(cwd).catch(() => null),
		deps.resolveGitRemote(cwd).catch(() => null),
	]);
	const validPin = typeof pin === "string" && FULL_PROJECT_ID.test(pin) ? pin : null;
	if (!remote) return validPin;

	const [auth, endpoint] = await Promise.all([
		deps.resolveToken().catch(() => null),
		deps.resolveEndpoint().catch(() => ""),
	]);
	if (!auth?.token || !endpoint) return null;
	const key = `${endpoint}\0${tokenFingerprint(auth.token)}\0${remote}\0${validPin ?? ""}`;
	const cache = jurisdictionCache();
	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) return hit.projectId;

	const pending = jurisdictionPending();
	const existing = pending.get(key);
	if (existing) return existing;
	if (pending.size >= MAX_CACHE_ENTRIES) return null;

	const lookup = (async (): Promise<string | null> => {
		let projectId: string | null = null;
		try {
			const raw = await deps.call(auth.token, "list_projects", { git_remote: remote });
			const match = remoteMatch(raw);
			if (match?.resolved && FULL_PROJECT_ID.test(match.resolved)) {
				projectId = match.resolved;
			} else if (validPin && match?.candidates.includes(validPin)) {
				projectId = validPin;
			} else if (validPin && match && match.candidates.length === 0) {
				projectId = validPin;
			}
		} catch {
			projectId = null;
		}
		cache.set(key, { projectId, expiresAt: now + (projectId ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
		while (cache.size > MAX_CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (!oldest) break;
			cache.delete(oldest);
		}
		return projectId;
	})().finally(() => pending.delete(key));
	pending.set(key, lookup);
	return lookup;
}

export function resetNudgeJurisdictionCacheForTests(): void {
	jurisdictionCache().clear();
	jurisdictionPending().clear();
}

export async function unclaimedEditNudge(
	toolName: string,
	runtime: ProvenanceRuntime,
	projectResolver: (cwd: string) => Promise<string | null> = resolveNudgeProject,
	commitTagging: () => boolean = commitTaggingAvailable,
): Promise<ProvenanceNudge | null> {
	if (!RELIABLE_EDIT_TOOLS.has(toolName)) return null;
	const sessionId = runtime.sessionManager.getSessionId();

	// Positive jurisdiction is either an explicit pin or a server-verified remote.
	// Every auth/network/ambiguous/malformed state is a plain non-blocking null.
	const projectId = getProjectChoice(sessionId)?.project.id ?? await projectResolver(runtime.cwd);
	if (!projectId || !FULL_PROJECT_ID.test(projectId) || hasObservedClaim(sessionId, projectId) || !markProjectNudged(sessionId, projectId)) return null;
	return {
		customType: "devspec-provenance-nudge",
		content:
			`DevSpec provenance note: this conversation is working with project ${projectId}, ` +
			"but this Pi session has not observed an active claim. Continue this edit—editing is never blocked. " +
			"Before committing, use search_tasks to find and claim the covering item. If none exists, " +
			"create the smallest task that does, with a substantive description and the reason for the work (create_task " +
			"requires both), as the implementation contract's work_entry_contract decides, and claim it. " +
			(commitTagging()
				? "Once one task is claimed, Pi adds its [devspec:<full-uuid>] tag to your commits itself; write the tag yourself only when Pi says it did not."
				: "Pi cannot add task tags to commits in this setup, so put the claimed task's [devspec:<full-uuid>] in every commit message yourself."),
		display: true,
		details: { projectId },
	};
}

export default function (pi: ExtensionAPI): void {
	let active = true;
	pi.on("session_shutdown", () => { active = false; });
	// Work observations live on globalThis and are keyed by Pi session id, so a
	// /reload cannot re-arm a successfully delivered nudge or forget a claim.
	pi.on("tool_call", (event, ctx) => {
		// Pi fail-safes any synchronous throw by blocking the tool. Session capture,
		// detached launch, network lookup and delivery therefore all live inside
		// explicit fail-open handling, and this handler always returns undefined.
		try {
			const originatingSessionId = ctx.sessionManager.getSessionId();
			void (async () => {
				let nudge: ProvenanceNudge | null = null;
				try {
					nudge = await unclaimedEditNudge(event.toolName, ctx);
					if (!nudge) return;
					if (!active || ctx.sessionManager.getSessionId() !== originatingSessionId) {
						unmarkProjectNudged(originatingSessionId, nudge.details.projectId);
						return;
					}
					pi.sendMessage(nudge, { deliverAs: "steer", triggerTurn: false });
				} catch {
					if (nudge) unmarkProjectNudged(originatingSessionId, nudge.details.projectId);
				}
			})();
		} catch { /* advisory-only */ }
		return undefined;
	});

	pi.registerCommand("devspec.pin", {
		description: "Explicitly associate this repository/folder with a DevSpec project id.",
		handler: async (args, ctx) => {
			const projectId = args.trim();
			if (!FULL_PROJECT_ID.test(projectId)) {
				ctx.ui.notify("Usage: /devspec.pin <full-project-uuid>", "warning");
				return;
			}
			try {
				const existing = await resolveProjectPinFile(ctx.cwd);
				if (existing && existing.projectId !== projectId) {
					if (ctx.mode !== "tui" || !await ctx.ui.confirm("Replace folder default?", `${existing.projectId} at ${existing.path}\nNew project: ${projectId}\nThis may affect other users of the folder, but not existing conversations.`)) return;
					if (JSON.stringify(await resolveProjectPinFile(ctx.cwd)) !== JSON.stringify(existing)) {
						ctx.ui.notify("The folder default changed. Review it again before replacing it.", "warning"); return;
					}
				}
				const result = await writeProjectPin(ctx.cwd, projectId);
				const replacement = result.replaced ? ` (replaced ${result.replaced})` : "";
				ctx.ui.notify(`DevSpec project association written to ${result.path}${replacement}.`, "info");
			} catch (error) {
				// Project association assists local scoping; failure never blocks work.
				ctx.ui.notify(`DevSpec could not write the project association: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		},
	});
}
