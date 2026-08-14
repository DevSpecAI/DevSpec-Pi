/**
 * Privacy-safe projections for Pi's shared work trail.
 *
 * Tool inputs and outputs are private execution data. The room timeline gets
 * only explicit, tool-aware metadata from this module; unknown shapes fail
 * closed. A final redactor is defense in depth, not the primary projection.
 */

import { MODEL_VERB_NAMES } from "../generated/mcp-catalog.ts";

const MAX_SUMMARY_CHARS = 600;
const MAX_LABEL_CHARS = 240;

const FILE_TOOLS = new Set(["read", "write", "edit", "apply_patch", "multiedit"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "execute"]);
const WEB_TOOLS = new Set(["fetch", "web_fetch", "web_search", "browser", "navigate"]);
const DATABASE_TOOLS = new Set(["supabase_execute_sql", "execute_sql", "query_database"]);
const DEVSPEC_TOOLS = new Set<string>([...MODEL_VERB_NAMES, "search_devspec_tools"]);

const DEVSPEC_ID_KEYS = [
	"action_item_id",
	"brief_id",
	"criterion_id",
	"goal_id",
	"id",
	"memory_id",
	"project_id",
	"resource_id",
	"session_id",
	"signal_id",
] as const;

const SECRET_NAME = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|bearer|client[_-]?secret|credential|jwt|password|passwd|private[_-]?key|secret|session[_-]?token|token)(?:$|[_-])/i;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function oneLine(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Defense-in-depth for the small strings selected by explicit projectors. */
export function redactTrailText(value: string, maxChars: number = MAX_SUMMARY_CHARS): string {
	let text = oneLine(value);
	// URL identity, userinfo, hosts, paths, and query strings are never useful
	// in a shared activity row. HTTP(S) retains only its transport class; every
	// other URI scheme fails closed.
	text = text.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]+/g, (candidate) => safeUrl(candidate) ?? "[redacted URL]");
	// Credential-like assignments and long-form CLI flags.
	text = text.replace(/\b([A-Za-z][A-Za-z0-9_-]*)(\s*=\s*)([^\s;&|]+)/g, (whole, key: string, eq: string) =>
		SECRET_NAME.test(key) ? `${key}${eq}[REDACTED]` : whole,
	);
	text = text.replace(/((?:--?)(?:access[-_]?token|api[-_]?key|apikey|auth|authorization|bearer|client[-_]?secret|credential|jwt|password|passwd|private[-_]?key|secret|session[-_]?token|token))(?:=|\s+)\S+/gi, "$1=[REDACTED]");
	text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
	// Common high-confidence credential formats.
	text = text.replace(/\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, "[REDACTED]");
	if (text.length > maxChars) return `${text.slice(0, maxChars)}…`;
	return text || "[redacted]";
}

export function safeTrailLabel(value: unknown, maxChars: number = MAX_LABEL_CHARS): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const redacted = redactTrailText(value, maxChars)
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[`\\*_{}\[\]<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return redacted || undefined;
}

/** DevSpec entity identifiers are UUIDs (short hex refs are accepted for UI hints). */
export function safeTrailId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	return /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)
		? id
		: undefined;
}

function safePath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const path = oneLine(value);
	// Paths shown in a shared trail must be literal operands, never unevaluated
	// shell syntax, globs, substitutions, expansions, or command separators.
	if (/[\0`*?$(){}[\]<>|;&!\\:@]/.test(path)) return undefined;
	return redactTrailText(path, 320);
}

function safeUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		// Even hostnames can be secret-bearing tenant IDs, internal names, or signed
		// subdomains. Without a complete public-suffix policy, fail closed and expose
		// only the transport class; the tool name still says what kind of work ran.
		return `${url.protocol.slice(0, -1)} request`;
	} catch {
		return undefined;
	}
}

function shellTokens(command: string): string[] {
	return oneLine(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function bareToken(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}

interface ParsedPositionals {
	positionals: string[];
	seenOptions: Set<string>;
	safe: boolean;
}

function parsePositionals(
	tokens: string[],
	valueOptions: ReadonlySet<string>,
	flagOptions: ReadonlySet<string>,
): ParsedPositionals {
	const positionals: string[] = [];
	const seenOptions = new Set<string>();
	let optionsEnded = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = bareToken(tokens[i]);
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-") && token !== "-") {
			const [option] = token.split("=", 1);
			seenOptions.add(option);
			if (valueOptions.has(option)) {
				if (!token.includes("=")) i++;
				continue;
			}
			if (flagOptions.has(option) || /^-[A-Za-z]{2,}$/.test(option)) continue;
			return { positionals: [], seenOptions, safe: false };
		}
		positionals.push(token);
	}
	return { positionals, seenOptions, safe: true };
}

