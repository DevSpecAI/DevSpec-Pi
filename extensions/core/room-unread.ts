/**
 * What this agent has and has not read in its room (item ce1ffca1; brief 4d258656,
 * decision c4c6190f). Lives in the existing room copy, never a second store.
 *
 * Two bookmarks, kept apart on purpose:
 * - "read": the exact message versions `read_room_context` handed to the model.
 *   Only the reader writes it. A wake, a notice or the agent's own reply never do.
 * - "presented": what a notice has TOLD the model exists. It decides whether a
 *   mid-turn notice has anything new to say; it never marks anything read.
 * The coverage checkpoint ("saved locally through here") is a third, separate fact.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { hasAssistantSpeech as hasVisibleText } from "./assistant-speech.ts";
import type { StoredRoomRecord } from "./room-store.ts";

/** Additive table: older caches simply have nothing read yet. */
export const ROOM_MARKS_TABLE = "CREATE TABLE IF NOT EXISTS room_marks (kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY (kind, id))";
export type RoomMarkKind = "read" | "presented" | "own";
export interface RoomMarks { read: Map<string, string>; presented: Set<string>; own: Set<string> }
type Db = Pick<DatabaseSync, "prepare" | "exec">;

/**
 * Who "this agent" is. Exact ids come from Pi's own post receipts. The label
 * covers rows posted before this attachment's copy existed (every attach starts
 * a fresh copy); it is set only when the connection has a codename, because a
 * bare tool name would also match every other Pi the owner runs.
 */
export interface RoomSelf { connectionId: string; ownIds: ReadonlySet<string>; label: string | null }
export type RoomMessageChange = "new" | "updated";
export interface RoomWaitingMessage {
	message_id: string;
	sequence: number;
	created_at: string;
	change: RoomMessageChange;
	for_you: boolean;
	author: string;
	kind: string;
	version: string;
	/** Presentation identity: a growing unread bubble is one key; a change after a read is a new one. */
	key: string;
}
export interface RoomUnreadSummary {
	unread: number;
	updated: number;
	for_you: number;
	oldest_unread_at: string | null;
	by_author: Array<{ author: string; kind: string; messages: number }>;
}
export interface RoomUnreadState { self: RoomSelf; marks: RoomMarks; waiting: RoomWaitingMessage[] }

/** The version a reader saw: what a person sees (text and attachments), never lifecycle state. */
export function roomMessageVersion(r: Pick<StoredRoomRecord, "content" | "attachments">): string {
	return createHash("sha256").update(JSON.stringify([r.content, r.attachments.map(a => [a.resource_id, a.filename, a.type])])).digest("hex").slice(0, 32);
}

export function isOwnRoomMessage(r: Pick<StoredRoomRecord, "message_id" | "actor">, self: RoomSelf): boolean {
	if (self.ownIds.has(r.message_id)) return true;
	if (r.actor.kind !== "agent" || !self.label) return false;
	// The server labels an agent's posts "Tool · Codename (Owner)".
	return r.actor.display_name === self.label || r.actor.display_name.startsWith(`${self.label} (`);
}

/**
 * A real message is judged by what a person in the room sees. Text (or an
 * attachment) from a person, another agent or the in-session AI counts whether
 * final or still in progress; system lines (presence markers, notices), empty
 * rows in any state, deleted rows and this agent's own rows never do.
 */
export function isRealRoomMessage(r: StoredRoomRecord, self: RoomSelf): boolean {
	if (r.state === "deleted" || r.actor.kind === "system") return false;
	if (isOwnRoomMessage(r, self)) return false;
	return hasVisibleText(r.content) || r.attachments.length > 0;
}

/** Oldest first, in the room's stable total order. A changed read message is "updated", never unread again. */
export function waitingRoomMessages(records: Iterable<StoredRoomRecord>, read: ReadonlyMap<string, string>, self: RoomSelf): RoomWaitingMessage[] {
	const waiting: RoomWaitingMessage[] = [];
	for (const r of records) {
		if (!isRealRoomMessage(r, self)) continue;
		const version = roomMessageVersion(r);
		const seen = read.get(r.message_id);
		if (seen === version) continue;
		const change: RoomMessageChange = seen === undefined ? "new" : "updated";
		waiting.push({
			message_id: r.message_id, sequence: r.order.sequence, created_at: r.order.created_at, change,
			for_you: r.addressee.kind === "connection" && r.addressee.connection_id === self.connectionId,
			author: r.actor.display_name, kind: r.actor.kind, version,
			key: change === "new" ? roomPresentedKey(r.message_id) : `updated:${r.message_id}:${seen}`,
		});
	}
	return waiting.sort((a, b) => a.sequence - b.sequence);
}

