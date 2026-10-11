/**
 * Structured work-trail events for Pi (item 2219b653).
 *
 * Pure capture + classify. The markdown renderer in trail.ts stays as the
 * fallback for hosts that only speak `work_trail` text. Pi posts BOTH.
 */

import { safeTrailId, safeTrailLabel } from "./trail-projection.ts";

export const TRAIL_EVENT_KINDS = ["thinking", "text", "tool", "domain", "subagent"] as const;
export type TrailEventKind = (typeof TRAIL_EVENT_KINDS)[number];

export const TRAIL_EVENT_STATUSES = ["running", "ok", "error"] as const;
export type TrailEventStatus = (typeof TRAIL_EVENT_STATUSES)[number];

export const TRAIL_DOMAINS = [
	"action_item",
	"memory",
	"implementation",
	"criterion",
	"resource",
] as const;
export type TrailDomain = (typeof TRAIL_DOMAINS)[number];

export interface ThinkingTrailEvent {
	seq: number;
	kind: "thinking";
	text: string;
	occurredAt: string;
}

/** Legacy only. Pi no longer emits assistant speech into Activity. */
export interface TextTrailEvent {
	seq: number;
	kind: "text";
	text: string;
	occurredAt?: string;
}

interface TimedTrailEvent {
	occurredAt: string;
	completedAt?: string;
}

export interface ToolTrailEvent extends TimedTrailEvent {
	seq: number;
	kind: "tool";
	correlationId: string;
	name: string;
	args?: string;
	status: TrailEventStatus;
	result?: string;
	durationMs?: number;
}

export interface DomainTrailEvent extends TimedTrailEvent {
	seq: number;
	kind: "domain";
	correlationId: string;
	domain: TrailDomain;
	action: string;
	name: string;
	title?: string;
	id?: string;
	status: TrailEventStatus;
	result?: string;
	durationMs?: number;
}

export interface SubagentTrailChild {
	key: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached" | "stopped" | "paused";
	model?: string;
	thinking?: string;
	lastActivityAt?: string;
	durationMs?: number;
	summary?: string;
}

export interface SubagentTrailEvent extends TimedTrailEvent {
	seq: number;
	kind: "subagent";
	/** Intentionally omitted for public fleet-backed events; child/run ids stay local. */
	correlationId?: string;
	name: string;
	status: TrailEventStatus;
	summary?: string;
	children: SubagentTrailChild[];
	durationMs?: number;
}

export type TrailEvent =
	| ThinkingTrailEvent
	| TextTrailEvent
	| ToolTrailEvent
	| DomainTrailEvent
	| SubagentTrailEvent;

interface DomainSpec {
	domain: TrailDomain;
	action: string;
}

