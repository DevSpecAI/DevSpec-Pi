import { randomUUID } from "node:crypto";

// db495c8f: observe the provider, never the model's consumption of a notice.
// Public API: pi-background-tasks/docs/api/eventbus-v1.md. No provider imports,
// task files, commands, output paths, prompt content or credentials are retained.
const REQUEST = "pi-background-tasks:request:v1";
const RESPONSE = "pi-background-tasks:response:v1";
const TERMINAL = "pi-background-tasks:terminal:v1";
const REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
const TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";
const LAUNCH_TOOLS = new Set([
	"bg_run", "bg_run_pi_attested", "bg_delegate", "fusion_reason",
	"fusion_investigate", "fusion_research", "fusion_validate",
]);

export interface BackgroundEventBus {
	on(event: string, handler: (value: unknown) => void): (() => void) | void;
	emit(event: string, value: unknown): void;
}

/** Opaque caller-owned native-session + attachment generation, not a room name. */
export type BackgroundScope = string;
export type ObservedTaskState = "running" | "unknown" | "completed" | "failed" | "killed";
export interface ObservedBackgroundTask {
	id: string;
	/** Provider launch identity protects against a stale response for a reused id. */
	startTime: number;
	state: ObservedTaskState;
}
export interface BackgroundObservation {
	scope: BackgroundScope | null;
	tasks: ObservedBackgroundTask[];
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : null;
}
function terminal(state: ObservedTaskState): boolean {
	return state === "completed" || state === "failed" || state === "killed";
}

/** Allowlist projection. Never spread a provider snapshot into shared state. */
export function projectBackgroundTask(value: unknown): ObservedBackgroundTask | null {
	const row = record(value);
	if (!row || typeof row.id !== "string" || !row.id || row.id.length > 200 || row.id.trim() !== row.id ||
		typeof row.startTime !== "number" || !Number.isSafeInteger(row.startTime) || row.startTime < 0 ||
		typeof row.status !== "string" || !["running", "completed", "failed", "killed"].includes(row.status)) return null;
	return { id: row.id, startTime: row.startTime, state: row.status as ObservedTaskState };
}

/** A successful launch proves ownership; inspection of someone else's task does not. */
export function backgroundTaskFromLaunch(toolName: string, result: unknown, isError = false): ObservedBackgroundTask | null {
	if (isError || !LAUNCH_TOOLS.has(toolName)) return null;
	const outer = record(result);
	const details = record(outer?.details) ?? outer;
	return projectBackgroundTask(details?.task);
}

/** Validated management results observe known work; they never establish ownership. */
export function backgroundTasksFromManagement(toolName: string, result: unknown, isError = false): ObservedBackgroundTask[] {
	if (isError || (toolName !== "bg_kill" && toolName !== "bg_status")) return [];
	const outer = record(result);
	const details = record(outer?.details) ?? outer;
	const values = toolName === "bg_kill" ? [details?.task] : details?.tasks;
	if (!Array.isArray(values)) return [];
	return values.map(projectBackgroundTask).filter((task): task is ObservedBackgroundTask => task !== null);
}

interface PendingRequest {
	operation: "capabilities" | "status";
	finish: (value: Record<string, unknown> | null) => void;
}

/**
 * Small observation adapter, not a task manager. Only explicitly registered
 * launches/restored identities belong here. A status listing is never authority
 * to adopt work. Missing, unavailable and malformed observations stay unknown.
 *
 * Caller drives refresh from its existing lifecycle/safety cadence. Terminal
 * events are immediate; no extra model turn, polling loop or server request.
 */
export class BackgroundWorkObserver {
	private scope: BackgroundScope | null = null;
	private epoch = 0;
	private supported = false;
	private disposed = false;
	private readonly tasks = new Map<string, ObservedBackgroundTask>();
	private readonly earlyTerminals = new Map<string, ObservedBackgroundTask>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly subscriptions: (() => void)[] = [];
	private inFlight: Promise<void> | null = null;
	private offset = 0;
	private readonly events: BackgroundEventBus;
	private readonly onChange: (observation: BackgroundObservation) => void;
	private readonly options: { timeoutMs?: number; batchSize?: number; concurrency?: number; earlyLimit?: number };

	constructor(
		events: BackgroundEventBus,
		onChange: (observation: BackgroundObservation) => void,
		options: { timeoutMs?: number; batchSize?: number; concurrency?: number; earlyLimit?: number } = {},
	) {
		this.events = events;
		this.onChange = onChange;
		this.options = options;
		for (const [name, handler] of [
			[RESPONSE, (value: unknown) => this.response(value)],
			[TERMINAL, (value: unknown) => this.terminalEvent(value)],
		] as const) {
			const stop = events.on(name, handler);
			if (typeof stop === "function") this.subscriptions.push(stop);
		}
	}

	/** A real attachment/session change revokes old observations and pending callbacks. */
	bind(scope: BackgroundScope | null): void {
		if (this.disposed || this.scope === scope) return;
		this.epoch += 1;
		this.scope = scope;
		this.supported = false;
		this.tasks.clear();
		this.earlyTerminals.clear();
		this.offset = 0;
		for (const request of [...this.pending.values()]) request.finish(null);
		this.inFlight = null;
		this.changed();
	}

	/** Caller captures scope when work launches, not when its tool result arrives. */
	track(task: ObservedBackgroundTask, scope: BackgroundScope): boolean {
		if (this.disposed || !this.scope || scope !== this.scope || !this.validIdentity(task)) return false;
		const old = this.tasks.get(task.id);
		if (old) {
			// Conflicting launch identities are not evidence the old work finished.
			if (old.startTime !== task.startTime) return false;
			this.apply(old, task.state);
			return true;
		}
		const early = this.earlyTerminals.get(task.id);
		const current: ObservedBackgroundTask = { id: task.id, startTime: task.startTime, state: task.state };
		if (early?.startTime === task.startTime) current.state = early.state;
		this.earlyTerminals.delete(task.id);
		this.tasks.set(task.id, current);
		this.changed();
		return true;
	}

