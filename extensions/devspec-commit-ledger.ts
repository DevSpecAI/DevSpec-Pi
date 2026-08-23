/**
 * DevSpec Pi — mechanical commit ledger + host-observed provenance.
 *
 * Direct commits are observed by the private session Git shim (item 2c971806).
 * The older command/output recognizer remains as a conservative fallback. Neither
 * path blocks Git, rewrites messages, parses Bash policy, or grants authority.
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { getBond } from "./core/bond-state.ts";
import {
	DevspecAuthError,
	DevspecRateLimitError,
	callDevspec,
	isRecoverableTransportError,
} from "./core/client.ts";
import {
	annotateCommitMessage,
	captureGitCommit,
	recordObservedCommit,
	repoCommitMessage,
	repoResolver,
	type LedgerCommit,
} from "./core/commit-ledger.ts";
import { debugRemote } from "./core/debug.ts";
import {
	drainGitObservations,
	initializeGitObserver,
	prepareGitObservation,
	shutdownGitObserver,
	type FrozenGitObservationEnvelope,
	type ObservedGitCommit,
} from "./core/git-observer.ts";
import { resolveGitRemote, resolveProjectPin, sanitizeGitRemoteForTransport } from "./core/project-scope.ts";

function commandOf(args: unknown): string {
	const a = args as { command?: unknown } | null;
	return typeof a?.command === "string" ? a.command : "";
}

function outputOf(result: unknown): string {
	const r = result as { content?: Array<{ type?: string; text?: string }> } | null;
	if (!r || !Array.isArray(r.content)) return "";
	return r.content
		.filter((p) => p && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n");
}

const FULL_SHA = /^[0-9a-f]{40}$/u;
const FULL_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REPORT_QUEUE_KEY = "__devspecPiCommitReportQueue";
const MAX_REPORTS = 100;
const REPORT_TTL_MS = 24 * 60 * 60 * 1000;

export interface FrozenCommitAttribution {
	connectionId: string;
	projectId: string;
	/** Hidden transport capability frozen host-side; never exported to the shim. */
	connectionCapability?: string;
	observationId?: string;
}

interface ReporterDeps {
	resolveToken(): Promise<{ token: string } | null>;
	resolveGitRemote(cwd: string): Promise<string | null>;
	resolveProjectPin(cwd: string): Promise<string | null>;
	call(
		token: string,
		name: string,
		args: Record<string, unknown>,
		options?: { lane?: "work" | "pump"; timeoutMs?: number; cwd?: string; connectionCapability?: string },
	): Promise<unknown>;
}

const reporterDeps: ReporterDeps = {
	resolveToken,
	resolveGitRemote,
	resolveProjectPin,
	call: callDevspec,
};

export type CommitReportOutcome = "sent" | "permanent_rejection" | "transient_failure";

/** Report one mechanically proved commit using identity frozen before execution. */
export async function reportCapturedCommit(
	commit: LedgerCommit,
	cwd: string,
	attribution: FrozenCommitAttribution,
	deps: ReporterDeps = reporterDeps,
): Promise<CommitReportOutcome> {
	if (!FULL_SHA.test(commit.sha) || !FULL_PROJECT_ID.test(attribution.connectionId) || !FULL_PROJECT_ID.test(attribution.projectId)) {
		return "permanent_rejection";
	}
	const resolved = await deps.resolveToken().catch(() => null);
	if (!resolved?.token) return "transient_failure";

	try {
		const [rawPin, rawRemote] = await Promise.all([
			deps.resolveProjectPin(cwd).catch(() => null),
			deps.resolveGitRemote(cwd).catch(() => null),
		]);
		const remote = sanitizeGitRemoteForTransport(rawRemote);
		if (rawRemote && !remote) return "permanent_rejection";
		const pin = typeof rawPin === "string" && rawPin === attribution.projectId ? rawPin : null;
		if (!remote && !pin) return "permanent_rejection";

		await deps.call(
			resolved.token,
			"report_commit_provenance",
			{
				connection_id: attribution.connectionId,
				commit_sha: commit.sha,
				branch: commit.branch,
				...(attribution.observationId ? { observation_id: attribution.observationId } : {}),
				...(remote ? { git_remote: remote } : {}),
				...(!remote && pin ? { pinned_project_id: pin } : {}),
			},
			{
				lane: "work",
				timeoutMs: 10_000,
				...(attribution.connectionCapability ? { connectionCapability: attribution.connectionCapability } : {}),
			},
		);
		return "sent";
	} catch (error) {
		if (error instanceof DevspecRateLimitError || error instanceof DevspecAuthError || isRecoverableTransportError(error)) {
			return "transient_failure";
		}
		return "permanent_rejection";
	}
}