const DOMAIN_BY_NAME: Record<string, DomainSpec> = {
	create_action_item: { domain: "action_item", action: "created" },
	update_action_item: { domain: "action_item", action: "updated" },
	claim_work_item: { domain: "action_item", action: "claimed" },
	record_implementation: { domain: "implementation", action: "recorded" },
	record_criterion_verdicts: { domain: "criterion", action: "recorded" },
	// The replacing item, like supersede_memory's successor: the one to read now.
	supersede_action_item: { domain: "action_item", action: "superseded" },
	record_memory: { domain: "memory", action: "recorded" },
	update_memory: { domain: "memory", action: "updated" },
	resolve_memory_flag: { domain: "memory", action: "reviewed" },
	resolve_resource_flag: { domain: "resource", action: "reviewed" },
	supersede_memory: { domain: "memory", action: "superseded" },
	retract_memory: { domain: "memory", action: "retracted" },
	create_resource: { domain: "resource", action: "created" },
	update_resource: { domain: "resource", action: "updated" },
	supersede_resource: { domain: "resource", action: "superseded" },
	archive_resource: { domain: "resource", action: "archived" },
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
	if (!obj) return undefined;
	for (const key of keys) {
		const v = obj[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

function unwrapResult(result: unknown): Record<string, unknown> | null {
	const outer = asRecord(result);
	if (!outer) return null;
	// Pi tool results retain the complete parsed payload in host-only `details`.
	// Select identity fields mechanically, but never serialize the object.
	const details = asRecord(outer.details);
	if (details) return details;
	const content = outer.content;
	if (Array.isArray(content)) {
		const text = content
			.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
			.map((c) => (c as { text?: string }).text)
			.filter((t): t is string => typeof t === "string")
			.join("\n");
		if (text.trim().startsWith("{")) {
			try {
				const parsed = JSON.parse(text) as unknown;
				return asRecord(parsed);
			} catch {
				/* fall through */
			}
		}
	}
	return outer;
}

/** Map a native tool name to a first-class domain event. */
export function classifyDomainTool(name: string, _args?: unknown): DomainSpec | null {
	return DOMAIN_BY_NAME[name] ?? null;
}

/** Fixed public dispositions only; receipt bodies and arbitrary outcome strings stay private. */
export type TrailWriteOutcome = "committed" | "queued_for_review" | "pending" | "not_applied" | "failed";

export function writeOutcomeFromResult(result: unknown): TrailWriteOutcome | undefined {
	const row = unwrapResult(result);
	if (!row) return undefined;
	// Native toolErrorResult returns normally with details.error, not an isError flag.
	// Classify the structured marker without projecting the private message.
	if (typeof row.error === "string") return "failed";
	if (asRecord(result)?.isError === true || row.isError === true || row.success === false || row.ok === false
		|| row.outcome === "failed" || row.outcome === "error") return "failed";
	// Queued creates explicitly say recorded/created=false. Keep the proposal
	// distinct from a comparison gate or failure, without borrowing its source ID.
	if (row.outcome === "queued_for_review") return "queued_for_review";
	if (row.closure === "pending" || row.tense === "pending") return "pending";
	if (row.reconcile_required === true || [
		"applied", "committed", "recorded", "created", "updated", "superseded",
		"retracted", "archived", "claim_success", "implementation_recorded", "resolved",
	].some((key) => row[key] === false)) return "not_applied";
	if (row.outcome === "committed" || (row.outcome === "duplicate" && row.original_outcome === "committed")) return "committed";
	// A new explicit disposition is not evidence that the default write happened.
	if (typeof row.outcome === "string" && row.outcome.trim()) return "not_applied";
	if (["applied", "committed", "recorded", "created", "updated", "superseded", "retracted", "archived", "claim_success", "implementation_recorded", "resolved"].some((key) => row[key] === true)) return "committed";
	return undefined;
}

/**
 * What the trail says a write DID. `DOMAIN_BY_NAME` names the committed outcome,
 * because that is the ordinary one; a write the server only queued did not resolve,
 * record or supersede anything, and saying it did is the failure the proposals
 * ledger exists to prevent (DevSpec item 689d44cb).
 */
export function domainAction(spec: DomainSpec, outcome?: TrailWriteOutcome): string {
	if (outcome === undefined) return "outcome unknown";
	if (outcome === "pending") return "pending";
	if (outcome === "not_applied") return "not applied";
	if (outcome === "failed") return "failed";
	return outcome === "queued_for_review" ? "proposed" : spec.action;
}

export function domainIdentity(name: string, args?: unknown, result?: unknown): { id?: string; title?: string } {
	const spec = DOMAIN_BY_NAME[name];
	if (!spec) return {};
	const a = asRecord(args);
	const r = unwrapResult(result);
	const item = asRecord(r?.item);
	let nested: Record<string, unknown> | null = null;
	if (spec.domain === "action_item") nested = asRecord(r?.action_item) ?? asRecord(item?.action_item) ?? item ?? r;
	if (spec.domain === "memory") nested = asRecord(r?.memory) ?? asRecord(item?.memory) ?? item ?? r;
	if (spec.domain === "resource") nested = asRecord(r?.resource) ?? asRecord(item?.resource) ?? item ?? r;
	if (["implementation", "criterion"].includes(spec.domain)) {
		nested = asRecord(r?.action_item) ?? asRecord(item?.action_item) ?? item ?? r;
	}

	const resultIdKeys = spec.domain === "memory"
		? ["id", "memory_id"]
		: spec.domain === "resource"
			? ["id", "resource_id"]
			: ["id", "action_item_id", "superseding_item_id"];
	const argIdKeys = spec.domain === "memory"
		? ["memory_id", "id"]
		: spec.domain === "resource"
			? ["resource_id", "id"]
			: ["action_item_id", "id"];
	const title = safeTrailLabel(pickString(nested, ["title"]) ?? pickString(a, ["title"]), 240);
	const outcome = writeOutcomeFromResult(result);
	if (result !== undefined && outcome !== "committed") return { title };
	// Creates and supersedes mint a new identity. A missing replacement ID must
	// never fall back to the old row merely because the host reported success.
	const mintsIdentity = ["create_action_item", "record_memory", "create_resource", "supersede_memory", "supersede_resource"].includes(name);
	const fallbackId = result !== undefined && mintsIdentity ? undefined : pickString(a, argIdKeys);
	const id = safeTrailId(pickString(nested, resultIdKeys) ?? fallbackId);
	return { id, title };
}
