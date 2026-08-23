#!/usr/bin/env node
/**
 * DevSpec-Pi private Git observer shim.
 *
 * This process is injected into PATH for one model-originated Bash call. It is
 * not installed as a Git hook and never changes repository or machine config.
 * It delegates Git byte-for-byte, then emits only a bounded local observation
 * when a successful direct `commit` can be proved from Trace2 + the actual repo.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:net";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const MAX_TRACE_BYTES = 1024 * 1024;
const TRACE_CLOSE_GRACE_MS = 250;

function env(name) {
	const value = process.env[name];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function run(realGit, args, options = {}) {
	return spawnSync(realGit, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
}

async function delegate(realGit, args, childEnv) {
	const child = spawn(realGit, args, {
		cwd: process.cwd(),
		env: childEnv,
		stdio: "inherit",
		windowsHide: true,
	});
	const forwarded = [];
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
		const handler = () => {
			try { child.kill(signal); } catch { /* best-effort forwarding */ }
		};
		process.on(signal, handler);
		forwarded.push([signal, handler]);
	}
	const result = await new Promise((resolve) => {
		child.once("error", (error) => resolve({ code: 126, signal: null, error }));
		child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal, error: null }));
	});
	for (const [signal, handler] of forwarded) process.off(signal, handler);
	return result;
}

async function startTraceCapture(observerDir) {
	const socketPath = join(observerDir, `trace-${randomUUID()}.sock`);
	const chunks = [];
	const sockets = new Set();
	let bytes = 0;
	let overflow = false;
	let resolveIdle = null;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes <= MAX_TRACE_BYTES) chunks.push(chunk);
			else overflow = true;
		});
		socket.on("close", () => {
			sockets.delete(socket);
			if (sockets.size === 0 && resolveIdle) {
				resolveIdle();
				resolveIdle = null;
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		target: `af_unix:stream:${socketPath}`,
		async finish() {
			if (sockets.size > 0) {
				await Promise.race([
					new Promise((resolve) => { resolveIdle = resolve; }),
					new Promise((resolve) => setTimeout(resolve, TRACE_CLOSE_GRACE_MS)),
				]);
			}
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(() => resolve()));
			try { rmSync(socketPath, { force: true }); } catch { /* best effort */ }
			return overflow ? null : Buffer.concat(chunks).toString("utf8");
		},
	};
}

function readTrace(raw) {
	if (!raw) return [];
	const rows = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const row = JSON.parse(line);
			if (row && typeof row === "object") rows.push(row);
		} catch {
			return [];
		}
	}
	return rows;
}

