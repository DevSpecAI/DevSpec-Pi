import { randomUUID } from "node:crypto";
import type { BackgroundObservation } from "./background-work.ts";

export interface RuntimeWorkScope {
	generation: string;
	session_id: string | null;
	attached_at: string | null;
}
export interface WorkSpan { id: string; startedAt: string }
export interface RuntimeWorkReport extends RuntimeWorkScope {
	revision: number;
	foreground_execution_id: string | null;
	foreground_state: "working" | "idle" | "unknown";
	background_state: "known" | "unknown";
	background_active_count: number;
	work_span_id: string | null;
	work_started_at: string | null;
}
export interface RuntimeWorkFence { epoch: number; execution: number }
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
export function runtimeWorkScopeFromResult(raw: unknown): RuntimeWorkScope | null {
	const scope = record(record(record(record(raw)?._meta)?.devspec)?.runtime_work_scope);
	if (!scope || scope.version !== 1 || !uuid(scope.generation) || !(scope.session_id === null || uuid(scope.session_id)) ||
		!(scope.attached_at === null || typeof scope.attached_at === "string" && Number.isFinite(Date.parse(scope.attached_at)))) return null;
	return { generation: scope.generation, session_id: scope.session_id as string | null, attached_at: scope.attached_at as string | null };
}

/** Identified observation, never permission. Capture fences BEFORE awaited host/provider work. */
export class RuntimeWorkState {
	private scope: RuntimeWorkScope | null = null;
	private connectionId: string | null = null;
	private epoch = 0;
	private execution = 0;
	private revision = 0;
	private executionId: string | null = null;
	private foreground: RuntimeWorkReport["foreground_state"] = "idle";
	private background: BackgroundObservation = { state: "unknown", activeCount: 0 };
	private span: WorkSpan | null = null;
	/** Same five-minute proof horizon as the server; unknown never renews it. */
	private backgroundProofExpiresAt: number | null = null;
	private backgroundObservedAt: number | null = null;
	private lastIdleAt: number | null = null;
	private readonly now: () => number;
	constructor(now: () => number = Date.now) { this.now = now; }

	setScope(scope: RuntimeWorkScope | null, connectionId: string | null): boolean {
		if (connectionId === this.connectionId && JSON.stringify(scope) === JSON.stringify(this.scope)) return false;
		const sameBinding = connectionId === this.connectionId && this.scope?.session_id === scope?.session_id;
		const continuingForeground = sameBinding && this.foreground === "working";
		if (!sameBinding) {
			this.lastIdleAt = null;
			if (this.scope) { this.foreground = "unknown"; this.executionId = null; this.execution++; }
		}
		this.connectionId = connectionId;
		this.scope = scope ? { ...scope } : null;
		this.epoch++; this.revision = 0;
		this.background = { state: "unknown", activeCount: 0 };
		this.backgroundProofExpiresAt = null;
		this.backgroundObservedAt = null;
		// An actually continuous local foreground is fresh same-work evidence.
		// Background-only restoration needs a fresh exact-root status instead.
		if (!continuingForeground) this.span = null;
		if (this.foreground === "working") this.ensureSpan();
		return true;
	}
	capture(): RuntimeWorkFence { return { epoch: this.epoch, execution: this.execution }; }
	isCurrent(fence: RuntimeWorkFence): boolean { return fence.epoch === this.epoch && fence.execution === this.execution; }
	begin(): RuntimeWorkFence {
		this.discardUnsupportedSpan();
		this.execution++;
		this.executionId ??= randomUUID(); // retry/compaction does not invent a new logical run
		this.foreground = "working";
		this.ensureSpan();
		return this.capture();
	}
	finish(fence: RuntimeWorkFence): boolean {
		if (!this.isCurrent(fence)) return false;
		this.executionId = null; this.foreground = "idle";
		this.expireBackgroundObservation();
		this.discardUnsupportedSpan();
		this.endKnownIdleSpan();
		return true;
	}
	observeBackground(fence: RuntimeWorkFence, observation: BackgroundObservation, revalidatedSpan?: WorkSpan): boolean {
		if (!this.isCurrent(fence)) return false;
		this.background = { ...observation };
		this.backgroundObservedAt = this.now();
		if (observation.activeCount > 0) this.backgroundProofExpiresAt = this.now() + 5 * 60_000;
		else if (observation.state === "known") this.backgroundProofExpiresAt = null;
		if (observation.activeCount > 0) {
			if (revalidatedSpan && Number.isFinite(Date.parse(revalidatedSpan.startedAt)) && Date.parse(revalidatedSpan.startedAt) <= this.now() &&
				(this.lastIdleAt === null || Date.parse(revalidatedSpan.startedAt) > this.lastIdleAt)) {
				if (!this.span || Date.parse(revalidatedSpan.startedAt) < Date.parse(this.span.startedAt)) this.span = { ...revalidatedSpan };
			}
			this.ensureSpan();
		}
		this.endKnownIdleSpan();
		return true;
	}
	currentSpan(): WorkSpan | null { this.discardUnsupportedSpan(); return this.span ? { ...this.span } : null; }
	currentExecutionId(): string | null { return this.executionId; }
	isWorking(): boolean { this.expireBackgroundObservation(); return this.foreground === "working" || this.background.activeCount > 0; }
	/** Called synchronously at send capture. An old request can only carry an older revision. */
	report(): RuntimeWorkReport | null {
		if (!this.scope) return null;
		this.expireBackgroundObservation();
		this.discardUnsupportedSpan();
		return { ...this.scope, revision: ++this.revision,
			foreground_execution_id: this.executionId, foreground_state: this.foreground,
			background_state: this.background.state, background_active_count: this.background.activeCount,
			work_span_id: this.span?.id ?? null, work_started_at: this.span?.startedAt ?? null };
	}
	private expireBackgroundObservation(): void {
		if (this.backgroundObservedAt === null || this.now() - this.backgroundObservedAt >= 5 * 60_000) {
			this.background = { state: "unknown", activeCount: 0 };
		}
	}
	private discardUnsupportedSpan(): void {
		if (this.foreground !== "working" && (this.backgroundProofExpiresAt ?? 0) <= this.now()) this.span = null;
	}
	private ensureSpan(): void { this.span ??= { id: randomUUID(), startedAt: new Date(this.now()).toISOString() }; }
	private endKnownIdleSpan(): void {
		if (this.foreground === "idle" && this.background.state === "known" && this.background.activeCount === 0) {
			this.span = null;
			this.lastIdleAt = this.now();
		}
	}
}
