/**
 * Mechanical claim-before-mutation gate. Claim evidence is scoped to the
 * current Pi session and canonical repository so it cannot leak between runtimes.
 * The claim is provenance authority, not a filesystem sandbox: one project
 * action item may legitimately span several repositories.
 *
 * This host gate covers Pi's known file and shell mutation surfaces. Unknown
 * extension tools are not guessed to be mutators merely because they are
 * unknown; those tools retain their own authorization contracts.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	claimAuthorityScope,
	clearSessionClaimAuthorities,
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
	"sha256sum",
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
	"ls-remote",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-list",
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
			const descriptor = (char === ">" || char === "<") && /^\d+$/u.test(token) ? token : "";
			if (descriptor) token = "";
			else flush();
			const next = command[index + 1];
			if ((char === "&" || char === "|" || char === "<" || char === ">") && next === char) {
				tokens.push(descriptor + char + next);
				index++;
			} else {
				tokens.push(descriptor + char);
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
	if (args.some((arg) => /^(?:-e|--(?:edit|add|replace-all|unset|unset-all|rename-section|remove-section)|--file=|--blob=)/u.test(arg)) ||
		["set", "set-all", "unset", "unset-all", "rename-section", "remove-section"].includes(args[0] ?? "")) {
		return false;
	}
	const readOperations = new Set([
		"-l", "--list", "--get", "--get-all", "--get-regexp", "--get-urlmatch",
		"list", "get", "get-all", "get-regexp", "get-urlmatch",
	]);
	if (args.some((arg) => readOperations.has(arg))) return true;

	const safeFlags = new Set([
		"--global", "--system", "--local", "--worktree", "--fixed-value",
		"--name-only", "--null", "-z", "--show-origin", "--show-scope",
		"--includes", "--no-includes",
	]);
	let optionsEnded = false;
	let positionals = 0;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (!optionsEnded && arg === "--") {
			optionsEnded = true;
			continue;
		}
		if (positionals > 0 || optionsEnded) {
			positionals++;
			continue;
		}
		if (safeFlags.has(arg)) continue;
		if (arg === "--type") {
			if (index + 1 >= args.length) return false;
			index++;
			continue;
		}
		if (arg.startsWith("--type=")) continue;
		if (arg.startsWith("-")) return false;
		positionals++;
	}
	return positionals <= 1;
}

const SAFE_FETCH_FLAGS = new Set([
	"--all", "-a", "--append", "--atomic", "--dry-run", "--force", "-f",
	"--keep", "-k", "--no-recurse-submodules", "--no-show-forced-updates",
	"--no-tags", "-n", "--no-write-fetch-head", "--prefetch", "--prune", "-p",
	"--prune-tags", "--quiet", "-q", "--recurse-submodules", "--show-forced-updates",
	"--tags", "-t", "--verbose", "-v", "--write-fetch-head",
]);
const SAFE_FETCH_VALUE_OPTIONS = new Set([
	"--deepen", "--depth", "--filter", "--jobs", "-j", "--negotiation-tip",
	"--server-option", "--shallow-exclude", "--shallow-since",
]);

function configuredGitRemotes(cwd: string | undefined): Set<string> | null {
	if (!cwd) return null;
	try {
		return new Set(execFileSync("git", ["remote"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		}).toString().split(/\r?\n/u).filter(Boolean));
	} catch {
		return null;
	}
}

/** Fetch may refresh Git metadata, but cannot name a URL or explicit refspec. */
function gitFetchIsInspectionOnly(args: string[], cwd: string | undefined): boolean {
	const positionals: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (SAFE_FETCH_FLAGS.has(arg)) continue;
		if (SAFE_FETCH_VALUE_OPTIONS.has(arg)) {
			if (index + 1 >= args.length) return false;
			index++;
			continue;
		}
		if ([...SAFE_FETCH_VALUE_OPTIONS].some((option) => arg.startsWith(`${option}=`)) || arg.startsWith("--recurse-submodules=")) continue;
		if (arg.startsWith("-")) return false;
		positionals.push(arg);
	}
	if (positionals.length === 0) return true;
	if (positionals.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(positionals[0]!)) return false;
	return configuredGitRemotes(cwd)?.has(positionals[0]!) === true;
}

