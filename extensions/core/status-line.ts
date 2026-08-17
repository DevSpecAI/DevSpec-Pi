/**
 * DevSpec Pi — mechanical TUI footer (item 3aefe0f6).
 *
 * The footer already showed the bond codename. This module adds the rest of
 * what the process already knows: which room we are in, whether that room
 * still has a generated title, the claimed/dispatched item, a claimed
 * playbook, and the DevSpec verb currently executing. paintStatus also
 * retitles the OS terminal tab (session → playbook → untitled stand-in →
 * current action item → codename). Pure formatter + globalThis store — pi
 * loads each extension
 * file with a fresh jiti graph, so module singletons are not shared.
 *
 * sessionTitle is the REAL title only. First-message previews and the
 * literal "New session" placeholder never write there (same rule as the
 * web UI, item 23f4665f).
 */

import { TOOL_LOADER_NAME, isCallableModelVerb } from "./model-surface.ts";
import { safeHasUI, withLiveUi } from "./ctx-guard.ts";

export const STATUS_KEY = "devspec-remote";

const SESSION_TITLE_MAX = 28;
const SESSION_PREVIEW_MAX = 22;
const WORK_TITLE_MAX = 28;
const PLAYBOOK_NAME_MAX = 28;
const TERMINAL_TITLE_MAX = 48;
export const DEFAULT_TERMINAL_TITLE = "Pi";

export interface StatusSnapshot {
	codename?: string;
	sessionId?: string;
	/** Generated / user-set title only. Never a placeholder. */
	sessionTitle?: string;
	/** First-text stand-in while untitled. UI-only — not a title. */
	sessionPreview?: string;
	workId?: string;
	workTitle?: string;
	playbookId?: string;
	playbookRunId?: string;
	playbookName?: string;
	/** Currently executing DevSpec verb (MCP name). */
	verb?: string;
}

export interface StatusUi {
	hasUI?: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		setTitle?(title: string): void;
	};
}

interface LiveVerb {
	toolCallId: string;
	verb: string;
}

interface StatusStore {
	current: StatusSnapshot;
	live: LiveVerb[];
	lastUi: StatusUi | null;
}

const GLOBAL_KEY = "__devspecPiStatus";

function store(): StatusStore {
	const g = globalThis as unknown as Record<string, StatusStore | undefined>;
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = { current: {}, live: [], lastUi: null };
	}
	return g[GLOBAL_KEY] as StatusStore;
}

export function getStatusSnapshot(): StatusSnapshot {
	return { ...store().current };
}

export function resetStatus(): void {
	const s = store();
	s.current = {};
	s.live = [];
	s.lastUi = null;
}

export function patchStatus(patch: Partial<StatusSnapshot>): StatusSnapshot {
	const s = store();
	const next: StatusSnapshot = { ...s.current };
	for (const [key, value] of Object.entries(patch) as Array<[keyof StatusSnapshot, string | undefined]>) {
		if (value === undefined) delete next[key];
		else next[key] = value;
	}
	s.current = next;
	return { ...next };
}

/** A title the footer (and bond.sessionTitle) may treat as real. */
export function isRealSessionTitle(title: unknown): title is string {
	if (typeof title !== "string") return false;
	const trimmed = title.trim();
	return trimmed.length > 0 && trimmed !== "New session";
}

export function truncateLabel(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "";
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** First non-empty human text — a stand-in, never a title. */
export function firstTextPreview(messages: unknown, max = SESSION_PREVIEW_MAX): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const m = raw as {
			author?: { kind?: string };
			content?: string;
			message_type?: string;
		};
		if (m.message_type === "remote_control_started" || m.message_type === "remote_control_ended") {
			continue;
		}
		const kind = m.author?.kind;
		if (kind && kind !== "human") continue;
		const preview = truncateLabel(typeof m.content === "string" ? m.content : "", max);
		if (preview) return preview;
	}
	return undefined;
}

export function previewFromText(text: string, max = SESSION_PREVIEW_MAX): string | undefined {
	const preview = truncateLabel(text, max);
	return preview || undefined;
}

export function isDevspecVerb(toolName: string): boolean {
	return toolName === TOOL_LOADER_NAME || isCallableModelVerb(toolName);
}

/** Resolve the DevSpec verb a tool_execution event is running. */
export function resolveExecutingVerb(toolName: string, _args: unknown): string | undefined {
	return isDevspecVerb(toolName) ? toolName : undefined;
}

