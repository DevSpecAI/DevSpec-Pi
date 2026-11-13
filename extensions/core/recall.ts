/**
 * DevSpec Pi — automatic turn recall (pure helpers, unit-tested).
 *
 * Recall happens BEFORE the model thinks, not when it remembers to search. Each
 * substantive turn's prompt — typed here, or a command sent from DevSpec — goes
 * to DevSpec's turn recall (`POST <mcp url>/turn-recall`, task 2e766aeb), which
 * screens the project's requirements, documents, memories, plans, rejections and
 * past shipped work against it and answers with one ready-made block of cards.
 *
 * The block is OPAQUE here (decision 3ea02bd2): Pi never parses, filters or
 * re-renders a card by its kind, so a record kind DevSpec adds later reaches the
 * model with no plugin release. Pi keeps only what DevSpec says was shown —
 * `kind:id:vN` keys — on the hidden message itself (`details.dedupeKeys`), and
 * sends the keys still in context back on the next turn, so an unchanged card
 * appears once per conversation and an edited record (a new version) comes back.
 *
 * Host contract measured in task 7c87f509 (RECALL_TIMEOUT_BUDGETS in DevSpecV2
 * apps/web/scripts/eval/recall-plugin-bench/host-delivery-contract.ts): an 18
 * character floor, a 2.8 s client ceiling, at most 512 seen keys per request.
 */

import { classifyUserKind } from "./turn-lifecycle.ts";

/** Shortest prompt worth a recall (host contract minQueryChars; the server skips shorter ones too). */
export const RECALL_MIN_QUERY_CHARS = 18;
/** The client's whole budget for one recall: token, scope, request and reply (host contract clientHttpTimeoutMs). */
export const RECALL_CLIENT_TIMEOUT_MS = 2_800;
/** Seen keys DevSpec accepts on one request (server RECALL_LIMITS.seenKeysPerRequest); newest are kept. */
export const RECALL_SEEN_KEYS_PER_REQUEST = 512;
/** One seen key's longest form the server accepts (RECALL_LIMITS.seenKeyChars). */
const SEEN_KEY_MAX_CHARS = 120;

/** The hidden turn-tail message every recall (and the review nudge) rides on. */
export const PROACTIVE_CUSTOM_TYPE = "devspec-proactive";

export type RecallTurn =
	| { recall: true; query: string; source: "local" | "remote" | "automation" }
	| { recall: false; reason: string };

/** What before_agent_start reports for the run being started (Pi 1.5 user or custom run). */
export interface RecallTurnEvent {
	messageType?: unknown;
	prompt?: unknown;
}

const COMMAND_OPEN = /^--- command \d+\/\d+ · message:/;
const COMMAND_CLOSE = /^--- end command:/;
const SCOPE_OPEN = /^--- delegated project scope instruction for command:/;
const SCOPE_CLOSE = /^--- end delegated project scope instruction for command:/;

/**
 * The exact command bodies of a canonical remote turn (remote-payload.ts
 * formatInboundBundleMessage): no framing line, no delegated scope instruction.
 * A message without command fences falls back to everything after its header line.
 */
export function remoteCommandText(text: string): string {
	const lines = text.split("\n");
	const bodies: string[] = [];
	let current: string[] | null = null;
	let inScope = false;
	for (const line of lines) {
		if (COMMAND_OPEN.test(line)) { current = []; inScope = false; continue; }
		if (SCOPE_OPEN.test(line)) { inScope = true; continue; }
		if (SCOPE_CLOSE.test(line)) { inScope = false; continue; }
		if (COMMAND_CLOSE.test(line)) {
			if (current) bodies.push(current.join("\n").trim());
			current = null;
			continue;
		}
		if (current && !inScope) current.push(line);
	}
	if (bodies.length > 0) return bodies.filter(Boolean).join("\n\n");
	return lines.slice(1).join("\n").trim();
}

/**
 * The automation's name from an automation-run wake (dispatch.ts
 * formatAutomationRunMessage). The wake carries nothing else of the automation's
 * own: its instruction is handed over only when the run is claimed.
 */
export function automationRunText(text: string): string {
	const fenced = /```json\n([\s\S]*?)\n```/.exec(text)?.[1];
	if (!fenced) return "";
	try {
		const envelope = JSON.parse(fenced) as Record<string, unknown>;
		return typeof envelope.automation_name === "string" ? envelope.automation_name.trim() : "";
	} catch {
		return "";
	}
}

/**
 * Is this run a substantive turn, and what is its query? Only a person's prompt
 * typed here, or a command or automation run DevSpec delivered, is recalled. A run
 * the extension starts itself (a DevSpec notice or check job as a custom message;
 * Pi 1.5 `messageType: "custom"`, no prompt — task a4b24107), a check job, a
 * directed-question continuation, harness leftovers, slash commands and short
 * acknowledgements make no call at all.
 */
