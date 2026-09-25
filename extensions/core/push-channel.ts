/**
 * DevSpec Pi — push channel client (SSE wake stream).
 *
 * Client for GET /api/mcp/connection-stream (devspecv2, item 0026da9f).
 * The stream emits wake/ended/hello frames; the client fetches the packaged
 * turn via poll_connection on wake (wake+fetch — packaging stays server-side
 * in ONE place). Falls back to the held long-poll when the channel is
 * unavailable (older server, proxy that buffers SSE, etc).
 */

import { randomUUID } from "node:crypto";

export interface PushChannelHandlers {
	/** A wake frame arrived — something moved; fetch now. */
	onWake(): void;
	/** The server tore the connection down (carries end_reason). */
	onEnded(endReason: string | null): void;
	/** The stream closed (cleanly or by error) — the pump decides what next. */
	onClose(reason: string): void;
}

export interface PushChannelOptions {
	/** The MCP endpoint URL (…/api/mcp); the stream lives under it. */
	mcpUrl: string;
	token: string;
	connectionId: string;
	/** Hidden exact-connection capability minted with this bond. */
	connectionCapability?: string;
	/** Main intake capability only; side polls never inherit this negotiation. */
	systemNoticeVersion?: 1;
	/** Durable interaction events share this one stream's wake marker. */
	interactionEventVersion?: 1;
	questionDismissalEventVersion?: 1;
	handlers: PushChannelHandlers;
	/** Abort to close deliberately. */
	signal: AbortSignal;
}

/** Parse an SSE frame block into {event, data}. Returns null for comments/keepalives. */
export function parseSseFrame(block: string): { event: string; data: string } | null {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) return null; // comment / keepalive
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join("\n") };
}

/**
 * Reconnect backoff for unexpected drops (item 8b0c162b). A native host holds
 * ONE stream; a proxy hiccup or brief network blip should NOT cost the rest of
 * the bond's lifetime on the slow path. Returns the delay before the next
 * reconnect attempt, or null when quick retries are exhausted and the caller
 * should settle into the held long-poll fallback.
 *
 * `attempts` counts consecutive drops of SHORT-LIVED streams: a stream that
 * stayed up past `healthyMs` proved the path works, so its drop restarts the
 * backoff from zero instead of burning one of the few quick retries.
 */
export const PUSH_RECONNECT_BACKOFF_MS = [1_000, 4_000, 10_000] as const;
export const PUSH_HEALTHY_MS = 30_000;

/** Monotonic fence: callbacks/timers from a replaced stream cannot open another. */
export class PushChannelGenerationFence {
	private generation = 0;

	begin(): number {
		this.generation += 1;
		return this.generation;
	}

	invalidate(): void {
		this.generation += 1;
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation;
	}
}

export type RuntimeRunKind = "owner" | "interaction" | "system_notice";

export interface RuntimeOccupancyRevision {
	/** One identity for the high-level native execution, not each retry or bubble. */
	executionId: string;
	revision: number;
	kind: RuntimeRunKind;
}

/**
 * True Pi runtime occupancy, independent from server-visible activity. System
 * notices are activity-neutral but still occupy the model and must retain SSE
 * wakes. A stale settle revision can never clear a newer run.
 */
export class RuntimeOccupancyFence {
	private nextRevision = 1;
	private current: RuntimeOccupancyRevision | null = null;
	private readonly newExecutionId: () => string;

	constructor(newExecutionId: () => string = randomUUID) {
		this.newExecutionId = newExecutionId;
	}

	begin(kind: RuntimeRunKind): RuntimeOccupancyRevision {
		// Every low-level Pi start receives a newer settle token, while retries and
		// compaction retain the existing run kind. An older awaited settle can no
		// longer finish after a newer start has occurred.
		const current = {
			executionId: this.current?.executionId ?? this.newExecutionId(),
			revision: this.nextRevision++,
			kind: this.current?.kind ?? kind,
		};
		this.current = current;
		return { ...current };
	}

	promote(candidate: RuntimeOccupancyRevision | null, kind: RuntimeRunKind): RuntimeOccupancyRevision | null {
		if (!this.isCurrent(candidate) || !this.current) return null;
		this.current = { executionId: this.current.executionId, revision: this.nextRevision++, kind };
		return { ...this.current };
	}

	capture(): RuntimeOccupancyRevision | null {
		return this.current ? { ...this.current } : null;
	}

	isCurrent(candidate: RuntimeOccupancyRevision | null): boolean {
		return Boolean(candidate && this.current
			&& candidate.executionId === this.current.executionId
			&& candidate.revision === this.current.revision
			&& candidate.kind === this.current.kind);
	}

