/** Negotiated room data, never command authority (829394e9). */
import type { IngressAttachment, IngressContextEntry, IngressOrderPoint } from "./remote-payload.ts";

export const ROOM_CONTEXT_LANE = { contractVersion: "1.6.0", policyVersion: "2026-09-24.1" } as const;
export type RoomRowState = "in_progress" | "final" | "deleted";
export type RoomAddressee = { kind: "room" | "dev" } | { kind: "connection"; connection_id: string; label: string };
export interface RoomMessage { message_id: string; addressee: RoomAddressee; attachments: IngressAttachment[]; state: RoomRowState }
export interface RoomCoverage { through: IngressOrderPoint; eligible_count: number; deleted_count: number; open_message_ids: string[] }
export interface DeletionSeen { through: { deleted_at: string; message_id: string } | null; total: number | null }
export interface RoomDeletions { message_ids: string[]; truncated: boolean; total: number; seen: DeletionSeen }
export type RoomOpenCheck = { message_id: string; state: RoomRowState | "absent"; entry?: IngressContextEntry };
export interface RoomContext {
	version: 1;
	messages: RoomMessage[];
	coverage: RoomCoverage | null;
	open_check?: RoomOpenCheck[] | null;
	deletions?: RoomDeletions | null;
}
/** Deliberately excludes mutable record facts, even when the wire includes them. */
export interface ActivityIndex {
	version: 1;
	status: "available" | "unavailable";
	as_of: string;
	truncated: boolean;
	entries: Array<{ kind: "action_item" | "memory" | "artifact"; id: string; relation: "produced" | "referenced" }>;
}
export interface RoomValidators {
	order(value: unknown, path: string): IngressOrderPoint;
	attachment(value: unknown, path: string): IngressAttachment;
	entry(value: unknown, path: string): IngressContextEntry;
}

/** Advertise before opting in: an older server must keep receiving its old lane. */
export function advertisesRoomContext(resource: unknown): boolean {
	try {
		const contents = object(resource).contents;
		for (const item of list(contents, 10)) {
			const text = object(item).text;
			if (typeof text !== "string" || text.length > 2_000_000) continue;
			const c = object(JSON.parse(text)); const a = object(c.activation);
			const required = object(a.room_context_contract_requires);
			if (c.kind === "devspec.product.remote_ingress_contract" && c.schema_version === 1 && c.contract_version === ROOM_CONTEXT_LANE.contractVersion && object(c.policy).policy_version === ROOM_CONTEXT_LANE.policyVersion && a.room_context_negotiation_argument === "room_context_version" && ["ingress_version", "delegated_scope_version", "active_plan_projection_version", "system_notice_version", "sender_style_version", "room_context_version"].every(k => required[k] === 1)) return true;
		}
	} catch { /* Unknown/unavailable advertisement means keep the supported lane. */ }
	return false;
}

function bad(): never { throw new Error("invalid room context"); }
function object(x: unknown): Record<string, unknown> {
	if (!x || typeof x !== "object" || Array.isArray(x)) bad();
	return x as Record<string, unknown>;
}
function keys(x: Record<string, unknown>, required: string[], optional: string[] = []): void {
	if (required.some(k => !Object.hasOwn(x, k)) || Object.keys(x).some(k => !required.includes(k) && !optional.includes(k))) bad();
}
function text(x: unknown): string { if (typeof x !== "string" || !x) bad(); return x; }
function uuid(x: unknown): string { const s = text(x); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) bad(); return s.toLowerCase(); }
function count(x: unknown): number { if (!Number.isSafeInteger(x) || (x as number) < 0) bad(); return x as number; }
function flag(x: unknown): boolean { if (typeof x !== "boolean") bad(); return x; }
function date(x: unknown): string { const s = text(x); if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) bad(); return s; }
function list(x: unknown, max = 500): unknown[] { if (!Array.isArray(x) || x.length > max) bad(); return x; }
function ids(x: unknown): string[] { const values = list(x).map(uuid); if (new Set(values).size !== values.length) bad(); return values; }
function state(x: unknown): RoomRowState { if (x !== "in_progress" && x !== "final" && x !== "deleted") bad(); return x; }

export function parseDeletionSeen(value: unknown): DeletionSeen {
	const row = object(value); keys(row, ["through", "total"]);
	let through: DeletionSeen["through"] = null;
	if (row.through !== null) {
		const p = object(row.through); keys(p, ["deleted_at", "message_id"]);
		through = { deleted_at: date(p.deleted_at), message_id: uuid(p.message_id) };
	}
	return { through, total: row.total === null ? null : count(row.total) };
}

