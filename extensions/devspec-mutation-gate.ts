/**
 * Mechanical claim-before-mutation gate. Claim evidence is scoped to the
 * current Pi session and launch repository so it cannot leak between runtimes.
 * The claim is provenance authority, not a filesystem sandbox: one project
 * action item may legitimately span several repositories.
 *
 * This host gate covers Pi's known file and shell mutation surfaces. Unknown
 * extension tools are not guessed to be mutators merely because they are
 * unknown; those tools retain their own authorization contracts.
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	claimAuthorityScope,
	clearClaimAuthorities,
	hasClaimAuthority,
} from "./core/claim-authority.ts";
import { TOOL_LOADER_NAME, isCallableModelVerb } from "./core/model-surface.ts";

const BLOCK_REASON =
	"DevSpec mutation gate: mutation requires a successful claim_work_item result for this Pi session. Claim the covering item and retry; read-only investigation remains available.";

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
const PI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Upstream pi-subagents stamps both values into child processes. This is an
 * intentional cooperative provenance exception, not cryptographic claim
 * inheritance or a security boundary against locally controlled processes.
 */
export function isTrustedSubagentProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[SUBAGENT_CHILD_ENV] === "1" &&
		PI_SESSION_ID.test(environment[SUBAGENT_PARENT_SESSION_ENV] ?? "");
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_MUTATORS = new Set(["write", "edit", "notebook", "apply_patch"]);
const SHELL_MUTATORS = new Set(["bash", "shell"]);
const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|"]);
const SIMPLE_READ_COMMANDS = new Set([
	"[",
	"basename",
	"cat",
	"cd",
	"cmp",
	"comm",
	"cut",
	"df",
	"dirname",
	"du",
	"echo",
	"false",
	"file",
	"grep",
	"head",
	"jq",
	"ls",
	"popd",
	"printf",
	"pushd",
	"pwd",
	"readlink",
	"realpath",
	"stat",
	"tail",
	"test",
	"tr",
	"true",
	"type",
	"uniq",
	"wc",
	"which",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame",
	"cat-file",
	"count-objects",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"diff-tree",
	"for-each-ref",
	"grep",
	"log",
	"ls-files",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-parse",
	"shortlog",
	"show",
	"status",
	"whatchanged",
]);

type RuntimeContext = {
	cwd: string;
	sessionManager: { getSessionId(): string };
};

function isNativeDevspecVerb(toolName: string): boolean {
	return toolName === TOOL_LOADER_NAME || isCallableModelVerb(toolName);
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

	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) {
			if (char === "\n") return null;
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
		if (char === "\n") {
			flush();
			tokens.push(";");
			continue;
		}
		if (/\s/u.test(char)) {
			flush();
			continue;
		}
		if (";|&()<>".includes(char)) {
			flush();
			const next = command[index + 1];
			if ((char === "&" || char === "|" || char === "<" || char === ">") && next === char) {
				tokens.push(char + next);
				index++;
			} else {
				tokens.push(char);
			}
			continue;
		}
		token += char;
	}
	if (quote || escaped) return null;
	flush();
	return tokens;
}

function gitBranchIsReadOnly(args: string[]): boolean {
	if (args.some((arg) => /^(?:-[dDmMcC]|--(?:delete|move|copy|edit-description|set-upstream-to|unset-upstream))(?:$|=)/u.test(arg))) {
		return false;
	}
	const allowsPatterns = args.includes("--list");
	return args.every((arg) => arg.startsWith("-") || allowsPatterns);
}

function gitRemoteIsReadOnly(args: string[]): boolean {
	if (args.length === 0 || args.every((arg) => arg === "-v" || arg === "--verbose")) return true;
	return args[0] === "get-url" || args[0] === "show";
}

function gitTagIsReadOnly(args: string[]): boolean {
	if (args.length === 0) return true;
	if (args.some((arg) => /^(?:-[adfsu]|--(?:delete|annotate|force|sign|local-user|message|file))(?:$|=)/u.test(arg))) {
		return false;
	}
	return args[0] === "--list" || args[0] === "-l" || args[0] === "--verify" || args[0] === "-v";
}