const COMMON_FLAG_OPTIONS = new Set([
	"-0", "--null", "-a", "--all", "-A", "--almost-all", "-b", "--byte-offset", "--binary",
	"--color", "--column", "-F", "--fixed-strings", "-h", "--help", "-H", "--with-filename", "-i",
	"--ignore-case", "-l", "--files-with-matches", "-L", "--dereference", "-n", "--line-number", "-P",
	"--perl-regexp", "-q", "--quiet", "-R", "--recursive", "-s", "--no-messages", "-S", "--smart-case",
	"-u", "--unrestricted", "-v", "--invert-match", "-w", "--word-regexp", "-x", "--line-regexp",
]);
const SEARCH_VALUE_OPTIONS = new Set([
	"-A", "--after-context", "-B", "--before-context", "-C", "--context", "-e", "--regexp", "-f", "--file",
	"-g", "--glob", "--iglob", "-j", "--threads", "-m", "--max-count", "--encoding", "--engine", "--pre",
	"--pre-glob", "-r", "--replace", "--sort", "--sortr", "-t", "--type", "--type-add", "--type-clear",
]);
const FILE_VALUE_OPTIONS = new Set([
	"-c", "--bytes", "--format", "--printf", "-n", "--lines", "--relative-base", "--relative-to", "--sleep-interval",
]);

function safeFileOperand(tokens: string[]): string | undefined {
	const parsed = parsePositionals(tokens, FILE_VALUE_OPTIONS, COMMON_FLAG_OPTIONS);
	if (!parsed.safe || parsed.positionals.length !== 1) return undefined;
	return safePath(parsed.positionals[0]);
}

function safeSearchPath(command: "rg" | "grep" | "find", tokens: string[]): string | undefined {
	const parsed = parsePositionals(tokens, SEARCH_VALUE_OPTIONS, COMMON_FLAG_OPTIONS);
	if (!parsed.safe) return undefined;
	if (command === "find") {
		const firstExpression = parsed.positionals.findIndex((token) => token.startsWith("-") || token === "(" || token === "!");
		const paths = firstExpression < 0 ? parsed.positionals : parsed.positionals.slice(0, firstExpression);
		return paths.length === 1 ? safePath(paths[0]) : undefined;
	}
	const patternFromOption = parsed.seenOptions.has("-e") || parsed.seenOptions.has("--regexp")
		|| parsed.seenOptions.has("-f") || parsed.seenOptions.has("--file");
	const paths = patternFromOption ? parsed.positionals : parsed.positionals.slice(1);
	return paths.length === 1 ? safePath(paths[0]) : undefined;
}

function safeShellCommand(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const tokens = shellTokens(value);
	while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
	const executable = bareToken(tokens.shift() ?? "").split("/").pop();
	if (!executable || !/^[A-Za-z0-9_.+-]+$/.test(executable)) return "command";

	const lower = executable.toLowerCase();
	const knownCommands = new Set([
		"agent-browser", "cargo", "deno", "docker", "node", "npx", "python", "python3", "supabase", "tsc",
	]);
	let selected: string[] = knownCommands.has(lower) ? [lower] : ["command"];
	if (["npm", "pnpm", "yarn", "bun"].includes(lower)) {
		selected = [lower];
		const operation = bareToken(tokens[0] ?? "").toLowerCase();
		const allowed = new Set(["build", "ci", "exec", "install", "lint", "run", "start", "test", "typecheck"]);
		if (allowed.has(operation)) {
			selected.push(operation);
			const conventionalScripts = new Set(["build", "check", "dev", "lint", "start", "test", "typecheck"]);
			const script = bareToken(tokens[1] ?? "").toLowerCase();
			if (operation === "run" && conventionalScripts.has(script)) selected.push(script);
		}
	} else if (lower === "git") {
		const operation = bareToken(tokens[0] ?? "").toLowerCase();
		const allowed = new Set(["branch", "commit", "diff", "fetch", "log", "merge", "pull", "push", "rebase", "status"]);
		if (allowed.has(operation)) selected.push(operation);
		const flags = tokens
			.slice(1)
			.map(bareToken)
			.filter((token) => /^--(?:check|short|stat|oneline|decorate|name-only)$/.test(token))
			.slice(0, 2);
		selected = selected.concat(flags);
	} else if (["ls", "cat", "head", "tail", "wc", "stat", "realpath"].includes(lower)) {
		selected = [lower];
		const path = safeFileOperand(tokens);
		if (path) selected.push(path);
	} else if (lower === "rg" || lower === "grep" || lower === "find") {
		selected = [lower];
		const path = safeSearchPath(lower, tokens);
		selected.push("…");
		if (path) selected.push(path);
	} else if (lower === "curl" || lower === "wget") {
		selected = ["http request"];
	}
	return redactTrailText(selected.join(" "), 400);
}