function parseGitGlobalArgs(args) {
	const globals = [];
	const takesValue = new Set(["-C", "-c", "--config-env", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path"]);
	const flags = new Set(["--no-pager", "-P", "--paginate", "-p", "--bare", "--no-replace-objects", "--literal-pathspecs", "--no-literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks"]);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (takesValue.has(arg)) {
			const value = args[i + 1];
			if (typeof value !== "string") return null;
			globals.push(arg, value);
			i += 1;
			continue;
		}
		if (arg.startsWith("-C") && arg.length > 2) {
			globals.push(arg);
			continue;
		}
		if (["--config-env=", "--git-dir=", "--work-tree=", "--namespace=", "--super-prefix=", "--exec-path="].some((prefix) => arg.startsWith(prefix))) {
			globals.push(arg);
			continue;
		}
		if (flags.has(arg)) {
			globals.push(arg);
			continue;
		}
		if (arg.startsWith("-")) return null;
		return { globals, command: arg };
	}
	return null;
}

function preflightRepository(realGit, args) {
	const parsed = parseGitGlobalArgs(args);
	if (!parsed) return null;
	const root = run(realGit, [...parsed.globals, "rev-parse", "--show-toplevel"]);
	if (root.status !== 0 || !root.stdout.trim()) return null;
	let worktree;
	try { worktree = realpathSync(root.stdout.trim()); } catch { return null; }
	const before = run(realGit, [...parsed.globals, "rev-parse", "--verify", "HEAD^{commit}"]);
	const previousHead = before.status === 0 && FULL_SHA.test(before.stdout.trim().toLowerCase())
		? before.stdout.trim().toLowerCase()
		: null;
	return { worktree, previousHead };
}

function directCommit(rows) {
	const rootSid = rows.find((row) => row.event === "start" && typeof row.sid === "string")?.sid;
	if (!rootSid) return null;
	const commit = rows.find((row) => {
		if (row.event !== "cmd_name" || row.name !== "commit" || typeof row.sid !== "string") return false;
		if (row.sid === rootSid && row.hierarchy === "commit") return true;
		// A Git alias expands in a child SID. Do not accept hook-launched commit/commit
		// hierarchies or any other descendant process as the causal command.
		return row.sid.startsWith(`${rootSid}/`) && typeof row.hierarchy === "string" &&
			row.hierarchy.includes("_run_git_alias_") && row.hierarchy.endsWith("/commit");
	});
	if (!commit) return null;
	const start = rows.find((row) => row.event === "start" && row.sid === commit.sid);
	const argv = Array.isArray(start?.argv) ? start.argv : [];
	if (argv.includes("--dry-run")) return null;
	const repo = rows.find((row) => row.event === "def_repo" && row.sid === commit.sid && (row.repo === 1 || row.repo == null));
	if (!repo || typeof repo.worktree !== "string" || !repo.worktree) return null;
	return { worktree: repo.worktree, amend: argv.includes("--amend") };
}

function inspectCommit(realGit, worktree, previousHead, amend, startedAt, endedAt) {
	const head = run(realGit, ["-C", worktree, "rev-parse", "--verify", "HEAD^{commit}"]);
	const sha = head.status === 0 ? head.stdout.trim().toLowerCase() : "";
	if (!FULL_SHA.test(sha) || sha === previousHead) return null;

	const postLine = run(realGit, ["-C", worktree, "rev-list", "--parents", "-n", "1", sha]);
	if (postLine.status !== 0) return null;
	const postParents = postLine.stdout.trim().split(/\s+/u).slice(1);
	if (previousHead === null) {
		if (amend || postParents.length !== 0) return null;
	} else if (amend) {
		const priorLine = run(realGit, ["-C", worktree, "rev-list", "--parents", "-n", "1", previousHead]);
		if (priorLine.status !== 0) return null;
		const priorParents = priorLine.stdout.trim().split(/\s+/u).slice(1);
		if (postParents.length !== priorParents.length || postParents.some((parent, index) => parent !== priorParents[index])) return null;
	} else if (postParents.length !== 1 || postParents[0] !== previousHead) {
		// Includes merge completion, concurrent/head-moving hooks, and unrelated refs.
		return null;
	}

	// A direct commit must be the current HEAD and the newest HEAD reflog entry.
	// This deliberately fails open when a hook moves HEAD after committing.
	const reflog = run(realGit, ["-C", worktree, "reflog", "show", "-2", "--format=%H%x09%gs%x09%ct", "HEAD"]);
	if (reflog.status !== 0) return null;
	const entries = reflog.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("\t"));
	const [reflogSha = "", action = "", reflogEpoch = ""] = entries[0] ?? [];
	const priorReflogSha = entries[1]?.[0]?.toLowerCase() ?? null;
	const expectedAction = previousHead === null ? /^commit \(initial\):/u : amend ? /^commit \(amend\):/u : /^commit:/u;
	if (reflogSha.toLowerCase() !== sha || !expectedAction.test(action)) return null;
	if (previousHead === null ? entries.length !== 1 : priorReflogSha !== previousHead) return null;

	const epochMs = Number.parseInt(reflogEpoch, 10) * 1000;
	if (!Number.isFinite(epochMs) || epochMs < startedAt - 2000 || epochMs > endedAt + 2000) return null;

	const committedAt = run(realGit, ["-C", worktree, "show", "-s", "--format=%ct", sha]);
	const committedAtMs = Number.parseInt(committedAt.stdout.trim(), 10) * 1000;
	if (committedAt.status !== 0 || !Number.isFinite(committedAtMs) || committedAtMs < startedAt - 2000 || committedAtMs > endedAt + 2000) return null;

	const branchResult = run(realGit, ["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = branchResult.status === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim().slice(0, 255) : null;
	return { sha, branch, previousHead, amend };
}

const realGit = env("DEVSPEC_PI_REAL_GIT");
const observerDir = env("DEVSPEC_PI_GIT_OBSERVER_DIR");
const journal = env("DEVSPEC_PI_GIT_OBSERVER_JOURNAL");
const generation = env("DEVSPEC_PI_GIT_OBSERVER_GENERATION");
const observationId = env("DEVSPEC_PI_GIT_OBSERVATION_ID");
const expectedSession = env("DEVSPEC_PI_GIT_OBSERVER_SESSION");
const actualSession = env("PI_SESSION_ID");
const args = process.argv.slice(2);

if (!realGit) process.exit(126);

const eligible = Boolean(
	observerDir && journal && generation && observationId && expectedSession && actualSession === expectedSession &&
	!process.env.GIT_TRACE2_EVENT && !process.env.GIT_TRACE2,
);

const preflight = eligible ? preflightRepository(realGit, args) : null;
let traceCapture = null;
let childEnv = process.env;
if (preflight) {
	try {
		mkdirSync(observerDir, { recursive: true, mode: 0o700 });
		traceCapture = await startTraceCapture(observerDir);
		childEnv = { ...process.env, GIT_TRACE2_EVENT: traceCapture.target };
	} catch {
		traceCapture = null;
	}
}

const startedAt = Date.now();
const result = await delegate(realGit, args, childEnv);
const endedAt = Date.now();
const trace = traceCapture ? await traceCapture.finish().catch(() => null) : null;

try {
	if (trace && result.code === 0 && !result.signal) {
		const found = directCommit(readTrace(trace));
		let actualWorktree = null;
		try { actualWorktree = found ? realpathSync(found.worktree) : null; } catch { actualWorktree = null; }
		const commit = found && actualWorktree === preflight?.worktree
			? inspectCommit(realGit, actualWorktree, preflight.previousHead, found.amend, startedAt, endedAt)
			: null;
		if (found && actualWorktree && commit) {
			const line = JSON.stringify({
				v: 1,
				generation,
				observationId,
				sha: commit.sha,
				branch: commit.branch,
				worktree: actualWorktree,
				previousHead: commit.previousHead,
				amend: commit.amend,
				observedAt: new Date(endedAt).toISOString(),
			});
			if (Buffer.byteLength(line) <= 4096) appendFileSync(journal, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		}
	}
} catch {
	// Observation never affects Git.
}

if (result.error) {
	console.error(result.error.message);
	process.exit(126);
}
if (result.signal) {
	try { process.kill(process.pid, result.signal); } catch { process.exit(1); }
}
process.exit(result.code);
