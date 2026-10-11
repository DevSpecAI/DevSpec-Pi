/**
 * DevSpec Pi — mechanical TUI footer (item 3aefe0f6).
 *
 * The footer already showed the bond codename. This module adds the rest of
 * what the process already knows: which room we are in, whether that room
 * still has a generated title, the locally selected/claimed item, a claimed
 * automation, and the DevSpec verb currently executing. paintStatus also
 * retitles the OS terminal tab (session → automation → untitled stand-in →
 * current action item → codename). Pure formatter + globalThis store — pi
 * loads each extension
 * file with a fresh jiti graph, so module singletons are not shared.
 *
 * sessionTitle is the REAL title only. First-message previews and the
 * literal "New session" placeholder never write there (same rule as the
 * web UI, item 23f4665f).
 */

import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { TOOL_LOADER_NAME, isCallableModelVerb } from "./model-surface.ts";
import { safeHasUI, withLiveUi } from "./ctx-guard.ts";

export const STATUS_KEY = "devspec-remote";

const SESSION_PREVIEW_MAX = 22;
const TERMINAL_TITLE_MAX = 48;
export const DEFAULT_TERMINAL_TITLE = "Pi";

export interface StatusSnapshot {
	codename?: string;
	/** Readable name from the confirmed bond, never a folder guess or ID fallback. */
	projectName?: string;
	sessionId?: string;
	/** Generated / user-set title only. Never a placeholder. */
	sessionTitle?: string;
	/** First-text stand-in while untitled. UI-only — not a title. */
	sessionPreview?: string;
	workId?: string;
	workTitle?: string;
	automationId?: string;
	automationRunId?: string;
	automationName?: string;
	/** Currently executing DevSpec verb (MCP name). */
	verb?: string;
}