const VERB_LABELS: Record<string, string> = {
	claim_work_item: "claiming",
	record_implementation: "recording",
	create_action_item: "creating item",
	update_action_item: "updating item",
	search_action_items: "searching items",
	get_action_item: "reading item",
	get_action_items: "listing items",
	search_memories: "searching memories",
	get_memory: "reading memory",
	record_memory: "recording memory",
	search_resources: "searching docs",
	get_resource: "reading doc",
	resolve_action_item_conflict: "resolving conflict",
	resolve_action_item_decision_flag: "resolving decision flag",
	record_criterion_verdicts: "recording verdicts",
	get_session_transcript: "reading transcript",
	get_project_summary: "reading project",
	release_work_item: "releasing",
	fail_work_item: "failing item",
	report_progress: "reporting",
	verify_action_item: "verifying",
	reserve_work_items: "reserving work",
	claim_playbook_run: "claiming playbook",
	record_playbook_run: "recording playbook",
	get_playbook: "reading playbook",
	get_playbooks: "listing playbooks",
	get_playbook_runs: "listing playbook runs",
};

export function verbLabel(verb: string): string {
	if (VERB_LABELS[verb]) return VERB_LABELS[verb];
	const words = verb.replace(/_/g, " ").trim();
	return words || verb;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Best-effort id/title from a claim / get_action_item / dispatch payload. */
export function extractItemRef(value: unknown): { id?: string; title?: string } {
	const root = asRecord(value);
	if (!root) return {};
	if (root.details !== undefined) {
		const inner = extractItemRef(root.details);
		if (inner.id || inner.title) return inner;
	}
	const nested = asRecord(root.item) ?? asRecord(root.action_item) ?? root;
	const id =
		(typeof nested.id === "string" && nested.id) ||
		(typeof root.action_item_id === "string" && root.action_item_id) ||
		undefined;
	const title = typeof nested.title === "string" && nested.title.trim() ? nested.title.trim() : undefined;
	return { id, title };
}

export function extractPlaybookRef(value: unknown): {
	id?: string;
	runId?: string;
	name?: string;
} {
	const root = asRecord(value);
	if (!root) return {};
	if (root.details !== undefined) {
		const inner = extractPlaybookRef(root.details);
		if (inner.id || inner.runId || inner.name) return inner;
	}
	const playbook = asRecord(root.playbook);
	const run = asRecord(root.run);
	const name =
		(playbook && typeof playbook.name === "string" && playbook.name.trim() && playbook.name.trim()) ||
		(typeof root.playbook_name === "string" && root.playbook_name.trim() && root.playbook_name.trim()) ||
		(run && typeof run.playbook_name === "string" && run.playbook_name.trim() && run.playbook_name.trim()) ||
		undefined;
	const id =
		(playbook && typeof playbook.id === "string" && playbook.id) ||
		(typeof root.playbook_id === "string" && root.playbook_id) ||
		(run && typeof run.playbook_id === "string" && run.playbook_id) ||
		undefined;
	const runId =
		(typeof root.run_id === "string" && root.run_id) ||
		(run && typeof run.run_id === "string" && run.run_id) ||
		(run && typeof run.id === "string" && run.id) ||
		undefined;
	return { id, runId, name };
}

export function formatStatusLine(snap: StatusSnapshot): string | undefined {
	const codename = snap.codename?.trim();
	if (!codename && !snap.sessionId && !snap.workTitle && !snap.playbookName && !snap.verb) {
		return undefined;
	}

	const parts: string[] = [`⛁ ${codename || "bonded"}`];

	if (snap.sessionId) {
		if (isRealSessionTitle(snap.sessionTitle)) {
			parts.push(`“${truncateLabel(snap.sessionTitle, SESSION_TITLE_MAX)}”`);
		} else if (snap.sessionPreview) {
			parts.push(`untitled “${truncateLabel(snap.sessionPreview, SESSION_PREVIEW_MAX)}”`);
		} else {
			parts.push("untitled");
		}
	}

	if (snap.playbookName) {
		parts.push(`playbook “${truncateLabel(snap.playbookName, PLAYBOOK_NAME_MAX)}”`);
	}

	if (snap.workTitle) {
		parts.push(`“${truncateLabel(snap.workTitle, WORK_TITLE_MAX)}”`);
	}

	if (snap.verb) parts.push(verbLabel(snap.verb));

	return parts.join(" · ");
}

/** OS tab title. Session → playbook → untitled stand-in → current item → codename. */
export function formatTerminalTitle(snap: StatusSnapshot | null | undefined): string {
	if (
		!snap ||
		(!snap.codename && !snap.sessionId && !snap.playbookName && !snap.sessionPreview && !snap.workTitle)
	) {
		return DEFAULT_TERMINAL_TITLE;
	}
	if (isRealSessionTitle(snap.sessionTitle)) {
		return truncateLabel(snap.sessionTitle, TERMINAL_TITLE_MAX);
	}
	if (snap.playbookName) {
		return truncateLabel(snap.playbookName, TERMINAL_TITLE_MAX);
	}
	if (snap.sessionPreview) {
		return truncateLabel(snap.sessionPreview, TERMINAL_TITLE_MAX);
	}
	if (snap.workTitle) {
		return truncateLabel(snap.workTitle, TERMINAL_TITLE_MAX);
	}
	if (snap.codename?.trim()) return snap.codename.trim();
	return DEFAULT_TERMINAL_TITLE;
}

function syncLiveVerb(): void {
	const s = store();
	const latest = s.live[s.live.length - 1];
	patchStatus({ verb: latest?.verb });
}

export function noteVerbStart(toolCallId: string, toolName: string, args: unknown): void {
	const verb = resolveExecutingVerb(toolName, args);
	if (!verb) return;
	const s = store();
	s.live = s.live.filter((v) => v.toolCallId !== toolCallId);
	s.live.push({ toolCallId, verb });
	syncLiveVerb();
}

export function noteVerbEnd(toolCallId: string): void {
	const s = store();
	s.live = s.live.filter((v) => v.toolCallId !== toolCallId);
	syncLiveVerb();
}

export function noteWork(ref: { id?: string; title?: string }): void {
	if (!ref.id && !ref.title) return;
	patchStatus({
		workId: ref.id,
		workTitle: ref.title,
	});
}

export function clearWork(id?: string): void {
	const current = store().current;
	if (id && current.workId && current.workId !== id) return;
	patchStatus({ workId: undefined, workTitle: undefined });
}

export function notePlaybook(ref: { id?: string; runId?: string; name?: string }): void {
	if (!ref.id && !ref.runId && !ref.name) return;
	patchStatus({
		playbookId: ref.id,
		playbookRunId: ref.runId,
		playbookName: ref.name,
	});
}

export function clearPlaybook(id?: string): void {
	const current = store().current;
	if (id && current.playbookRunId && current.playbookRunId !== id && current.playbookId !== id) {
		return;
	}
	patchStatus({ playbookId: undefined, playbookRunId: undefined, playbookName: undefined });
}

/** Apply bond identity into the snapshot. Session change drops the old preview. */
export function syncBondIntoStatus(bond: {
	codename?: string;
	sessionId?: string;
	sessionTitle?: string;
} | null): void {
	if (!bond) {
		resetStatus();
		return;
	}
	const prev = store().current;
	const sessionChanged = (prev.sessionId ?? undefined) !== (bond.sessionId ?? undefined);
	const realTitle = isRealSessionTitle(bond.sessionTitle) ? bond.sessionTitle.trim() : undefined;
	patchStatus({
		codename: bond.codename,
		sessionId: bond.sessionId,
		sessionTitle: realTitle,
		...((sessionChanged || realTitle) ? { sessionPreview: undefined } : {}),
	});
}

export function setSessionPreview(preview: string | undefined): void {
	const current = store().current;
	if (isRealSessionTitle(current.sessionTitle)) return;
	patchStatus({ sessionPreview: preview });
}

export function paintStatus(ctx?: StatusUi | null): void {
	const s = store();
	if (ctx) {
		if (safeHasUI(ctx)) s.lastUi = ctx;
		else if (s.lastUi === ctx) s.lastUi = null;
	}
	const target = ctx && safeHasUI(ctx) ? ctx : s.lastUi;
	if (!target || !safeHasUI(target)) {
		if (target && s.lastUi === target) s.lastUi = null;
		return;
	}
	withLiveUi(target, () => {
		target.ui.setStatus(STATUS_KEY, formatStatusLine(s.current));
		target.ui.setTitle?.(formatTerminalTitle(s.current));
	});
}
