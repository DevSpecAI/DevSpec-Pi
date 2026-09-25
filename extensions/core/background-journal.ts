import { projectBackgroundTask, type ObservedBackgroundTask } from "./background-observer.ts";

/** Non-context session entries: observation only, never executable authority. */
export const BACKGROUND_WORK_ENTRY = "devspec-background-observation";
export interface BackgroundWorkScope {
	nativeSessionId: string;
	connectionId: string;
	sessionId: string;
	attachmentId: string;
}
export interface BackgroundWorkEntry {
	version: 1;
	scope: BackgroundWorkScope;
	task: ObservedBackgroundTask;
}
const scopeFields = ["nativeSessionId", "connectionId", "sessionId", "attachmentId"] as const;
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function backgroundScopeKey(scope: BackgroundWorkScope): string {
	return JSON.stringify(scopeFields.map(field => scope[field]));
}

/** Copy an allowlist only; never persist the provider's full snapshot. */
export function backgroundWorkEntry(scope: BackgroundWorkScope, task: ObservedBackgroundTask): BackgroundWorkEntry {
	return {
		version: 1,
		scope: { nativeSessionId: scope.nativeSessionId, connectionId: scope.connectionId, sessionId: scope.sessionId, attachmentId: scope.attachmentId },
		task: { id: task.id, startTime: task.startTime, state: task.state },
	};
}

function parseEntry(value: unknown): BackgroundWorkEntry | null {
	const row = record(value);
	const scope = record(row?.scope);
	const task = record(row?.task);
	if (row?.version !== 1 || !scope || !task ||
		Object.keys(row).some(key => !["version", "scope", "task"].includes(key)) ||
		Object.keys(scope).some(key => !(scopeFields as readonly string[]).includes(key)) ||
		Object.keys(task).some(key => !["id", "startTime", "state"].includes(key)) ||
		scopeFields.some(field => typeof scope[field] !== "string" || !scope[field] || (scope[field] as string).length > 256)) return null;
	const projected = projectBackgroundTask({ id: task.id, startTime: task.startTime, status: task.state === "unknown" ? "running" : task.state });
	if (!projected) return null;
	if (task.state === "unknown") projected.state = "unknown";
	return backgroundWorkEntry(scope as unknown as BackgroundWorkScope, projected);
}

/**
 * Pass getBranch(), never every entry in the file: abandoned branches and other
 * attachments cannot donate work. Restoration proves only ownership. A formerly
 * running task is unknown until the current provider confirms it; terminal rows
 * cannot be resurrected by delayed running snapshots or duplicate launch rows.
 */
export function restoreBackgroundWork(entries: readonly unknown[], scope: BackgroundWorkScope): ObservedBackgroundTask[] {
	const key = backgroundScopeKey(scope);
	const tasks = new Map<string, ObservedBackgroundTask>();
	for (const value of entries) {
		const row = record(value);
		if (row?.type !== "custom" || row.customType !== BACKGROUND_WORK_ENTRY) continue;
		const entry = parseEntry(row.data);
		if (!entry || backgroundScopeKey(entry.scope) !== key) continue;
		const previous = tasks.get(entry.task.id);
		if (previous && (previous.startTime !== entry.task.startTime || !["running", "unknown"].includes(previous.state))) continue;
		tasks.set(entry.task.id, entry.task);
	}
	return [...tasks.values()].filter(task => task.state === "running" || task.state === "unknown")
		.map(task => ({ id: task.id, startTime: task.startTime, state: "unknown" }));
}
