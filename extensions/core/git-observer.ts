/**
 * Session-scoped Pi Git observation runtime (item 2c971806).
 *
 * The model Bash command is not parsed. A private PATH prefix routes ordinary `git`
 * argv through the package shim for that one tool execution. Connection/project
 * identity stays host-side in this frozen envelope and never reaches child processes.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const GLOBAL_KEY = "__devspecPiGitObserver";
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_ENVELOPES = 100;
const ENVELOPE_TTL_MS = 30 * 60 * 1000;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface FrozenGitObservationEnvelope {
	observationId: string;
	generation: string;
	piSessionId: string;
	toolCallId: string;
	connectionId: string;
	projectId: string;
	/** Host-only binding, never included in the shim environment or journal. */
	connectionCapability?: string;
	transport?: { tokenHash: string; endpoint: string };
	createdAt: number;
}

export interface ObservedGitCommit {
	envelope: FrozenGitObservationEnvelope;
	sha: string;
	branch: string | null;
	worktree: string;
	previousHead: string | null;
	amend: boolean;
	observedAt: string;
}

interface GitObserverGeneration {
	id: string;
	piSessionId: string;
	dir: string;
	shimPath: string;
	journalPath: string;
	realGit: string;
	journalOffset: number;
	envelopes: Map<string, FrozenGitObservationEnvelope>;
	processed: Set<string>;
	active: boolean;
}

interface GitObserverStore {
	current: GitObserverGeneration | null;
}

function store(): GitObserverStore {
	const g = globalThis as unknown as Record<string, GitObserverStore | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { current: null };
	return g[GLOBAL_KEY] as GitObserverStore;
}