/** A command Pi was woken with has been TOLD, so it never makes a notice fresh. It stays unread until read. */
export function roomPresentedKey(messageId: string): string { return `new:${messageId.toLowerCase()}`; }

/** The commands one delivery hands the model, by exact id: the queue item's list or bundle, and the primary. */
export function deliveredCommandKeys(primaryMessageId: string | undefined, details: unknown): string[] {
	const ids = new Set<string>();
	if (primaryMessageId) ids.add(primaryMessageId.toLowerCase());
	const d = details as { command_message_ids?: unknown; bundle?: { commands?: unknown } } | null | undefined;
	const listed = Array.isArray(d?.command_message_ids) ? d.command_message_ids
		: Array.isArray(d?.bundle?.commands) ? d.bundle.commands.map(c => (c as { id?: unknown } | null)?.id) : [];
	for (const id of listed) if (typeof id === "string" && id) ids.add(id.toLowerCase());
	return [...ids].map(roomPresentedKey);
}

function label(s: string): string {
	let end = Math.min(s.length, 120);
	if (end && /[\uD800-\uDBFF]/.test(s[end - 1]!)) end--;
	return s.slice(0, end);
}

/** Counts only. Author labels are participant-written data; callers encode them as JSON. */
export function summarizeRoomUnread(waiting: readonly RoomWaitingMessage[]): RoomUnreadSummary {
	const authors = new Map<string, { author: string; kind: string; messages: number }>();
	for (const w of waiting) {
		const author = label(w.author); const k = JSON.stringify([w.kind, author]);
		const entry = authors.get(k) ?? { author, kind: w.kind, messages: 0 };
		entry.messages++; authors.set(k, entry);
	}
	return {
		unread: waiting.filter(w => w.change === "new").length,
		updated: waiting.filter(w => w.change === "updated").length,
		for_you: waiting.filter(w => w.for_you).length,
		oldest_unread_at: waiting.find(w => w.change === "new")?.created_at ?? null,
		by_author: [...authors.values()].sort((a, b) => b.messages - a.messages || a.author.localeCompare(b.author)),
	};
}

/** Something waiting that no notice has told the model about yet. */
export function hasUnpresented(state: Pick<RoomUnreadState, "waiting" | "marks">): boolean {
	return state.waiting.some(w => !state.marks.presented.has(w.key));
}

export function readRoomMarks(db: Db): RoomMarks {
	const marks: RoomMarks = { read: new Map(), presented: new Set(), own: new Set() };
	if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_marks'").get()) return marks;
	for (const row of db.prepare("SELECT kind, id, version FROM room_marks").all()) {
		const id = String(row.id);
		if (row.kind === "read") marks.read.set(id, String(row.version));
		else if (row.kind === "presented") marks.presented.add(id);
		else if (row.kind === "own") marks.own.add(id);
	}
	return marks;
}

/** Caller owns the transaction. A read mark records the version handed over, replacing an older one. */
export function writeRoomMarks(db: Db, kind: RoomMarkKind, entries: ReadonlyArray<readonly [string, string]>): void {
	const upsert = db.prepare("INSERT INTO room_marks VALUES (?,?,?) ON CONFLICT(kind, id) DO UPDATE SET version=excluded.version");
	for (const [id, version] of entries) upsert.run(kind, id, version);
}

/** One full pass over the saved copy. Callers cache it by the file change counter. */
export function loadRoomUnread(db: Db, connectionId: string): RoomUnreadState {
	const marks = readRoomMarks(db);
	const row = db.prepare("SELECT value FROM meta WHERE key='self_label'").get();
	const selfLabel = row ? JSON.parse(String(row.value)) as unknown : null;
	const self: RoomSelf = { connectionId: connectionId.toLowerCase(), ownIds: marks.own, label: typeof selfLabel === "string" && selfLabel ? selfLabel : null };
	const records = db.prepare("SELECT body FROM messages WHERE state<>'deleted' ORDER BY sequence").all().map(r => JSON.parse(String(r.body)) as StoredRoomRecord);
	return { self, marks, waiting: waitingRoomMessages(records, marks.read, self) };
}

/**
 * SQLite's file change counter (header bytes 24-27) moves on every committed
 * write in rollback-journal mode, which the room copy uses. Reading it is the
 * cheap "has the local copy changed?" check on Pi's per-tool-call path.
 */
export function roomFileChangeCounter(path: string): number | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const header = Buffer.alloc(4);
		return readSync(fd, header, 0, 4, 24) === 4 ? header.readUInt32BE(0) : null;
	} catch { return null; }
	finally { if (fd !== undefined) closeSync(fd); }
}
