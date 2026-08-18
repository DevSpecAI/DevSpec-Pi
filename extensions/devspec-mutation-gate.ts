/**
 * Mechanical claim-before-mutation gate. Authority is scoped to the current Pi
 * session and canonical repository; UI state and model text are never inputs.
 *
 * This is a host gate, not an OS sandbox. It contains direct file tools and
 * rejects obvious bash scope escapes, but an already-authorized arbitrary
 * process can still mutate outside the repository through opaque program logic.
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import {
	claimAuthorityScope,
	clearClaimAuthorities,
	hasClaimAuthority,
	type ClaimAuthorityScope,
} from "./core/claim-authority.ts";
import { TOOL_LOADER_NAME, isCallableModelVerb } from "./core/model-surface.ts";

const BLOCK_REASON =
	"DevSpec mutation gate: this tool requires a successful claim_work_item result for the current Pi session and repository.";
const SCOPE_REASON =
	"DevSpec mutation gate: the requested target or shell scope is outside the claimed canonical repository.";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_MUTATORS = new Set(["write", "edit", "notebook"]);
const SHELL_MUTATORS = new Set(["bash", "shell"]);

type RuntimeContext = {
	cwd: string;
	sessionManager: { getSessionId(): string };
};

function isNativeDevspecVerb(toolName: string): boolean {
	return toolName === TOOL_LOADER_NAME || isCallableModelVerb(toolName);
}

/** Closed-state bootstrap intentionally supports no config-reading helper. */
export function isReadOnlyShellCommand(command: unknown): boolean {
	return typeof command === "string" && command === "pwd";
}

function isContained(repoRoot: string, candidate: string): boolean {
	const rel = relative(repoRoot, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Canonicalize the nearest existing ancestor so symlinked parents cannot escape. */
export function targetIsInsideRepo(target: unknown, cwd: string, repoRoot: string): boolean {
	if (
		typeof target !== "string" || !target || target !== target.trim() ||
		target === "~" || target.startsWith("~/") || target.includes("$") || target.includes("`")
	) return false;
	try {
		const canonicalCwd = realpathSync(cwd);
		const candidate = isAbsolute(target) ? resolve(target) : resolve(canonicalCwd, target);
		let ancestor = candidate;
		while (!existsSync(ancestor)) {
			const parent = dirname(ancestor);
			if (parent === ancestor) return false;
			ancestor = parent;
		}
		const canonicalAncestor = realpathSync(ancestor);
		const canonicalCandidate = resolve(canonicalAncestor, relative(ancestor, candidate));
		return isContained(repoRoot, canonicalCandidate);
	} catch {
		return false;
	}
}

function shellTokens(command: string): string[] | null {
	if (!command || /[\0\r]/u.test(command)) return null;
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	const flush = () => {
		if (token) tokens.push(token);
		token = "";
	};
	for (const char of command) {
		if (escaped) {
			token += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			else token += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/u.test(char) || ";|&()<>".includes(char)) {
			flush();
			if (";|&()<>".includes(char)) tokens.push(char);
			continue;
		}
		token += char;
	}
	if (quote || escaped) return null;
	flush();
	return tokens;
}

function pathValue(token: string): string | null {
	if (token === "~" || token.startsWith("~/") || /\$(?:\{)?(?:HOME|TMPDIR|PWD)(?:\})?/u.test(token)) return token;
	const equals = token.indexOf("=");
	const value = equals >= 0 ? token.slice(equals + 1) : token;
	if (value.includes("://")) return null;
	if (
		isAbsolute(value) || value === ".." || value.startsWith("../") ||
		value.includes("/../") || value.endsWith("/..") || value.includes("/")
	) return value;
	return null;
}

/** Reject statically visible cwd/repository/absolute-target escapes. */
export function bashCommandStaysInRepo(command: unknown, cwd: string, repoRoot: string): boolean {
	if (typeof command !== "string") return false;
	const tokens = shellTokens(command);
	if (!tokens) return false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "cd" || token === "pushd") {
			const target = tokens[++index];
			if (!target || !targetIsInsideRepo(target, cwd, repoRoot)) return false;
			continue;
		}
		if (token === "-C" || token === "--work-tree" || token === "--git-dir") {
			const target = tokens[++index];
			if (!target || !targetIsInsideRepo(target, cwd, repoRoot)) return false;
			continue;
		}
		for (const prefix of ["-C", "--work-tree=", "--git-dir="] as const) {
			if (token.startsWith(prefix) && token.length > prefix.length) {
				if (!targetIsInsideRepo(token.slice(prefix.length), cwd, repoRoot)) return false;
			}
		}
		const visiblePath = pathValue(token);
		if (visiblePath && !targetIsInsideRepo(visiblePath, cwd, repoRoot)) return false;
	}
	return true;
}

function mutationTarget(toolName: string, input: Record<string, unknown>): unknown {
	if (toolName === "notebook") return input.notebook_path ?? input.path ?? input.file_path;
	return input.path ?? input.file_path;
}

export function mutationGateDecision(
	toolName: string,
	input: Record<string, unknown>,
	runtime: RuntimeContext,
): ToolCallEventResult | undefined {
	if (isNativeDevspecVerb(toolName) || READ_ONLY_TOOLS.has(toolName)) return undefined;

	const scope = claimAuthorityScope(runtime.sessionManager.getSessionId(), runtime.cwd);
	const claimed = scope ? hasClaimAuthority(scope) : false;
	if (!claimed) {
		if (toolName === "bash" && isReadOnlyShellCommand(input.command)) return undefined;
		// Unknown/custom tools fail closed too: apply_patch, notebook, shell,
		// deploy and future mutators cannot bypass the known write/edit names.
		return { block: true, reason: BLOCK_REASON, terminate: true };
	}

	if (FILE_MUTATORS.has(toolName)) {
		if (!targetIsInsideRepo(mutationTarget(toolName, input), runtime.cwd, scope!.repoRoot)) {
			return { block: true, reason: SCOPE_REASON, terminate: true };
		}
		return undefined;
	}
	if (SHELL_MUTATORS.has(toolName)) {
		if (!bashCommandStaysInRepo(input.command, runtime.cwd, scope!.repoRoot)) {
			return { block: true, reason: SCOPE_REASON, terminate: true };
		}
		return undefined;
	}

	// A claim opens only the audited mutators above. It must never grant ambient
	// authority to a custom tool or to a mutator introduced in a future Pi release.
	return { block: true, reason: BLOCK_REASON, terminate: true };
}

export default function (pi: ExtensionAPI): void {
	const clearRuntime = (_event: unknown, ctx: RuntimeContext) => {
		const scope = claimAuthorityScope(ctx.sessionManager.getSessionId(), ctx.cwd);
		if (scope) clearClaimAuthorities(scope);
	};
	pi.on("session_start", clearRuntime);
	pi.on("session_shutdown", clearRuntime);
	pi.on("tool_call", (event, ctx) => mutationGateDecision(event.toolName, event.input, ctx));
}