function findRealGit(): string | null {
	try {
		const command = process.platform === "win32" ? "where" : "which";
		const candidates = execFileSync(command, process.platform === "win32" ? ["git.exe"] : ["-a", "git"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
			windowsHide: true,
		}).trim().split(/\r?\n/u);
		// Skip our own observer shims: with a stale shim dir on PATH, plain
		// `which git` returns the shim and delegation recurses without bound
		// (item 8729992e). The first non-shim candidate is the real Git.
		for (const candidate of candidates) {
			if (candidate && !basename(dirname(candidate)).startsWith("devspec-pi-git-") && existsSync(candidate)) return candidate;
		}
		return null;
	} catch {
		return null;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cleanupGeneration(generation: GitObserverGeneration | null): void {
	if (!generation) return;
	generation.active = false;
	generation.envelopes.clear();
	try { rmSync(generation.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function initializeGitObserver(piSessionId: string, preserveReload = false): boolean {
	const state = store();
	// The current shim is POSIX/Git-Bash shaped. Windows remains explicit fail-open
	// until path conversion/signal behavior has its own verified implementation.
	if ((process.platform as string) === "win32") {
		state.current = null;
		return false;
	}
	if (preserveReload && state.current?.active && state.current.piSessionId === piSessionId) return true;
	cleanupGeneration(state.current);
	const realGit = findRealGit();
	if (!realGit) {
		state.current = null;
		return false;
	}
	try {
		const dir = mkdtempSync(join(tmpdir(), "devspec-pi-git-"));
		chmodSync(dir, 0o700);
		const shimPath = join(dir, "git");
		const modulePath = join(dir, "git-observer-shim.mjs");
		const source = fileURLToPath(new URL("../../runtime/git-observer-shim.mjs", import.meta.url));
		copyFileSync(source, modulePath);
		chmodSync(modulePath, 0o600);
		// Use the exact host runtime, never /usr/bin/env node or the mutated PATH.
		writeFileSync(shimPath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(modulePath)} "$@"\n`, { mode: 0o700 });
		chmodSync(shimPath, 0o700);
		const journalPath = join(dir, "observations.jsonl");
		writeFileSync(journalPath, "", { mode: 0o600 });
		state.current = {
			id: randomUUID(),
			piSessionId,
			dir,
			shimPath,
			journalPath,
			realGit,
			journalOffset: 0,
			envelopes: new Map(),
			processed: new Set(),
			active: true,
		};
		return true;
	} catch {
		cleanupGeneration(state.current);
		state.current = null;
		return false;
	}
}

export function shutdownGitObserver(reason: "quit" | "reload" | "new" | "resume" | "fork"): void {
	if (reason === "reload") return;
	const state = store();
	cleanupGeneration(state.current);
	state.current = null;
}

/** Return a generic shell prefix; the original command is never inspected. */
export function prepareGitObservation(params: {
	toolCallId: string;
	piSessionId: string;
	connectionId: string;
	projectId: string;
	connectionCapability?: string;
	transport?: { tokenHash: string; endpoint: string };
}): { observationId: string; prefix: string } | null {
	const generation = store().current;
	if (!generation?.active || generation.piSessionId !== params.piSessionId) return null;
	if (!UUID.test(params.connectionId) || !UUID.test(params.projectId)) return null;

	const observationId = randomUUID();
	generation.envelopes.set(observationId, Object.freeze({
		observationId,
		generation: generation.id,
		piSessionId: params.piSessionId,
		toolCallId: params.toolCallId,
		connectionId: params.connectionId,
		projectId: params.projectId,
		...(params.connectionCapability ? { connectionCapability: params.connectionCapability } : {}),
		...(params.transport ? { transport: Object.freeze({ ...params.transport }) } : {}),
		createdAt: Date.now(),
	}));
	while (generation.envelopes.size > MAX_ENVELOPES) {
		const oldest = generation.envelopes.keys().next().value;
		if (!oldest) break;
		generation.envelopes.delete(oldest);
	}

	const assignments = [
		`export PATH=${shellQuote(generation.dir)}:"$PATH"`,
		`export DEVSPEC_PI_REAL_GIT=${shellQuote(generation.realGit)}`,
		`export DEVSPEC_PI_GIT_OBSERVER_DIR=${shellQuote(generation.dir)}`,
		`export DEVSPEC_PI_GIT_OBSERVER_JOURNAL=${shellQuote(generation.journalPath)}`,
		`export DEVSPEC_PI_GIT_OBSERVER_GENERATION=${shellQuote(generation.id)}`,
		`export DEVSPEC_PI_GIT_OBSERVATION_ID=${shellQuote(observationId)}`,
		`export DEVSPEC_PI_GIT_OBSERVER_SESSION=${shellQuote(params.piSessionId)}`,
	];
	return { observationId, prefix: `${assignments.join("; ")}\n` };
}

function validJournalRow(value: unknown): value is {
	v: 1;
	generation: string;
	observationId: string;
	sha: string;
	branch: string | null;
	worktree: string;
	previousHead: string | null;
	amend: boolean;
	observedAt: string;
} {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return row.v === 1 && typeof row.generation === "string" && UUID.test(String(row.observationId ?? "")) &&
		typeof row.sha === "string" && FULL_SHA.test(row.sha) &&
		(row.branch === null || (typeof row.branch === "string" && row.branch.length <= 255)) &&
		typeof row.worktree === "string" && row.worktree.length > 0 && row.worktree.length <= 4096 &&
		(row.previousHead === null || (typeof row.previousHead === "string" && FULL_SHA.test(row.previousHead))) &&
		typeof row.amend === "boolean" && typeof row.observedAt === "string";
}

export function drainGitObservations(now = Date.now()): ObservedGitCommit[] {
	const generation = store().current;
	if (!generation?.active) return [];
	for (const [id, envelope] of generation.envelopes) {
		if (now - envelope.createdAt > ENVELOPE_TTL_MS) generation.envelopes.delete(id);
	}
	try {
		const data = readFileSync(generation.journalPath);
		if (generation.journalOffset > data.byteLength) generation.journalOffset = 0;
		if (data.byteLength > MAX_JOURNAL_BYTES) {
			// Drop the oversized generation slice at a tool boundary and recover for
			// future observations instead of remaining permanently disabled.
			writeFileSync(generation.journalPath, "", { mode: 0o600 });
			generation.journalOffset = 0;
			return [];
		}
		const tail = data.subarray(generation.journalOffset).toString("utf8");
		const lastNewline = tail.lastIndexOf("\n");
		if (lastNewline < 0) return [];
		generation.journalOffset += Buffer.byteLength(tail.slice(0, lastNewline + 1));
		const observed: ObservedGitCommit[] = [];
		for (const line of tail.slice(0, lastNewline).split("\n")) {
			if (!line || line.length > 4096) continue;
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { continue; }
			if (!validJournalRow(parsed) || parsed.generation !== generation.id) continue;
			const processedKey = `${parsed.observationId}:${parsed.sha}:${parsed.worktree}`;
			if (generation.processed.has(processedKey)) continue;
			const envelope = generation.envelopes.get(parsed.observationId);
			if (!envelope || envelope.generation !== generation.id || envelope.piSessionId !== generation.piSessionId) continue;
			generation.processed.add(processedKey);
			while (generation.processed.size > 500) {
				const oldest = generation.processed.values().next().value;
				if (!oldest) break;
				generation.processed.delete(oldest);
			}
			observed.push({
				envelope,
				sha: parsed.sha,
				branch: parsed.branch,
				worktree: parsed.worktree,
				previousHead: parsed.previousHead,
				amend: parsed.amend,
				observedAt: parsed.observedAt,
			});
		}
		return observed;
	} catch {
		return [];
	}
}

export function resetGitObserverForTests(): void {
	const state = store();
	cleanupGeneration(state.current);
	state.current = null;
}
