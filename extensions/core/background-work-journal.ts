import { OwnedBackgroundTasks, parseBackgroundTaskStatus, type BackgroundObservation, type BackgroundTaskStatus } from "./background-work.ts";
import type { WorkSpan } from "./runtime-work.ts";

export const BACKGROUND_WORK_JOURNAL = "devspec-background-origin-v1";
export type BackgroundProvider = "background-tasks" | "subagents";
export interface BackgroundOrigin {
	localSessionId: string;
	connectionId: string;
	sourceSessionId: string | null;
	/** Immutable launch epoch, NOT the current observer's authority. */
	generation: string;
	attachedAt: string | null;
	commandMessageId?: string;
	commandTurnId?: string;
	requesterUserId?: string;
	/** Exact successful claim IDs observed in this originating turn only. */
	workClaimIds: string[];
	span: WorkSpan;
}
export interface BackgroundOriginEntry { version: 1; provider: BackgroundProvider; task: BackgroundTaskStatus; origin: BackgroundOrigin }
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && v === v.trim();
const BACKGROUND_TOOLS = new Set(["bg_run", "bg_run_pi_attested", "bg_delegate", "fusion_reason", "fusion_investigate", "fusion_research", "fusion_validate"]);

/** Use public getAllTools() names and our scoped journal, never private listeners/processes. */
export function needsBackgroundProviderStatus(provider: BackgroundProvider, configuredTools: readonly string[], hasJournaledWork: boolean): boolean {
	return hasJournaledWork || configuredTools.some(name => provider === "subagents" ? name === "subagent" : BACKGROUND_TOOLS.has(name));
}

/** Successful launch receipts, not status/log result shapes or notification flags. */
export function ownedBackgroundLaunch(tool: string, value: unknown, isError: boolean): { provider: BackgroundProvider; task: BackgroundTaskStatus } | null {
	if (isError) return null;
	const details = record(record(value)?.details);
	if (BACKGROUND_TOOLS.has(tool)) {
		const task = parseBackgroundTaskStatus(details?.task);
		return task ? { provider: "background-tasks", task } : null;
	}
	if (tool === "subagent" && id(details?.asyncId)) return { provider: "subagents", task: { id: details.asyncId, status: "running" } };
	return null;
}

/** Structured notification identity only. Legacy subagent-notify has NO such DTO. */
export function structuredBackgroundWake(customType: string | null, details: unknown): { provider: BackgroundProvider; taskIds: string[] } | null {
	if (customType !== "background-task-notification") return null;
	const task = parseBackgroundTaskStatus(details);
	return task && task.status !== "running" ? { provider: "background-tasks", taskIds: [task.id] } : null;
}

export class BackgroundWorkJournal {
	private readonly tasks = { "background-tasks": new OwnedBackgroundTasks<BackgroundOrigin>(), subagents: new OwnedBackgroundTasks<BackgroundOrigin>() };
	private readonly entries = new Map<string, BackgroundOriginEntry>();
	private readonly append: (entry: BackgroundOriginEntry) => void;
	constructor(append: (entry: BackgroundOriginEntry) => void) { this.append = append; }