	/** An inspection/terminal result can update only an already-owned execution. */
	observe(task: ObservedBackgroundTask, scope: BackgroundScope): boolean {
		const owned = this.tasks.get(task.id);
		if (this.disposed || scope !== this.scope || !owned || !this.validIdentity(task) || owned.startTime !== task.startTime) return false;
		this.apply(owned, task.state);
		return true;
	}

	snapshot(): BackgroundObservation {
		return { scope: this.scope, tasks: [...this.tasks.values()].map(task => ({ ...task })) };
	}

	/** Only explicit provider-terminal evidence removes an owned task from pending. */
	pendingIds(): string[] {
		return [...this.tasks.values()].filter(task => !terminal(task.state)).map(task => task.id);
	}

	refresh(): Promise<void> {
		if (this.disposed || !this.scope || this.pendingIds().length === 0) return Promise.resolve();
		if (this.inFlight) return this.inFlight;
		const epoch = this.epoch;
		const work = this.reconcile(epoch).finally(() => { if (this.epoch === epoch) this.inFlight = null; });
		this.inFlight = work;
		return work;
	}

	dispose(): void {
		if (this.disposed) return;
		this.bind(null);
		this.disposed = true;
		for (const stop of this.subscriptions) stop();
		this.subscriptions.length = 0;
	}

	private validIdentity(task: ObservedBackgroundTask): boolean {
		return typeof task.id === "string" && task.id.length > 0 && task.id.length <= 200 && task.id.trim() === task.id &&
			Number.isSafeInteger(task.startTime) && task.startTime >= 0 &&
			["running", "unknown", "completed", "failed", "killed"].includes(task.state);
	}

	private changed(): void {
		// A consumer fault must never poison the provider's terminal publication.
		try { this.onChange(this.snapshot()); } catch { /* next refresh still observes truth */ }
	}

	private apply(task: ObservedBackgroundTask, state: ObservedTaskState): void {
		// A delayed running/status result cannot resurrect terminal work.
		if (terminal(task.state) || task.state === state) return;
		task.state = state;
		this.changed();
	}

	private terminalEvent(value: unknown): void {
		if (this.disposed || !this.scope) return;
		const frame = record(value);
		if (frame?.schema_version !== TERMINAL_SCHEMA) return;
		const task = projectBackgroundTask(frame.task);
		if (!task || !terminal(task.state)) return;
		const owned = this.tasks.get(task.id);
		if (owned) {
			if (owned.startTime === task.startTime) this.apply(owned, task.state);
			return;
		}
		// A fast job may finish before tool_execution_end supplies its launch
		// receipt. Keep only bounded non-content metadata, never adopt it alone.
		this.earlyTerminals.set(task.id, task);
		const limit = Math.max(0, Math.min(256, this.options.earlyLimit ?? 64));
		while (this.earlyTerminals.size > limit) this.earlyTerminals.delete(this.earlyTerminals.keys().next().value!);
	}

	private response(value: unknown): void {
		const frame = record(value);
		if (frame?.schema_version !== RESPONSE_SCHEMA || typeof frame.request_id !== "string") return;
		const request = this.pending.get(frame.request_id);
		if (!request || frame.operation !== request.operation) return;
		request.finish(frame.ok === true ? record(frame.result) : null);
	}

	private request(operation: "capabilities" | "status", payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
		if (this.disposed || !this.scope) return Promise.resolve(null);
		return new Promise(resolve => {
			const id = randomUUID();
			const timer = setTimeout(() => finish(null), Math.max(1, Math.min(5_000, this.options.timeoutMs ?? 1_000)));
			const finish = (value: Record<string, unknown> | null) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timer);
				resolve(value);
			};
			this.pending.set(id, { operation, finish });
			try {
				this.events.emit(REQUEST, { schema_version: REQUEST_SCHEMA, request_id: id, operation, payload });
			} catch { finish(null); }
		});
	}

	private async reconcile(epoch: number): Promise<void> {
		const current = () => !this.disposed && epoch === this.epoch && this.scope !== null;
		if (!this.supported) {
			const capabilities = await this.request("capabilities", {});
			if (!current()) return;
			this.supported = capabilities?.api_version === 1 && capabilities.status === true;
			if (!this.supported) {
				for (const task of this.tasks.values()) this.apply(task, "unknown");
				return;
			}
		}
		const all = [...this.tasks.values()].filter(task => !terminal(task.state));
		if (!all.length) return;
		const size = Math.max(1, Math.min(64, this.options.batchSize ?? 32));
		const selected = Array.from({ length: Math.min(size, all.length) }, (_, i) => all[(this.offset + i) % all.length]!);
		this.offset = (this.offset + selected.length) % all.length;
		let next = 0;
		const worker = async () => {
			while (current() && next < selected.length) {
				const task = selected[next++]!;
				if (terminal(task.state)) continue;
				const result = await this.request("status", { taskId: task.id });
				if (!current() || this.tasks.get(task.id) !== task) return;
				const values = result?.tasks;
				const observed = Array.isArray(values) && values.length === 1 ? projectBackgroundTask(values[0]) : null;
				this.apply(task, observed?.id === task.id && observed.startTime === task.startTime ? observed.state : "unknown");
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, Math.min(4, this.options.concurrency ?? 4, selected.length)) }, worker));
	}
}