interface QueuedReport {
	key: string;
	commit: LedgerCommit;
	cwd: string;
	attribution: FrozenCommitAttribution;
	createdAt: number;
	attempts: number;
	nextAttemptAt: number;
}

interface ReportQueueStore {
	items: QueuedReport[];
	flushing: Promise<void> | null;
	retryTimer: ReturnType<typeof setTimeout> | null;
}

function reportQueue(): ReportQueueStore {
	const g = globalThis as unknown as Record<string, ReportQueueStore | undefined>;
	if (!g[REPORT_QUEUE_KEY]) g[REPORT_QUEUE_KEY] = { items: [], flushing: null, retryTimer: null };
	return g[REPORT_QUEUE_KEY] as ReportQueueStore;
}

export function enqueueCommitReport(commit: LedgerCommit, cwd: string, attribution: FrozenCommitAttribution): void {
	const queue = reportQueue();
	const key = `${attribution.connectionId}:${commit.sha}`;
	if (queue.items.some((item) => item.key === key)) return;
	const now = Date.now();
	queue.items.push({ key, commit: { ...commit }, cwd, attribution: { ...attribution }, createdAt: now, attempts: 0, nextAttemptAt: now });
	if (queue.items.length > MAX_REPORTS) queue.items.splice(0, queue.items.length - MAX_REPORTS);
}

function scheduleCommitReportRetry(at: number): void {
	const queue = reportQueue();
	if (queue.retryTimer) clearTimeout(queue.retryTimer);
	const delay = Math.max(0, at - Date.now());
	queue.retryTimer = setTimeout(() => {
		queue.retryTimer = null;
		void flushCommitReports();
	}, delay);
	queue.retryTimer.unref?.();
}

export function cancelCommitReportRetryTimer(): void {
	const queue = reportQueue();
	if (queue.retryTimer) clearTimeout(queue.retryTimer);
	queue.retryTimer = null;
}

export function resetCommitReportQueueForTests(): void {
	const queue = reportQueue();
	cancelCommitReportRetryTimer();
	queue.items = [];
	queue.flushing = null;
}

export function flushCommitReports(now = Date.now(), deps: ReporterDeps = reporterDeps): Promise<void> {
	const queue = reportQueue();
	if (queue.flushing) return queue.flushing;
	queue.flushing = (async () => {
		queue.items = queue.items.filter((item) => now - item.createdAt <= REPORT_TTL_MS && item.attempts < 5);
		for (const item of [...queue.items]) {
			if (item.nextAttemptAt > now) {
				scheduleCommitReportRetry(item.nextAttemptAt);
				break;
			}
			item.attempts += 1;
			const outcome = await reportCapturedCommit(item.commit, item.cwd, item.attribution, deps);
			if (outcome === "sent" || outcome === "permanent_rejection") {
				queue.items = queue.items.filter((candidate) => candidate.key !== item.key);
				continue;
			}
			// One reload-safe scheduled retry; lifecycle bursts cannot consume attempts.
			const backoff = Math.min(30_000, 1000 * (2 ** Math.max(0, item.attempts - 1)));
			item.nextAttemptAt = Date.now() + backoff + Math.floor(Math.random() * 250);
			scheduleCommitReportRetry(item.nextAttemptAt);
			break;
		}
	})().finally(() => { queue.flushing = null; });
	return queue.flushing;
}

function gitOutput(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		}).trim();
	} catch {
		return null;
	}
}

/** Independently corroborate child journal data from immutable Git state. */
export function corroborateObservedCommit(observed: ObservedGitCommit, now = Date.now()): boolean {
	const head = gitOutput(observed.worktree, ["rev-parse", "--verify", "HEAD^{commit}"])?.toLowerCase();
	if (head !== observed.sha || observed.sha === observed.previousHead) return false;
	const postLine = gitOutput(observed.worktree, ["rev-list", "--parents", "-n", "1", observed.sha]);
	if (!postLine) return false;
	const postParents = postLine.split(/\s+/u).slice(1);
	if (observed.previousHead === null) {
		if (observed.amend || postParents.length !== 0) return false;
	} else if (observed.amend) {
		const priorLine = gitOutput(observed.worktree, ["rev-list", "--parents", "-n", "1", observed.previousHead]);
		if (!priorLine) return false;
		const priorParents = priorLine.split(/\s+/u).slice(1);
		if (postParents.length !== priorParents.length || postParents.some((parent, index) => parent !== priorParents[index])) return false;
	} else if (postParents.length !== 1 || postParents[0] !== observed.previousHead) {
		return false;
	}
	const reflog = gitOutput(observed.worktree, ["reflog", "show", "-2", "--format=%H%x09%gs%x09%ct", "HEAD"]);
	if (!reflog) return false;
	const entries = reflog.split("\n").filter(Boolean).map((line) => line.split("\t"));
	const [reflogSha = "", action = "", reflogEpoch = ""] = entries[0] ?? [];
	const priorReflogSha = entries[1]?.[0]?.toLowerCase() ?? null;
	const expectedAction = observed.previousHead === null ? /^commit \(initial\):/u : observed.amend ? /^commit \(amend\):/u : /^commit:/u;
	if (reflogSha.toLowerCase() !== observed.sha || !expectedAction.test(action)) return false;
	if (observed.previousHead === null ? entries.length !== 1 : priorReflogSha !== observed.previousHead) return false;
	const reflogMs = Number.parseInt(reflogEpoch, 10) * 1000;
	const committedMs = Number.parseInt(gitOutput(observed.worktree, ["show", "-s", "--format=%ct", observed.sha]) ?? "", 10) * 1000;
	const earliest = observed.envelope.createdAt - 2000;
	return Number.isFinite(reflogMs) && Number.isFinite(committedMs) &&
		reflogMs >= earliest && reflogMs <= now + 2000 && committedMs >= earliest && committedMs <= now + 2000;
}

