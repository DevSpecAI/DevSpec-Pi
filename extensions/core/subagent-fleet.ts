import { randomUUID } from "node:crypto";
import type { SubagentTrailChild } from "./trail-events.ts";

const RPC_VERSION = 1;
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_READY_EVENT = "subagents:rpc:v1:ready";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const DEFAULT_TIMEOUT_MS = 250;
const MAX_FLEET_ENTRIES = 24;

type Unsubscribe = () => void;

export interface SubagentEventBus {
	on(event: string, handler: (data: unknown) => void): Unsubscribe | void;
	emit(event: string, data: unknown): void;
}

export interface SubagentFleetSnapshot {
	children: SubagentTrailChild[];
	totalActive: number;
	omitted: number;
	observedAt: number;
	summary?: string;
}

type CapabilityState = "unknown" | "supported" | "unsupported";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function boundedCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? Math.min(value, 1_000_000)
		: null;
}

function safeDisplay(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const compact = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!compact) return undefined;
	return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function safeThinking(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "inherit"]).has(value)
		? value
		: undefined;
}

function supportsFleetStatus(value: unknown): boolean {
	const root = asRecord(value);
	const data = asRecord(root?.data) ?? root;
	const capabilities = asRecord(data?.capabilities);
	const fleetStatus = asRecord(capabilities?.fleetStatus);
	return fleetStatus?.version === 1;
}

/**
 * Parse only pi-subagents' documented public fleet DTO. The callback aliases
 * its opaque reconciliation key before anything is posted outside Pi.
 */
export function parseSubagentFleetReply(
	value: unknown,
	observedAt: number,
	aliasKey: (opaqueKey: string) => string,
): SubagentFleetSnapshot | null {
	const reply = asRecord(value);
	if (reply?.version !== RPC_VERSION || reply.success !== true) return null;
	const data = asRecord(reply.data);
	const fleet = asRecord(data?.fleet);
	if (fleet?.version !== 1) return null;
	const rawEntries = Array.isArray(fleet.entries) ? fleet.entries : null;
	const totalActive = boundedCount(fleet.totalActive);
	const omitted = boundedCount(fleet.omitted);
	if (!rawEntries || totalActive == null || omitted == null) return null;

	const children: SubagentTrailChild[] = [];
	const seenAliases = new Set<string>();
	for (const raw of rawEntries.slice(0, MAX_FLEET_ENTRIES)) {
		const entry = asRecord(raw);
		const opaqueKey = safeDisplay(entry?.key, 160);
		const agent = safeDisplay(entry?.agent, 96);
		const startedAt = entry?.startedAt;
		if (!opaqueKey || !agent || typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0) continue;
		const role = safeDisplay(entry?.role, 96);
		const displayAgent = role && role !== agent
			? safeDisplay(`${role} (${agent})`, 120) ?? agent
			: agent;
		const model = safeDisplay(entry?.model, 120);
		const thinking = safeThinking(entry?.effort);
		const key = aliasKey(opaqueKey);
		if (seenAliases.has(key)) continue;
		seenAliases.add(key);
		children.push({
			key,
			agent: displayAgent,
			status: "running",
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			durationMs: Math.max(0, observedAt - startedAt),
		});
	}

	if (children.length > totalActive) return null;
	const overflow = Math.max(omitted, totalActive - children.length);
	const summary = totalActive > 0
		? `${totalActive} child agent${totalActive === 1 ? "" : "s"} active${overflow > 0 ? ` · ${overflow} not shown` : ""}`
		: undefined;
	return { children, totalActive, omitted: overflow, observedAt, ...(summary ? { summary } : {}) };
}

/**
 * Optional companion-extension client for pi-subagents' versioned in-process
 * RPC. It performs no file reads and never parses model- or terminal-facing
 * text. Calls are deduplicated and fail closed to the existing generic row.
 */
export class SubagentFleetClient {
	private capability: CapabilityState = "unknown";
	private readonly aliases = new Map<string, string>();
	private nextAlias = 0;
	private pending: Promise<SubagentFleetSnapshot | null> | null = null;
	private disposed = false;
	private readonly cleanup = new Set<Unsubscribe>();
	private readonly stopReady: Unsubscribe | null;
	private readonly events: SubagentEventBus;
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(
		events: SubagentEventBus,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		now: () => number = Date.now,
	) {
		this.events = events;
		this.timeoutMs = timeoutMs;
		this.now = now;
		const unsubscribe = events.on(RPC_READY_EVENT, (payload) => {
			if (supportsFleetStatus(payload)) this.capability = "supported";
		});
		this.stopReady = typeof unsubscribe === "function" ? unsubscribe : null;
	}

