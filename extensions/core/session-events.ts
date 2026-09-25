/** Historical record events, never current state or command authority (81a0cccd). */
import { advertisesRoomContext } from "./room-context.ts";

type Actor = { kind: "agent" | "person" | "platform"; label: string };
type Base = { id: string; at: string; kind: "action_item" | "memory" | "artifact"; record_id: string };
export type SessionEvent = Base & (
	| { event: "produced" | "retracted" | "archived"; actor: Actor | null }
	| { event: "referenced"; message_id: string }
	| { event: "lifecycle_changed"; from: string; to: string }
	| { event: "superseded"; by: string | null; actor: Actor | null }
);
export interface SessionEvents {
	version: 1; advisory: true; status: "available" | "unchanged" | "unavailable";
	as_of: string; revision: string | null; events: SessionEvent[]; truncated: boolean;
}
function bad(): never { throw new Error("invalid session events"); }
function object(x: unknown): Record<string, unknown> { if (!x || typeof x !== "object" || Array.isArray(x)) bad(); return x as Record<string, unknown>; }
function text(x: unknown): string { if (typeof x !== "string" || !x) bad(); return x; }
function uuid(x: unknown): string { const s = text(x); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) bad(); return s; }
function date(x: unknown): string { const s = text(x); if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) bad(); return s; }
function actor(x: unknown): Actor | null {
	if (x === null) return null;
	const a = object(x); if (a.kind !== "agent" && a.kind !== "person" && a.kind !== "platform") bad();
	return { kind: a.kind, label: text(a.label) };
}
export function advertisesSessionEvents(resource: unknown): boolean {
	try {
		for (const item of object(resource).contents as unknown[]) {
			if (!advertisesRoomContext({ contents: [item] })) continue;
			const c = object(JSON.parse(text(object(item).text))); const a = object(c.activation);
			const r = object(a.session_events_requires);
			if (c.kind === "devspec.product.remote_ingress_contract" && a.session_events_negotiation_argument === "session_events_version" && a.session_events_revision_argument === "session_events_revision" && r.room_context_version === 1 && r.session_events_version === 1) return true;
		}
	} catch { /* Older advertisement: keep the existing room lane. */ }
	return false;
}
/** Ignore additive fields; an unknown variant rejects only this advisory section. */
export function parseSessionEvents(value: unknown): SessionEvents {
	const s = object(value);
	if (s.version !== 1 || s.advisory !== true || !["available", "unchanged", "unavailable"].includes(String(s.status)) || typeof s.truncated !== "boolean" || !Array.isArray(s.events) || s.events.length > 2000) bad();
	const revision = s.revision === null ? null : text(s.revision);
	if (revision !== null && !/^sha256:[a-f0-9]{64}$/.test(revision)) bad();
	if (s.status === "unavailable" ? revision !== null || s.events.length > 0 || s.truncated : revision === null) bad();
	if (s.status === "unchanged" && s.events.length) bad();
	const seen = new Set<string>();
	const events = s.events.map((value): SessionEvent => {
		const e = object(value); const id = text(e.id);
		if (id.length > 200 || seen.has(id)) bad(); seen.add(id);
		if (e.kind !== "action_item" && e.kind !== "memory" && e.kind !== "artifact") bad();
		const base: Base = { id, at: date(e.at), kind: e.kind, record_id: uuid(e.record_id) };
		switch (e.event) {
			case "produced": case "retracted": case "archived": return { ...base, event: e.event, actor: actor(e.actor) };
			case "referenced": return { ...base, event: e.event, message_id: uuid(e.message_id) };
			case "lifecycle_changed":
				if (e.kind !== "action_item") bad();
				return { ...base, event: e.event, from: text(e.from), to: text(e.to) };
			case "superseded": return { ...base, event: e.event, by: e.by === null ? null : uuid(e.by), actor: actor(e.actor) };
			default: return bad();
		}
	});
	return { version: 1, advisory: true, status: s.status as SessionEvents["status"], as_of: date(s.as_of), revision, events, truncated: s.truncated };
}
