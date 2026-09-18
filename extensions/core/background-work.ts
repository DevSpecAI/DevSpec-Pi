import { randomUUID } from "node:crypto";
import type { SubagentEventBus } from "./subagent-fleet.ts";

const REQUEST = "pi-background-tasks:request:v1";
const RESPONSE = "pi-background-tasks:response:v1";
const TERMINAL = "pi-background-tasks:terminal:v1";
const MAX_TASKS = 4096;

export type BackgroundTaskState = "running" | "completed" | "failed" | "killed";
/** Provider-local identity only. Never send this DTO to DevSpec or the model. */
export interface BackgroundTaskStatus { id: string; status: BackgroundTaskState }
/** Confirmed owned root count; unknown coverage makes this a lower bound, not a total. */
export interface BackgroundObservation { state: "known" | "unknown"; activeCount: number }

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseBackgroundTaskStatus(value: unknown): BackgroundTaskStatus | null {
	const task = record(value);
	if (!task || typeof task.id !== "string" || !task.id || task.id.length > 200 || task.id !== task.id.trim()) return null;
	if (task.status !== "running" && task.status !== "completed" && task.status !== "failed" && task.status !== "killed") return null;
	return { id: task.id, status: task.status };
}

/** Public observational API only: never launches, kills, reads logs, or delivers messages. */
export class BackgroundTaskStatusClient {
	private readonly stops = new Set<() => void>();
	private readonly pending = new Map<string, (value: unknown) => void>();
	private disposed = false;
	private readonly events: SubagentEventBus;
	private readonly timeoutMs: number;

	constructor(events: SubagentEventBus, onTerminal: (task: BackgroundTaskStatus) => void, timeoutMs = 250) {
		this.events = events;
		this.timeoutMs = timeoutMs;
		const responseStop = events.on(RESPONSE, (value) => {
			const response = record(value);
			if (response?.schema_version !== "pi-background-tasks.extension-response.v1" || typeof response.request_id !== "string") return;
			this.pending.get(response.request_id)?.(response);
		});
		const terminalStop = events.on(TERMINAL, (value) => {
			const event = record(value);
			if (event?.schema_version !== "pi-background-tasks.extension-terminal.v1") return;
			const task = parseBackgroundTaskStatus(event.task);
			if (task && task.status !== "running") onTerminal(task);
		});
		if (responseStop) this.stops.add(responseStop);
		if (terminalStop) this.stops.add(terminalStop);
	}

	async status(): Promise<BackgroundTaskStatus[] | null> {
		const response = record(await this.request("status"));
		if (response?.ok !== true || response.operation !== "status") return null;
		const tasks = record(response.result)?.tasks;
		if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) return null;
		const parsed = tasks.map(parseBackgroundTaskStatus);
		if (parsed.some((task) => !task)) return null;
		const statuses = parsed as BackgroundTaskStatus[];
		if (new Set(statuses.map((task) => task.id)).size !== statuses.length) return null;
		return statuses;
	}

	dispose(): void {
		this.disposed = true;
		for (const finish of this.pending.values()) finish(null);
		for (const stop of this.stops) stop();
		this.stops.clear();
	}

	private request(operation: "status"): Promise<unknown> {
		if (this.disposed) return Promise.resolve(null);
		const requestId = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => finish(null), this.timeoutMs);
			const finish = (value: unknown) => {
				if (!this.pending.delete(requestId)) return;
				clearTimeout(timer);
				resolve(value);
			};
			this.pending.set(requestId, finish);
			try {
				this.events.emit(REQUEST, { schema_version: "pi-background-tasks.extension-request.v1", request_id: requestId, operation, payload: {} });
			} catch { finish(null); }
		});
	}
}

/**
 * Exact launch provenance and monotone terminal facts. A provider status response
 * cannot adopt another attachment's task or resurrect a terminal-before-receipt task.
 * Scope is caller-owned immutable data, not permission or a replicated job registry.
 */
export class OwnedBackgroundTasks<Scope> {
	private readonly owned = new Map<string, { scope: Scope; status: BackgroundTaskState }>();
	private readonly earlyTerminal = new Map<string, BackgroundTaskState>();
	private overflow = false;

	launch(task: BackgroundTaskStatus, scope: Scope): boolean {
		if (this.owned.has(task.id)) return false; // never reattribute an existing task
		if (this.owned.size >= MAX_TASKS) { this.overflow = true; return false; }
		this.owned.set(task.id, { scope, status: this.earlyTerminal.get(task.id) ?? task.status });
		this.earlyTerminal.delete(task.id);
		return true;
	}

	terminal(task: BackgroundTaskStatus): void {
		if (task.status === "running") return;
		const owned = this.owned.get(task.id);
		if (owned) owned.status = task.status;
		else if (this.earlyTerminal.size < MAX_TASKS) this.earlyTerminal.set(task.id, task.status);
		else this.overflow = true;
	}

	scopeFor(taskId: string): Scope | undefined { return this.owned.get(taskId)?.scope; }

	observe(snapshot: BackgroundTaskStatus[] | null, belongs: (scope: Scope) => boolean): BackgroundObservation {
		if (snapshot === null) return { state: "unknown", activeCount: 0 };
		const statuses = new Map(snapshot.map((task) => [task.id, task.status]));
		let incomplete = this.overflow || snapshot.some((task) => task.status === "running" && !this.owned.has(task.id));
		let activeCount = 0;
		for (const [id, task] of this.owned) {
			if (!belongs(task.scope) || task.status !== "running") continue;
			const status = statuses.get(id);
			// A missing record might have been pruned or be unavailable; absence is
			// not a terminal event. Never manufacture successful completion.
			if (!status) { incomplete = true; continue; }
			if (status === "running") activeCount++;
			else task.status = status;
		}
		return { state: incomplete ? "unknown" : "known", activeCount };
	}
}
