#!/usr/bin/env node
/**
 * DevSpec-Pi private Git observer shim.
 *
 * This process is injected into PATH for one model-originated Bash call. It is
 * not installed as a Git hook and never changes repository or machine config.
 * It delegates Git byte-for-byte, then emits only a bounded local observation
 * when a successful direct `commit` can be proved from Trace2 + the actual repo.
 *
 * The one exception (DevSpec item df71ab6c, owner-approved): when the host armed
 * stamping for this call, a plain `git commit` in the claimed task's project gets
 * the task's `[devspec:<uuid>]` appended to its subject, by the rules in
 * commit-stamp.mjs. Every other invocation, and every commit those rules do not
 * cover, is delegated exactly as before.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { planCommitStamp, readStampScope, repositoryInProject, unplannedReport } from "./commit-stamp.mjs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
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

async function delegate(realGit, args, childEnv, stdin = null) {
	const child = spawn(realGit, args, {
		cwd: process.cwd(),
		env: childEnv,
		stdio: stdin ? ["pipe", "inherit", "inherit"] : "inherit",
		windowsHide: true,
	});
	if (stdin) {
		// The message git would have read from stdin: tagged, or the exact bytes.
		child.stdin.on("error", () => { /* git exited without reading */ });
		child.stdin.write(stdin.bytes);
		if (stdin.rest) process.stdin.pipe(child.stdin);
		else child.stdin.end();
	}
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

/**
 * Git for Windows has no Unix domain sockets, so there Trace2 writes one file per
 * git process into a private directory instead (c4b14794). The events are the same.
 */
function startDirectoryTraceCapture(observerDir) {
	const dir = join(observerDir, `trace-${randomUUID()}`);
	mkdirSync(dir, { mode: 0o700 });
	return {
		target: dir,
		async finish() {
			try {
				let bytes = 0;
				const parts = [];
				for (const name of readdirSync(dir).sort()) {
					const part = readFileSync(join(dir, name), "utf8");
					bytes += Buffer.byteLength(part);
					if (bytes > MAX_TRACE_BYTES) return null;
					parts.push(part.endsWith("\n") ? part : `${part}\n`);
				}
				return parts.join("");
			} catch {
				return null;
			} finally {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
			}
		},
	};
}

async function startTraceCapture(observerDir) {
	if (process.platform === "win32") return startDirectoryTraceCapture(observerDir);
	const socketPath = join(observerDir, `trace-${randomUUID()}.sock`);
	// Git connects only to a socket path that fits sun_path with its NUL; a longer
	// one (a deep temp directory) can bind in node yet receive nothing from git.
	if (Buffer.byteLength(socketPath) > 100) return startDirectoryTraceCapture(observerDir);
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
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch {
		// A socket path past the platform limit (a deep temp directory, or one
		// with spaces) cannot be bound: the same events go to files instead.
		try { server.close(); } catch { /* never listening */ }
		return startDirectoryTraceCapture(observerDir);
	}
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
		return { globals, command: arg, index: i };
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
	return { worktree, previousHead, globals: parsed.globals, command: parsed.command, commandIndex: parsed.index };
}

function directCommit(rows) {
	// The outermost process: first on a socket stream, and the shortest SID when
	// Trace2 wrote one file per process (Windows), whatever order they are read in.
	const rootSid = rows
		.filter((row) => row.event === "start" && typeof row.sid === "string")
		.reduce((best, row) => (!best || row.sid.split("/").length < best.split("/").length ? row.sid : best), null);
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

// Never delegate into another observer shim. If a stale generation's dir
// reaches PATH, findRealGit can hand us a shim as "the real git"; every hop
// then re-runs preflight through the next shim, which inherits this env and
// self-spawns without bound (measured: >1,100 processes, 12G swap, machine
// lockup — item 8729992e). Refusing the call fails one git command instead.
try {
	if (basename(dirname(realpathSync(realGit))).startsWith("devspec-pi-git-")) process.exit(126);
} catch {
	process.exit(126);
}

const eligible = Boolean(
	observerDir && journal && generation && observationId && expectedSession && actualSession === expectedSession &&
	!process.env.GIT_TRACE2_EVENT && !process.env.GIT_TRACE2,
);

const preflight = eligible ? preflightRepository(realGit, args) : null;
const stampScope = eligible ? readStampScope(process.env) : null;
const gitRun = (gitArgs) => run(realGit, gitArgs);
let stampPlan = null;
if (preflight && stampScope && preflight.command === "commit") {
	try {
		mkdirSync(observerDir, { recursive: true, mode: 0o700 });
		stampPlan = planCommitStamp({
			args, commandIndex: preflight.commandIndex, globals: preflight.globals, cwd: process.cwd(),
			worktree: preflight.worktree, scope: stampScope, run: gitRun, privateDir: observerDir,
		});
	} catch {
		stampPlan = null; // stamping never stops git; the commit runs untouched
	}
}
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
const result = await delegate(realGit, stampPlan?.args ?? args, childEnv,
	stampPlan?.stdin ? { bytes: stampPlan.stdin, rest: stampPlan.stdinRest === true } : null);
const endedAt = Date.now();
if (stampPlan?.privateFile) {
	try { rmSync(stampPlan.privateFile, { force: true }); } catch { /* best effort */ }
}
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
			let stamp;
			if (stampScope) {
				try {
					stamp = stampPlan?.report ?? unplannedReport(stampScope, repositoryInProject(gitRun, actualWorktree, null, stampScope));
				} catch { stamp = undefined; }
			}
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
				...(stamp ? { stamp } : {}),
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