function gitCommandIsReadOnly(args: string[], cwd: string | undefined): boolean {
	let effectiveCwd = cwd;
	let customRepository = false;
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (arg === "-c" || arg === "--config-env" || /^(?:-c.+|--config-env=)/u.test(arg)) return false;
		if (arg === "-C") {
			if (index + 1 >= args.length) return false;
			const directory = args[index + 1]!;
			effectiveCwd = effectiveCwd ? resolve(effectiveCwd, directory) : isAbsolute(directory) ? directory : undefined;
			index += 2;
			continue;
		}
		if (["--git-dir", "--work-tree", "--namespace"].includes(arg)) {
			if (index + 1 >= args.length) return false;
			customRepository = true;
			index += 2;
			continue;
		}
		if (/^(?:--git-dir|--work-tree|--namespace)=/u.test(arg)) {
			customRepository = true;
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
	if (subcommandArgs.some((arg) =>
		["--exec", "--ext-diff", "--filters", "--textconv", "--lost-found", "--output", "--open-files-in-pager", "--upload-pack"].includes(arg) ||
		/^(?:--exec|--filters|--output|--open-files-in-pager|--upload-pack)=/u.test(arg)
	)) return false;
	if (subcommand === "grep" && subcommandArgs.some((arg) => /^-O/u.test(arg))) return false;
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
	if (subcommand === "fetch") return !customRepository && gitFetchIsInspectionOnly(subcommandArgs, effectiveCwd);
	if (subcommand === "branch") return gitBranchIsReadOnly(subcommandArgs);
	if (subcommand === "config") return gitConfigIsReadOnly(subcommandArgs);
	if (subcommand === "reflog") return subcommandArgs.length === 0 || subcommandArgs[0] === "show" || subcommandArgs[0] === "exists";
	if (subcommand === "remote") return gitRemoteIsReadOnly(subcommandArgs);
	if (subcommand === "tag") return gitTagIsReadOnly(subcommandArgs);
	if (subcommand === "worktree") return subcommandArgs[0] === "list";
	return false;
}

function npmCommandIsInspectionOnly(args: string[]): boolean {
	if (args.some((arg) => /^(?:--cache|--logs-dir)(?:$|=|\s)/u.test(arg) || arg === "--timing")) return false;
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (["--prefix", "-C", "--workspace", "-w"].includes(arg)) {
			if (index + 1 >= args.length) return false;
			index += 2;
			continue;
		}
		if (/^--(?:prefix|workspace)=/u.test(arg) || arg === "--global" || arg === "-g") {
			index++;
			continue;
		}
		break;
	}
	return new Set(["info", "la", "list", "ll", "ls", "show", "view"]).has(args[index] ?? "");
}

function ghCommandIsInspectionOnly(args: string[]): boolean {
	if (args[0] !== "api") return false;
	let method = "GET";
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--method" || arg === "-X") {
			if (index + 1 >= args.length) return false;
			method = args[++index]!.toUpperCase();
			continue;
		}
		if (arg.startsWith("--method=")) {
			method = arg.slice("--method=".length).toUpperCase();
			continue;
		}
		if (/^-X.+/u.test(arg)) {
			method = arg.slice(2).toUpperCase();
			continue;
		}
		if ((arg.startsWith("-") && /\s/u.test(arg)) || /^(?:-[fF](?:$|.+)|--(?:field|raw-field|input)(?:$|=))/u.test(arg)) return false;
	}
	return method === "GET" && !args.includes("graphql");
}