function gitConfigIsReadOnly(args: string[]): boolean {
	if (args.some((arg) => /^(?:-e|--(?:edit|add|replace-all|unset|unset-all|rename-section|remove-section)|--file=|--blob=)/u.test(arg))) {
		return false;
	}
	const positionals = args.filter((arg) => !arg.startsWith("-"));
	return positionals.length <= 1 || args.some((arg) => /^(?:-l|--list|--get|--get-all|--get-regexp|get|get-all|get-regexp)$/u.test(arg));
}

function gitCommandIsReadOnly(args: string[]): boolean {
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) {
			if (index + 1 >= args.length) return false;
			index += 2;
			continue;
		}
		if (/^(?:--git-dir|--work-tree|--namespace|--config-env)=/u.test(arg)) {
			index++;
			continue;
		}
		if (["--no-pager", "--paginate", "-p", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"].includes(arg)) {
			index++;
			continue;
		}
		break;
	}
	const subcommand = args[index];
	if (!subcommand) return false;
	const subcommandArgs = args.slice(index + 1);
	if (subcommandArgs.some((arg) => ["--ext-diff", "--textconv", "--lost-found", "--output"].includes(arg) || arg.startsWith("--output="))) return false;
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
	if (subcommand === "branch") return gitBranchIsReadOnly(subcommandArgs);
	if (subcommand === "config") return gitConfigIsReadOnly(subcommandArgs);
	if (subcommand === "reflog") return subcommandArgs.length === 0 || subcommandArgs[0] === "show" || subcommandArgs[0] === "exists";
	if (subcommand === "remote") return gitRemoteIsReadOnly(subcommandArgs);
	if (subcommand === "tag") return gitTagIsReadOnly(subcommandArgs);
	if (subcommand === "worktree") return subcommandArgs[0] === "list";
	return false;
}

function simpleCommandIsReadOnly(tokens: string[]): boolean {
	let index = 0;
	while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)) index++;
	if (index === tokens.length) return true;
	const command = tokens[index]!;
	const args = tokens.slice(index + 1);
	if (command === "git") return gitCommandIsReadOnly(args);
	if (command === "find") {
		return !args.some((arg) => /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/u.test(arg));
	}
	if (command === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
	if (command === "sort") return !args.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="));
	return SIMPLE_READ_COMMANDS.has(command);
}

/** Conservative shell classifier: every command in a compound expression must be read-only. */
export function isReadOnlyShellCommand(command: unknown): boolean {
	if (typeof command !== "string" || /`|\$\(/u.test(command)) return false;
	const tokens = shellTokens(command);
	if (!tokens || tokens.length === 0) return false;
	if (tokens.some((token) => ["&", "(", ")", "<", "<<", ">", ">>"].includes(token))) return false;

	let sawCommand = false;
	let segment: string[] = [];
	for (const token of tokens) {
		if (!COMMAND_SEPARATORS.has(token)) {
			segment.push(token);
			continue;
		}
		if (segment.length > 0) {
			if (!simpleCommandIsReadOnly(segment)) return false;
			sawCommand = true;
			segment = [];
		}
	}
	if (segment.length > 0) {
		if (!simpleCommandIsReadOnly(segment)) return false;
		sawCommand = true;
	}
	return sawCommand;
}

export function mutationGateDecision(
	toolName: string,
	input: Record<string, unknown>,
	runtime: RuntimeContext,
	environment: NodeJS.ProcessEnv = process.env,
): ToolCallEventResult | undefined {
	if (isNativeDevspecVerb(toolName) || READ_ONLY_TOOLS.has(toolName)) return undefined;

	const isFileMutation = FILE_MUTATORS.has(toolName);
	const isShellMutation = SHELL_MUTATORS.has(toolName) && !isReadOnlyShellCommand(input.command);
	if (!isFileMutation && !isShellMutation) return undefined;
	if (isTrustedSubagentProcess(environment)) return undefined;

	const scope = claimAuthorityScope(runtime.sessionManager.getSessionId(), runtime.cwd);
	if (scope && hasClaimAuthority(scope)) return undefined;

	// Deliberately non-terminating: Pi returns the reason to the model so it can
	// claim and retry, or continue with a read-only investigation path.
	return { block: true, reason: BLOCK_REASON };
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