export interface StatusUi {
	hasUI?: boolean;
	mode?: string;
	ui: {
		setWidget?: ExtensionUIContext["setWidget"];
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
	withLiveUi(s.lastUi, () => {
		s.lastUi?.ui.setWidget?.(STATUS_KEY, undefined);
		s.lastUi?.ui.setStatus(STATUS_KEY, undefined);
	});
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
	const flat = stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim();
	return stripVTControlCharacters(truncateToWidth(flat, Math.max(0, max), "…"));
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
	supersede_action_item: "superseding",
	preview_supersession: "previewing supersession",
	record_criterion_verdicts: "recording verdicts",
	get_session_transcript: "reading transcript",
	search_sessions: "searching sessions",
	search_discussion_points: "searching still to discuss",
	get_discussion_point: "reading discussion point",
	manage_discussion_point: "updating still to discuss",
	get_project_summary: "reading project",
	release_work_item: "releasing",
	fail_work_item: "failing item",
	report_progress: "reporting",
	verify_action_item: "verifying",
	reserve_work_items: "reserving work",
	claim_automation_run: "claiming automation",
	record_automation_run: "recording automation",
	get_automation: "reading automation",
	get_automations: "listing automations",
	get_automation_runs: "listing automation runs",
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

/** Best-effort id/title from a claim or get_action_item payload. */
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

export function extractAutomationRef(value: unknown): {
	id?: string;
	runId?: string;
	name?: string;
} {
	const root = asRecord(value);
	if (!root) return {};
	if (root.details !== undefined) {
		const inner = extractAutomationRef(root.details);
		if (inner.id || inner.runId || inner.name) return inner;
	}
	const automation = asRecord(root.automation);
	const run = asRecord(root.run);
	const name =
		(automation && typeof automation.name === "string" && automation.name.trim() && automation.name.trim()) ||
		(typeof root.automation_name === "string" && root.automation_name.trim() && root.automation_name.trim()) ||
		(run && typeof run.automation_name === "string" && run.automation_name.trim() && run.automation_name.trim()) ||
		undefined;
	const id =
		(automation && typeof automation.id === "string" && automation.id) ||
		(typeof root.automation_id === "string" && root.automation_id) ||
		(run && typeof run.automation_id === "string" && run.automation_id) ||
		undefined;
	const runId =
		(typeof root.run_id === "string" && root.run_id) ||
		(run && typeof run.run_id === "string" && run.run_id) ||
		(run && typeof run.id === "string" && run.id) ||
		undefined;
	return { id, runId, name };
}

export type StatusTextStyle = (role: "text" | "dim", text: string) => string;

export function formatStatusLine(snap: StatusSnapshot, width = Infinity, style: StatusTextStyle = (_role, text) => text): string | undefined {
	if (!snap.codename && !snap.sessionId && !snap.workTitle && !snap.automationName && !snap.verb) return undefined;

	// No fixed title caps: take the full row when it fits. Under pressure,
	// shorten project, work, then session; never abbreviate the agent identity.
	const fields: Array<{ text: string; columns: number; prefix: string; suffix: string; priority: number; role: "text" | "dim" }> = [];
	function add(text: string, priority: number, prefix = "", suffix = "", role: "text" | "dim" = "text") {
		const clean = truncateLabel(text, Infinity);
		if (clean) fields.push({ text: clean, columns: visibleWidth(clean), prefix, suffix, priority, role });
	}
	add(snap.codename?.trim() || "connected", Infinity);
	if (snap.projectName) add(snap.projectName, 0, "", "", "dim");
	if (snap.sessionId) {
		if (isRealSessionTitle(snap.sessionTitle)) add(snap.sessionTitle, 3, "“", "”");
		else if (snap.sessionPreview) add(snap.sessionPreview, 3, "untitled “", "”", "dim");
		else add("untitled", 3, "", "", "dim");
	}
	if (snap.automationName) add(snap.automationName, 1, "automation “", "”");
	if (snap.workTitle) add(snap.workTitle, 1, "“", "”");
	if (snap.verb) add(verbLabel(snap.verb), 2, "", "", "dim");
	// Allocate width on plain text, then style individual roles. Never wrap the
	// entire row in dim: identity/current work must use the reader's foreground.
	const render = (styled = false) => {
		const paint: StatusTextStyle = (role, text) => styled && text ? style(role, text) : text;
		return paint("text", "DevSpec: ") + fields.filter(f => f.columns > 0)
			.map(f => paint("dim", f.prefix) + paint(f.role, truncateLabel(f.text, f.columns)) + paint("dim", f.suffix))
			.join(paint("dim", " · "));
	};
	let line = render();
	const shrinkable = fields.filter(f => Number.isFinite(f.priority)).sort((a, b) => a.priority - b.priority);
	for (const field of shrinkable) {
		const excess = visibleWidth(line) - width;
		if (excess <= 0) break;
		field.columns = Math.max(1, field.columns - excess);
		line = render();
	}
	// Extremely narrow terminals may not fit even the abbreviated fields.
	// Drop them in the same order; the widget wraps identity only if necessary.
	for (const field of shrinkable) {
		if (visibleWidth(line) <= width) break;
		field.columns = 0;
		line = render();
	}
	return render(true);
}

/** OS tab title. Session → automation → untitled stand-in → current item → codename. */
export function formatTerminalTitle(snap: StatusSnapshot | null | undefined): string {
	if (
		!snap ||
		(!snap.codename && !snap.sessionId && !snap.automationName && !snap.sessionPreview && !snap.workTitle)
	) {
		return DEFAULT_TERMINAL_TITLE;
	}
	if (isRealSessionTitle(snap.sessionTitle)) {
		return truncateLabel(snap.sessionTitle, TERMINAL_TITLE_MAX);
	}
	if (snap.automationName) {
		return truncateLabel(snap.automationName, TERMINAL_TITLE_MAX);
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

export function noteAutomation(ref: { id?: string; runId?: string; name?: string }): void {
	if (!ref.id && !ref.runId && !ref.name) return;
	patchStatus({
		automationId: ref.id,
		automationRunId: ref.runId,
		automationName: ref.name,
	});
}

export function clearAutomation(id?: string): void {
	const current = store().current;
	if (id && current.automationRunId && current.automationRunId !== id && current.automationId !== id) {
		return;
	}
	patchStatus({ automationId: undefined, automationRunId: undefined, automationName: undefined });
}

/** Apply bond identity into the snapshot. Session change drops the old preview. */
export function syncBondIntoStatus(bond: {
	codename?: string;
	projectId?: string;
	projectName?: string;
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
		projectName: bond.projectName?.trim() && bond.projectName.trim() !== bond.projectId ? bond.projectName : undefined,
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
		const snapshot = { ...s.current };
		if (target.mode === "tui" && target.ui.setWidget) {
			// Native widget placement gives DevSpec its own width without replacing
			// Pi's footer or sharing the BG/MCP extension-status row (b8f94798).
			target.ui.setStatus(STATUS_KEY, undefined);
			if (formatStatusLine(snapshot)) {
				target.ui.setWidget(STATUS_KEY, (_tui, theme) => ({
					invalidate() {},
					render(width) {
						if (width < 1) return [];
						return wrapTextWithAnsi(formatStatusLine(snapshot, width, (role, text) => theme.fg(role, text)) ?? "", width);
					},
				}), { placement: "belowEditor" });
			} else target.ui.setWidget(STATUS_KEY, undefined);
		} else {
			// RPC exposes text status, not custom terminal components.
			target.ui.setStatus(STATUS_KEY, formatStatusLine(snapshot));
		}
		target.ui.setTitle?.(formatTerminalTitle(snapshot));
	});
}