export function recallTurn(event: RecallTurnEvent | null | undefined): RecallTurn {
	if (!event || (event.messageType !== undefined && event.messageType !== "user")) return { recall: false, reason: "no_typed_prompt" };
	if (typeof event.prompt !== "string") return { recall: false, reason: "no_typed_prompt" };
	const raw = event.prompt.trim();
	if (!raw) return { recall: false, reason: "empty_prompt" };
	if (raw.startsWith("/")) return { recall: false, reason: "slash_command" };
	const kind = classifyUserKind(raw);
	let query: string;
	let source: "local" | "remote" | "automation";
	if (kind === "remote") { query = remoteCommandText(raw); source = "remote"; }
	else if (kind === "automation") { query = automationRunText(raw); source = "automation"; }
	else if (kind === "local") { query = raw; source = "local"; }
	else return { recall: false, reason: `not_a_request_${kind}` };
	query = query.trim();
	if (query.startsWith("/")) return { recall: false, reason: "slash_command" };
	if (query.length < RECALL_MIN_QUERY_CHARS) return { recall: false, reason: "below_min_chars" };
	return { recall: true, query, source };
}

/** The slice of a Pi 1.5 session entry the seen-key scan reads. */
export interface BranchEntryLike {
	type?: unknown;
	id?: unknown;
	customType?: unknown;
	firstKeptEntryId?: unknown;
	details?: unknown;
}

function keysOf(entry: BranchEntryLike): string[] {
	if (entry.type !== "custom_message" || entry.customType !== PROACTIVE_CUSTOM_TYPE) return [];
	const details = entry.details as { dedupeKeys?: unknown } | null | undefined;
	if (!details || !Array.isArray(details.dedupeKeys)) return [];
	return details.dedupeKeys.filter((key): key is string =>
		typeof key === "string" && key.length > 0 && key.length <= SEEN_KEY_MAX_CHARS);
}

/**
 * The recall keys still in the model's context on this branch, newest first, at
 * most RECALL_SEEN_KEYS_PER_REQUEST. Read from the session itself, so it follows a
 * resumed session, /tree and /clear. Compaction (Phase 1, 7c87f509): what was
 * summarised away is no longer in context, so its cards may surface again; the
 * entries a compaction keeps (from its firstKeptEntryId) still count as seen.
 */
export function seenRecallKeys(branch: readonly BranchEntryLike[] | null | undefined): string[] {
	if (!Array.isArray(branch)) return [];
	const seen = new Set<string>();
	let keepUntilId: string | null = null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || typeof entry !== "object") continue;
		if (keepUntilId === null && entry.type === "compaction") {
			if (typeof entry.firstKeptEntryId !== "string" || !entry.firstKeptEntryId) break;
			keepUntilId = entry.firstKeptEntryId;
			continue;
		}
		const keys = keysOf(entry);
		for (let k = keys.length - 1; k >= 0; k--) seen.add(keys[k]!);
		if (seen.size >= RECALL_SEEN_KEYS_PER_REQUEST) break;
		if (keepUntilId !== null && entry.id === keepUntilId) break;
	}
	return Array.from(seen).slice(0, RECALL_SEEN_KEYS_PER_REQUEST);
}

/** DevSpec's turn recall endpoint beside the MCP endpoint this plugin talks to. */
export function turnRecallUrl(mcpUrl: string): string {
	const url = new URL(mcpUrl);
	url.search = "";
	url.hash = "";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/turn-recall`;
	return url.toString();
}

/** A usable recall answer: the block to inject verbatim and the keys DevSpec says it shows. */
export interface TurnRecallAnswer {
	block: string;
	keys: string[];
	cards: number;
}

/** Read DevSpec's answer without interpreting a card: nothing to inject is null. */
export function readTurnRecall(payload: unknown): TurnRecallAnswer | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	const body = payload as { formatted_block?: unknown; seen_keys?: unknown; cards?: unknown };
	const block = typeof body.formatted_block === "string" ? body.formatted_block.trim() : "";
	if (!block) return null;
	const cards = Array.isArray(body.cards) ? body.cards : [];
	const fromServer = Array.isArray(body.seen_keys) ? body.seen_keys : cards.map((card) =>
		card && typeof card === "object" ? (card as { dedupe_key?: unknown; seenKey?: unknown }).dedupe_key ?? (card as { seenKey?: unknown }).seenKey : null);
	const keys = Array.from(new Set(fromServer.filter((key): key is string => typeof key === "string" && key.length > 0)));
	return { block, keys, cards: cards.length };
}

/**
 * A 400 for one of these says DevSpec could not tell which project this turn is
 * for from what was sent. Asking again with the same facts gets the same answer,
 * so the conversation remembers it as a miss for that scope. A passing failure
 * (`project_selection_unavailable`) or a malformed request is not about scope.
 */
export function isScopeMiss(status: number, code: unknown): boolean {
	if (status !== 400) return false;
	return typeof code === "string" && code !== "invalid_request" && code !== "project_selection_unavailable";
}

/** One fingerprint per project scope, so a different scope (a pin, a remote, a bond) asks again. */
export function scopeFingerprint(endpoint: string, scope: Record<string, unknown>): string {
	const fields = ["connection", "connection_id", "project_id", "pinned_project_id", "git_remote"]
		.map((key) => `${key}=${typeof scope[key] === "string" ? scope[key] : ""}`);
	return [endpoint, ...fields].join("|");
}