export function parseRoomContext(
	value: unknown,
	rows: Array<{ message_id: string; order: IngressOrderPoint }>,
	commandIds: Set<string>,
	pageEnd: IngressOrderPoint | null,
	validate: RoomValidators,
): RoomContext {
	const row = object(value); keys(row, ["version", "messages", "coverage"], ["open_check", "deletions"]);
	if (row.version !== 1) bad();
	const emitted = new Set(rows.map(r => r.message_id.toLowerCase()));
	if (emitted.size !== rows.length) bad();
	const liveCommands = new Set([...commandIds].map(id => id.toLowerCase()));
	const seen = new Set<string>();
	const messages = list(row.messages).map((value): RoomMessage => {
		const m = object(value); keys(m, ["message_id", "addressee", "attachments", "state"]);
		const message_id = uuid(m.message_id);
		if (!emitted.has(message_id) || seen.has(message_id)) bad();
		seen.add(message_id);
		const a = object(m.addressee);
		let addressee: RoomAddressee;
		if (a.kind === "connection") {
			keys(a, ["kind", "connection_id", "label"]);
			addressee = { kind: "connection", connection_id: uuid(a.connection_id), label: text(a.label) };
		} else {
			keys(a, ["kind"]); if (a.kind !== "room" && a.kind !== "dev") bad();
			addressee = { kind: a.kind };
		}
		const parsedState = state(m.state);
		if (liveCommands.has(message_id) && parsedState !== "final") bad();
		return { message_id, addressee, state: parsedState, attachments: list(m.attachments, Number.MAX_SAFE_INTEGER).map(a => validate.attachment(a, "room.attachment")) };
	});
	if (seen.size !== emitted.size) bad();
	let coverage: RoomCoverage | null = null;
	if (row.coverage !== null) {
		const c = object(row.coverage); keys(c, ["through", "eligible_count", "deleted_count", "open_message_ids"]);
		coverage = { through: validate.order(c.through, "room.coverage.through"), eligible_count: count(c.eligible_count), deleted_count: count(c.deleted_count), open_message_ids: ids(c.open_message_ids) };
		if (coverage.deleted_count + coverage.open_message_ids.length > coverage.eligible_count || coverage.eligible_count < rows.length) bad();
		// These are the same producer-owned point; preserve sub-millisecond precision.
		if (pageEnd && (coverage.through.sequence !== pageEnd.sequence || coverage.through.message_id !== pageEnd.message_id || coverage.through.created_at !== pageEnd.created_at)) bad();
		const open = new Set(coverage.open_message_ids);
		if (messages.some(m => (m.state === "in_progress") !== open.has(m.message_id)) || messages.filter(m => m.state === "deleted").length > coverage.deleted_count) bad();
	}
	const result: RoomContext = { version: 1, messages, coverage };
	if (row.open_check !== undefined) {
		if (row.open_check === null) result.open_check = null;
		else {
			const checked = new Set<string>();
			result.open_check = list(row.open_check).map((value): RoomOpenCheck => {
				const c = object(value); keys(c, ["message_id", "state"], ["entry"]);
				const message_id = uuid(c.message_id);
				if (checked.has(message_id) || emitted.has(message_id)) bad(); checked.add(message_id);
				const s = c.state === "absent" ? "absent" : state(c.state);
				if ((s === "final") !== (c.entry !== undefined)) bad();
				const entry = c.entry === undefined ? undefined : validate.entry(c.entry, "room.open_check.entry");
				if (entry && entry.message_id.toLowerCase() !== message_id) bad();
				return { message_id, state: s, ...(entry ? { entry: { ...entry, message_id, order: { ...entry.order, message_id } } } : {}) };
			});
		}
	}
	if (row.deletions !== undefined) {
		if (row.deletions === null) result.deletions = null;
		else {
			const d = object(row.deletions); keys(d, ["message_ids", "truncated", "total", "seen"]);
			const parsed = { message_ids: ids(d.message_ids), truncated: flag(d.truncated), total: count(d.total), seen: parseDeletionSeen(d.seen) };
			if (parsed.message_ids.length > parsed.total || (parsed.message_ids.length && !parsed.seen.through) || (parsed.truncated && !parsed.message_ids.length) || parsed.seen.total !== (parsed.truncated ? null : parsed.total)) bad();
			result.deletions = parsed;
		}
	}
	return result;
}

export function parseActivityIndex(value: unknown): ActivityIndex {
	const row = object(value);
	if (row.version !== 1 || row.advisory !== true || (row.status !== "available" && row.status !== "unavailable")) bad();
	const seen = new Set<string>();
	const entries = list(row.entries, 1000).map(value => {
		const e = object(value);
		if (e.kind !== "action_item" && e.kind !== "memory" && e.kind !== "artifact") bad();
		if (e.relation !== "produced" && e.relation !== "referenced") bad();
		const id = uuid(e.id); const key = `${e.kind}:${id}`;
		if (seen.has(key)) bad(); seen.add(key);
		return { kind: e.kind, id, relation: e.relation } as ActivityIndex["entries"][number];
	});
	return { version: 1, status: row.status, as_of: date(row.as_of), truncated: flag(row.truncated), entries: row.status === "available" ? entries : [] };
}
