/**
 * Structured work-trail events for Pi (item 2219b653).
 *
 * Pure capture + classify. The markdown renderer in trail.ts stays as the
 * fallback for hosts that only speak `work_trail` text. Pi posts BOTH.
 */

export const TRAIL_EVENT_KINDS = ["thinking", "text", "tool", "domain"] as const;
export type TrailEventKind = (typeof TRAIL_EVENT_KINDS)[number];

export const TRAIL_EVENT_STATUSES = ["running", "ok", "error"] as const;
export type TrailEventStatus = (typeof TRAIL_EVENT_STATUSES)[number];

export const TRAIL_DOMAINS = [
	"action_item",
	"memory",
	"implementation",
	"conflict",
	"criterion",
	"resource",
] as const;
export type TrailDomain = (typeof TRAIL_DOMAINS)[number];

export interface ThinkingTrailEvent {
	seq: number;
	kind: "thinking";
	text: string;
}

export interface TextTrailEvent {
	seq: number;
	kind: "text";
	text: string;
}

export interface ToolTrailEvent {
	seq: number;
	kind: "tool";
	name: string;
	args?: string;
	status: TrailEventStatus;
	result?: string;
	durationMs?: number;
}

export interface DomainTrailEvent {
	seq: number;
	kind: "domain";
	domain: TrailDomain;
	action: string;
	name: string;
	title?: string;
	id?: string;
	status: TrailEventStatus;
	result?: string;
}

export type TrailEvent =
	| ThinkingTrailEvent
	| TextTrailEvent
	| ToolTrailEvent
	| DomainTrailEvent;

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
	resolve_action_item_conflict: { domain: "conflict", action: "resolved" },
	record_memory: { domain: "memory", action: "recorded" },
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

/** Map a tool name (+ optional gateway verb) to a first-class domain event. */
export function classifyDomainTool(name: string, args?: unknown): DomainSpec | null {
	const direct = DOMAIN_BY_NAME[name];
	if (direct) return direct;
	if (name === "devspec") {
		const verb = pickString(asRecord(args), ["verb"]);
		if (verb && DOMAIN_BY_NAME[verb]) return DOMAIN_BY_NAME[verb];
	}
	return null;
}

export function domainIdentity(args?: unknown, result?: unknown): { id?: string; title?: string } {
	const a = asRecord(args);
	const r = unwrapResult(result);
	const nested = asRecord(r?.action_item) ?? asRecord(r?.memory) ?? asRecord(r?.resource) ?? r;
	return {
		id: pickString(nested, ["id", "action_item_id"]) ?? pickString(a, ["action_item_id", "id"]),
		title: pickString(nested, ["title", "name"]) ?? pickString(a, ["title", "name"]),
	};
}