	finish(candidate: RuntimeOccupancyRevision | null): boolean {
		if (!this.isCurrent(candidate)) return false;
		this.current = null;
		return true;
	}

	isBusy(): boolean {
		return this.current !== null;
	}
}

/**
 * Monotonic wake gate for the one pump fetch loop. Resolving a waiter consumes
 * that exact generation; a later/burst signal remains one pending generation.
 */
export class WakeGenerationGate {
	private produced = 0;
	private consumed = 0;
	private waiter: { resolve: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

	signal(): void {
		this.produced += 1;
		const waiter = this.waiter;
		if (!waiter) return;
		this.waiter = null;
		clearTimeout(waiter.timer);
		this.consumed = this.produced;
		waiter.resolve();
	}

	wait(safetyMs: number): Promise<void> {
		if (this.produced > this.consumed) {
			this.consumed = this.produced;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.waiter?.resolve === resolve) this.waiter = null;
				resolve();
			}, safetyMs);
			if (typeof timer.unref === "function") timer.unref();
			this.waiter = { resolve, timer };
		});
	}

	cancel(): void {
		const waiter = this.waiter;
		this.waiter = null;
		if (!waiter) return;
		clearTimeout(waiter.timer);
		waiter.resolve();
	}

	hasPending(): boolean {
		return this.produced > this.consumed;
	}
}

/** Coalesces wake markers consumed while Pi cannot negotiate idle-only lanes. */
export class BusyWakeLatch {
	private pending = false;

	noteWake(busy: boolean): void {
		if (busy) this.pending = true;
	}

	consumeAtIdle(idle: boolean): boolean {
		if (!idle || !this.pending) return false;
		this.pending = false;
		return true;
	}
}

export function nextPushReconnectDelayMs(
	attempts: number,
	openedAt: number | undefined,
	now: number,
	healthyMs: number = PUSH_HEALTHY_MS,
): number | null {
	const effective = openedAt !== undefined && now - openedAt > healthyMs ? 0 : attempts;
	if (effective >= PUSH_RECONNECT_BACKOFF_MS.length) return null;
	return PUSH_RECONNECT_BACKOFF_MS[effective];
}

/**
 * Open and pump the SSE channel until it closes or the signal aborts.
 * Resolves when the stream ends; rejects only on connect-level failure
 * (non-2xx, network) so the caller can choose fallback BEFORE any frames
 * flowed.
 */
export function pushChannelUrl(opts: Pick<PushChannelOptions, "mcpUrl" | "connectionId" | "systemNoticeVersion" | "interactionEventVersion" | "questionDismissalEventVersion">): string {
	const query = new URLSearchParams({ connection_id: opts.connectionId });
	if (opts.systemNoticeVersion === 1) query.set("system_notice_version", "1");
	if (opts.interactionEventVersion === 1) query.set("interaction_event_version", "1");
	if (opts.questionDismissalEventVersion === 1) {
		if (opts.interactionEventVersion !== 1) throw new Error("Dismissal requires answer negotiation");
		query.set("question_dismissal_event_version", "1");
	}
	return `${opts.mcpUrl.replace(/\/$/, "")}/connection-stream?${query.toString()}`;
}

export async function openPushChannel(opts: PushChannelOptions): Promise<void> {
	const url = pushChannelUrl(opts);
	const res = await fetch(url, {
		method: "GET",
		headers: {
			authorization: `Bearer ${opts.token}`,
			accept: "text/event-stream",
			...(opts.connectionCapability ? { "x-devspec-connection-capability": opts.connectionCapability } : {}),
		},
		signal: opts.signal,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`push channel HTTP ${res.status}: ${body.slice(0, 200)}`);
	}
	if (!res.body) throw new Error("push channel: no response body");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.indexOf("\n\n")) !== -1) {
				const block = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const frame = parseSseFrame(block);
				if (!frame) continue;
				if (frame.event === "wake") {
					opts.handlers.onWake();
				} else if (frame.event === "ended") {
					let reason: string | null = null;
					try {
						reason = (JSON.parse(frame.data) as { end_reason?: string | null }).end_reason ?? null;
					} catch { /* keep null */ }
					opts.handlers.onEnded(reason);
				}
				// hello frames need no action — the bond already knows its facts.
			}
		}
		opts.handlers.onClose("stream closed");
	} catch (err) {
		if (opts.signal.aborted) return; // deliberate close — not an error
		opts.handlers.onClose(err instanceof Error ? err.message : String(err));
	}
}