function simpleCommandIsReadOnly(tokens: string[], cwd: string | undefined): boolean {
	if (tokens.length === 0) return false;
	const command = tokens[0]!;
	const args = tokens.slice(1);
	if (command === "git") return gitCommandIsReadOnly(args, cwd);
	if (command === "gh") return ghCommandIsInspectionOnly(args);
	if (command === "npm") return npmCommandIsInspectionOnly(args);
	if (command === "find") {
		return !args.some((arg) => /^(?:-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprint0|-fprintf|-fls)$/u.test(arg));
	}
	if (command === "rg") return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre="));
	if (command === "sort") return !args.some((arg) =>
		/^-[^-]*o/u.test(arg) || arg.startsWith("--o") ||
		arg === "-T" || /^-T.+/u.test(arg) || arg === "--temporary-directory" || arg.startsWith("--temporary-directory=") ||
		arg === "--compress-program" || arg.startsWith("--compress-program=")
	);
	if (command === "uniq") {
		const valueOptions = new Set(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"]);
		let optionsEnded = false;
		let positionals = 0;
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (!optionsEnded && arg === "--") {
				optionsEnded = true;
				continue;
			}
			if (!optionsEnded && valueOptions.has(arg)) {
				if (index + 1 >= args.length) return false;
				index++;
				continue;
			}
			if (!optionsEnded && /^(?:-[fsw].+|--(?:skip-fields|skip-chars|check-chars)=)/u.test(arg)) continue;
			if (!optionsEnded && arg.startsWith("-") && arg !== "-") continue;
			positionals++;
		}
		return positionals <= 1;
	}
	return SIMPLE_READ_COMMANDS.has(command);
}

function stripNullOutputRedirections(tokens: string[]): string[] | null {
	const stripped: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (/^\d*>{1,2}$/u.test(token)) {
			if (tokens[index + 1] !== "/dev/null") return null;
			index++;
			continue;
		}
		if (/^\d*<{1,2}$/u.test(token) || ["&", "(", ")"].includes(token)) return null;
		stripped.push(token);
	}
	return stripped;
}

function expandShellToken(token: string, variables: Map<string, string>): string | null {
	let unresolved = false;
	const expanded = token.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu, (_match, braced, plain) => {
		const value = variables.get(braced ?? plain);
		if (value === undefined || value.trim().split(/\s+/u).some((part) => part.startsWith("-"))) unresolved = true;
		return value ?? "";
	});
	return unresolved || expanded.includes("$") ? null : expanded;
}

function segmentIsInspectionOnly(segment: string[], variables: Map<string, string>, cwd: string | undefined): boolean {
	const assignments: Array<[string, string]> = [];
	let index = 0;
	while (index < segment.length) {
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(segment[index]!);
		if (!match) break;
		const value = expandShellToken(match[2]!, variables);
		if (value === null) return false;
		assignments.push([match[1]!, value]);
		index++;
	}
	if (index < segment.length && assignments.length > 0) return false;
	if (index === segment.length) {
		for (const [name, value] of assignments) variables.set(name, value);
		return assignments.length > 0;
	}
	const expanded: string[] = [];
	for (const token of segment) {
		const value = expandShellToken(token, variables);
		if (value === null) return false;
		expanded.push(value);
	}
	return simpleCommandIsReadOnly(expanded, cwd);
}

/** Conservative shell classifier: every command in a compound expression must be inspection-only. */
export function isReadOnlyShellCommand(command: unknown, cwd?: string): boolean {
	if (typeof command !== "string" || /`|\$\(/u.test(command)) return false;
	const parsed = shellTokens(command);
	if (!parsed || parsed.length === 0) return false;
	const tokens = stripNullOutputRedirections(parsed);
	if (!tokens || tokens.length === 0) return false;

	const variables = new Map<string, string>();
	let sawCommand = false;
	let segment: string[] = [];
	for (const token of tokens) {
		if (!COMMAND_SEPARATORS.has(token)) {
			segment.push(token);
			continue;
		}
		if (segment.length > 0) {
			if (!segmentIsInspectionOnly(segment, variables, cwd)) return false;
			sawCommand = true;
			segment = [];
		}
	}
	if (segment.length > 0) {
		if (!segmentIsInspectionOnly(segment, variables, cwd)) return false;
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
	const isShellMutation = SHELL_MUTATORS.has(toolName) && !isReadOnlyShellCommand(input.command, runtime.cwd);
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
		clearSessionClaimAuthorities(ctx.sessionManager.getSessionId());
	};
	pi.on("session_start", clearRuntime);
	pi.on("session_shutdown", clearRuntime);
	pi.on("tool_call", (event, ctx) => mutationGateDecision(event.toolName, event.input, ctx));
}