function ledgerAndQueue(observed: ObservedGitCommit): void {
	if (!corroborateObservedCommit(observed)) return;
	const message = repoCommitMessage(observed.worktree, observed.sha);
	const commit: LedgerCommit = {
		sha: observed.sha,
		shortSha: observed.sha.slice(0, 7),
		branch: observed.branch ?? "HEAD",
		at: Date.parse(observed.observedAt) || Date.now(),
		...(message !== null ? { commitMessage: message } : {}),
	};
	recordObservedCommit(commit);
	enqueueCommitReport(commit, observed.worktree, {
		connectionId: observed.envelope.connectionId,
		projectId: observed.envelope.projectId,
		observationId: observed.envelope.observationId,
	});
	debugRemote("commit ledger captured");
}

export default function (pi: ExtensionAPI) {
	const pending = new Map<string, {
		command: string;
		cwd: string;
		attribution: FrozenCommitAttribution | null;
		piSessionId: string;
	}>();
	const injectedOriginal = new Map<string, string>();

	pi.on("session_start", (event, ctx) => {
		initializeGitObserver(ctx.sessionManager.getSessionId(), event.reason === "reload");
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName !== "bash") return;
		const bond = getBond();
		pending.set(event.toolCallId, {
			command: commandOf(event.args),
			cwd: ctx.cwd,
			attribution: bond?.projectId ? {
				connectionId: bond.connectionId,
				projectId: bond.projectId,
				...(bond.connectionCapability ? { connectionCapability: bond.connectionCapability } : {}),
			} : null,
			piSessionId: ctx.sessionManager.getSessionId(),
		});
		while (pending.size > 50) {
			const oldest = pending.keys().next().value;
			if (!oldest) break;
			pending.delete(oldest);
		}
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const start = pending.get(event.toolCallId);
		if (!start?.attribution || typeof event.input.command !== "string") return;
		const prepared = prepareGitObservation({
			toolCallId: event.toolCallId,
			piSessionId: start.piSessionId,
			connectionId: start.attribution.connectionId,
			projectId: start.attribution.projectId,
		});
		if (!prepared) return;
		injectedOriginal.set(event.toolCallId, event.input.command);
		event.input.command = `${prepared.prefix}${event.input.command}`;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const original = injectedOriginal.get(event.toolCallId);
		if (original) {
			// Keep extension/tool-result observers on the model-authored command shape.
			event.input.command = original;
			injectedOriginal.delete(event.toolCallId);
		}
		for (const observed of drainGitObservations()) ledgerAndQueue(observed);
		void flushCommitReports();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const start = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		if (!start || event.isError) return;
		// Conservative fallback for existing readable summary output.
		const captured = captureGitCommit(start.command, outputOf(event.result), repoResolver(ctx.cwd));
		if (!captured) return;
		const message = repoCommitMessage(ctx.cwd, captured.sha);
		if (message !== null) annotateCommitMessage(captured.sha, message);
		// Legacy output parsing is ledger convenience only. It is not causal proof
		// and must never emit plugin_observed provenance.
		debugRemote("commit ledger captured");
	});

	pi.on("agent_settled", () => {
		for (const observed of drainGitObservations()) ledgerAndQueue(observed);
		void flushCommitReports();
	});

	pi.on("session_shutdown", async (event) => {
		for (const observed of drainGitObservations()) ledgerAndQueue(observed);
		await Promise.race([
			flushCommitReports(),
			new Promise<void>((resolve) => setTimeout(resolve, 1500)),
		]);
		if (event.reason !== "reload") cancelCommitReportRetryTimer();
		shutdownGitObserver(event.reason);
	});
}