function sqlSummary(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const operation = value.match(/^\s*(select|insert|update|delete|with|alter|create|drop|explain)\b/i)?.[1]?.toUpperCase();
	if (!operation) return "SQL query";
	const table = value.match(/\b(?:from|into|update|table|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/i)?.[1];
	return table ? `${operation} ${table}` : `${operation} query`;
}

function devspecArgs(name: string, args: Record<string, unknown>): string | undefined {
	const parts: string[] = [];
	for (const key of DEVSPEC_ID_KEYS) {
		const id = safeTrailId(args[key]);
		if (id) parts.push(`${key}=${id}`);
	}
	if (name === "search_devspec_tools") {
		const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;
		return limit == null ? "capability search" : `capability search; limit=${limit}`;
	}
	if (name.startsWith("search_") || name.startsWith("list_")) {
		const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;
		if (limit != null) parts.push(`limit=${limit}`);
	}
	return parts.length ? parts.slice(0, 4).join("; ") : undefined;
}

/** Select safe input metadata for a known tool. Unknown tools expose no args. */
export function projectTrailArgs(name: string, args: unknown): string | undefined {
	const a = asRecord(args);
	if (!a) return undefined;
	if (SHELL_TOOLS.has(name)) return safeShellCommand(a.command);
	if (FILE_TOOLS.has(name)) return safePath(a.path ?? a.file_path);
	if (SEARCH_TOOLS.has(name)) {
		const path = safePath(a.path);
		return path ? `${name} in ${path}` : name;
	}
	if (WEB_TOOLS.has(name)) {
		const url = typeof a.url === "string" ? safeUrl(a.url) : undefined;
		return url ? redactTrailText(url, 400) : name === "web_search" ? "web search" : undefined;
	}
	if (DATABASE_TOOLS.has(name)) return sqlSummary(a.query);
	if (DEVSPEC_TOOLS.has(name)) return devspecArgs(name, a);
	return undefined;
}

function resultText(result: unknown): string | undefined {
	const outer = asRecord(result);
	if (!outer || !Array.isArray(outer.content)) return undefined;
	const text = outer.content
		.filter((item) => asRecord(item)?.type === "text")
		.map((item) => asRecord(item)?.text)
		.find((value): value is string => typeof value === "string" && value.trim().length > 0);
	return text;
}

function parsedResult(result: unknown): Record<string, unknown> | null {
	const outer = asRecord(result);
	const details = asRecord(outer?.details);
	if (details) return details;
	const text = resultText(result);
	if (text?.trim().startsWith("{")) {
		try {
			return asRecord(JSON.parse(text));
		} catch {
			return null;
		}
	}
	return outer;
}

function wrappedEntity(parsed: Record<string, unknown>): Record<string, unknown> {
	const item = asRecord(parsed.item);
	return asRecord(parsed.action_item)
		?? asRecord(parsed.resource)
		?? asRecord(parsed.memory)
		?? asRecord(item?.action_item)
		?? asRecord(item?.resource)
		?? asRecord(item?.memory)
		?? item
		?? parsed;
}

function safeOutcome(result: unknown): string | undefined {
	const parsed = parsedResult(result);
	if (!parsed) return undefined;
	const nested = wrappedEntity(parsed);
	const parts: string[] = [];
	const allowedStates = new Set([
		"accepted", "active", "achieved", "archived", "blocked", "cancelled", "claimed", "deferred", "dismissed",
		"diverged", "done", "error", "failed", "finished", "healthy", "idle", "implemented", "implementing",
		"in_progress", "merged", "open", "passed", "pending", "recorded", "reporting", "resolved", "retracted",
		"skipped", "staged", "success", "superseded", "verified",
	]);
	for (const key of ["lifecycle", "state", "status"] as const) {
		const value = typeof nested[key] === "string" ? nested[key].trim().toLowerCase() : undefined;
		if (value && allowedStates.has(value)) parts.push(`${key}=${value}`);
	}
	for (const key of ["claim_success", "implementation_recorded", "recorded", "success"] as const) {
		const value = parsed[key] ?? nested[key];
		if (typeof value === "boolean") parts.push(`${key}=${String(value)}`);
	}
	for (const key of ["affected_items", "created_count", "updated_count", "count"] as const) {
		const value = parsed[key] ?? nested[key];
		if (typeof value === "number" && Number.isFinite(value)) parts.push(`${key}=${value}`);
	}
	return parts.length ? redactTrailText(parts.slice(0, 4).join("; "), 240) : undefined;
}

/** Select safe output metadata. Raw tool text is never copied into the trail. */
export function projectTrailResult(name: string, result: unknown): string | undefined {
	if (!DEVSPEC_TOOLS.has(name)) return undefined;
	if (/^(?:create_|update_|claim_|record_|resolve_|supersede_|retract_|archive_)/.test(name)) {
		return safeOutcome(result);
	}
	if (name.startsWith("search_") || name.startsWith("list_")) {
		const text = resultText(result);
		const match = text?.match(/^\w[\w-]*:\s*(\d+)\s+results?(?:;\s*showing\s*(\d+))?/i);
		if (match) return match[2] ? `${match[1]} results; showing ${match[2]}` : `${match[1]} results`;
	}
	return undefined;
}