	restore(entries: readonly unknown[], localSessionId: string): void {
		for (const value of entries) {
			const entry = record(value);
			if (entry?.type !== "custom" || entry.customType !== BACKGROUND_WORK_JOURNAL) continue;
			const data = record(entry.data), origin = record(data?.origin), span = record(origin?.span);
			const task = parseBackgroundTaskStatus(data?.task);
			if (data?.version !== 1 || (data.provider !== "background-tasks" && data.provider !== "subagents") || !task ||
				origin?.localSessionId !== localSessionId || !id(origin.connectionId) || !(origin.sourceSessionId === null || id(origin.sourceSessionId)) || !id(origin.generation) ||
				!span || !id(span.id) || typeof span.startedAt !== "string" || !Number.isFinite(Date.parse(span.startedAt)) ||
				!(origin.attachedAt === null || typeof origin.attachedAt === "string" && Number.isFinite(Date.parse(origin.attachedAt))) ||
				[origin.commandMessageId, origin.commandTurnId, origin.requesterUserId].some(v => v !== undefined && !id(v)) ||
				!Array.isArray(origin.workClaimIds) || origin.workClaimIds.length > 128 || origin.workClaimIds.some(v => !id(v))) continue;
			const typed = data as unknown as BackgroundOriginEntry;
			const key = `${typed.provider}:${task.id}`;
			if (!this.entries.has(key)) this.launch(typed.provider, task, typed.origin, false);
			else if (task.status !== "running") this.terminal(typed.provider, task, false);
		}
	}
	launch(provider: BackgroundProvider, task: BackgroundTaskStatus, origin: BackgroundOrigin, persist = true): void {
		if (origin.workClaimIds.length > 128) return;
		// Retain only bounded provenance, never extra provider fields supplied by
		// a structurally compatible object or a restored session entry.
		const captured: BackgroundOrigin = {
			localSessionId: origin.localSessionId, connectionId: origin.connectionId, sourceSessionId: origin.sourceSessionId,
			generation: origin.generation, attachedAt: origin.attachedAt, span: { id: origin.span.id, startedAt: origin.span.startedAt },
			workClaimIds: [...origin.workClaimIds],
			...(origin.commandMessageId ? { commandMessageId: origin.commandMessageId } : {}),
			...(origin.commandTurnId ? { commandTurnId: origin.commandTurnId } : {}),
			...(origin.requesterUserId ? { requesterUserId: origin.requesterUserId } : {}),
		};
		if (!this.tasks[provider].launch(task, captured)) return;
		const entry: BackgroundOriginEntry = { version: 1, provider, task: { id: task.id, status: this.tasks[provider].statusFor(task.id)! }, origin: captured };
		this.entries.set(`${provider}:${task.id}`, entry);
		if (persist) this.append(entry);
	}
	terminal(provider: BackgroundProvider, task: BackgroundTaskStatus, persist = true): void {
		this.tasks[provider].terminal(task);
		const entry = this.entries.get(`${provider}:${task.id}`);
		if (!entry || entry.task.status !== "running" || task.status === "running") return;
		entry.task = { ...task };
		if (persist) this.append(structuredClone(entry));
	}
	origin(provider: BackgroundProvider, taskId: string): BackgroundOrigin | undefined {
		const origin = this.tasks[provider].scopeFor(taskId);
		return origin ? structuredClone(origin) : undefined;
	}
	ownsAny(provider: BackgroundProvider): boolean { return [...this.entries.values()].some(e => e.provider === provider); }
	observe(provider: BackgroundProvider, snapshot: BackgroundTaskStatus[] | null, scope: { localSessionId: string; connectionId: string; sourceSessionId: string | null }): { observation: BackgroundObservation; span?: WorkSpan } {
		const belongs = (origin: BackgroundOrigin) => origin.localSessionId === scope.localSessionId && origin.connectionId === scope.connectionId && origin.sourceSessionId === scope.sourceSessionId;
		for (const task of snapshot ?? []) if (task.status !== "running") this.terminal(provider, task);
		const observation = this.tasks[provider].observe(snapshot, belongs);
		// Revalidation: only a fresh exact ROOT status may restore its journaled
		// origin span. Unknown counts, timestamps and opaque fleet keys cannot.
		const confirmed = (snapshot ?? []).filter(task => task.status === "running")
			.map(task => this.entries.get(`${provider}:${task.id}`))
			.filter((entry): entry is BackgroundOriginEntry => Boolean(entry && entry.task.status === "running" && belongs(entry.origin)));
		const span = confirmed.map(e => e.origin.span).sort((a,b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
		return { observation, ...(span ? { span: { ...span } } : {}) };
	}
}