	refresh(): Promise<SubagentFleetSnapshot | null> {
		if (this.disposed || this.capability === "unsupported") return Promise.resolve(null);
		if (this.pending) return this.pending;
		return this.startLoad();
	}

	/**
	 * Wait out any trail refresh, then take a new settle-time snapshot. This
	 * prevents a stale in-flight display request from deciding parent activity.
	 */
	async refreshFresh(): Promise<SubagentFleetSnapshot | null> {
		while (this.pending) await this.pending;
		if (this.disposed || this.capability === "unsupported") return null;
		return this.startLoad();
	}

	/** Public root projection only; fleet display keys are never interpreted as identities. */
	async rootStatus(): Promise<{ tasks: import("./background-work.ts").BackgroundTaskStatus[]; complete: boolean } | null> {
		if (this.disposed) return null;
		const value = asRecord(await this.request("status"));
		if (this.disposed) return null;
		if (value?.version !== 1 || value.success !== true) return null;
		const data = asRecord(value.data);
		const snapshot = asRecord(data?.asyncSnapshot);
		const omitted = asRecord(snapshot?.omitted);
		if (snapshot?.kind !== "pi-subagents.async-status-snapshot" || snapshot.version !== 1 || !Array.isArray(snapshot.runs) || snapshot.runs.length > 4096) return null;
		const tasks: import("./background-work.ts").BackgroundTaskStatus[] = [];
		let uncertainRoot = false;
		const rootIds = new Set<string>();
		for (const raw of snapshot.runs) {
			const root = asRecord(raw);
			if (typeof root?.id !== "string" || !root.id || root.id.length > 200 || root.id !== root.id.trim() || rootIds.has(root.id)) return null;
			rootIds.add(root.id);
			if (typeof root.state !== "string" || !["queued", "running", "complete", "failed", "partial", "paused", "stopped", "rejected"].includes(root.state)) return null;
			// Paused can be an interrupted root OR a workflow waiting on a live
			// child's supervisor. This bounded root DTO does not prove terminality.
			if (root.state === "paused") { uncertainRoot = true; continue; }
			tasks.push({ id: root.id, status: root.state === "queued" || root.state === "running" ? "running" : root.state === "complete" ? "completed" : root.state === "stopped" ? "killed" : "failed" });
		}
		if (new Set(tasks.map(task => task.id)).size !== tasks.length) return null;
		const fleet = asRecord(data?.fleet);
		return { tasks, complete: !uncertainRoot && omitted?.runs === 0 && omitted.byteLimitExceeded === false && !(tasks.length === 0 && Number(fleet?.totalActive) > 0) };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopReady?.();
		for (const stop of this.cleanup) stop();
		this.cleanup.clear();
		this.aliases.clear();
	}

	private startLoad(): Promise<SubagentFleetSnapshot | null> {
		this.pending = this.load().finally(() => {
			this.pending = null;
		});
		return this.pending;
	}

	private async load(): Promise<SubagentFleetSnapshot | null> {
		if (this.capability === "unknown") {
			const ping = await this.request("ping");
			if (!supportsFleetStatus(ping)) {
				this.capability = "unsupported";
				return null;
			}
			this.capability = "supported";
		}
		const status = await this.request("status");
		if (!status) return null;
		return parseSubagentFleetReply(status, this.now(), (key) => this.aliasFor(key));
	}

	private aliasFor(opaqueKey: string): string {
		let alias = this.aliases.get(opaqueKey);
		if (!alias) {
			alias = `child-${++this.nextAlias}`;
			this.aliases.set(opaqueKey, alias);
		}
		return alias;
	}

	private request(method: "ping" | "status"): Promise<unknown | null> {
		if (this.disposed) return Promise.resolve(null);
		const requestId = randomUUID();
		const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
		return new Promise((resolve) => {
			let settled = false;
			let unsubscribe: Unsubscribe | null = null;
			const finish = (value: unknown | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (unsubscribe) {
					this.cleanup.delete(unsubscribe);
					unsubscribe();
				}
				resolve(value);
			};
			const maybeUnsubscribe = this.events.on(replyEvent, (reply) => finish(reply));
			if (typeof maybeUnsubscribe === "function") {
				unsubscribe = maybeUnsubscribe;
				this.cleanup.add(unsubscribe);
			}
			const timer = setTimeout(() => finish(null), this.timeoutMs);
			if (typeof timer.unref === "function") timer.unref();
			this.events.emit(RPC_REQUEST_EVENT, {
				version: RPC_VERSION,
				requestId,
				method,
				params: {},
				source: { extension: "devspec-pi" },
			});
		});
	}
}
