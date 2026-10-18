/** Private transactional read model. Never restores command/interaction authority (829394e9). */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { devspecDir } from "./config.ts";
import type { PollPackage, RoomRecord } from "./remote-payload.ts";
import type { ActivityIndex, DeletionSeen, RoomAddressee, RoomCoverage, RoomMessage, RoomRowState } from "./room-context.ts";
import { ROOM_MARKS_TABLE, writeRoomMarks, type RoomMarkKind } from "./room-unread.ts";

import type { SessionEvents } from "./session-events.ts";

export interface StoredEventStatus {
	availability: "available" | "unavailable";
	as_of: string | null;
	response_as_of: string | null;
	checked_at: string;
	revision: string | null;
	truncated: boolean;
}

export interface RoomStoreScope {
	endpoint: string;
	projectId: string;
	nativeSessionId: string;
	connectionId: string;
	sessionId: string;
	attachmentId: string;
}
export interface StoredRoomRecord extends RoomRecord {
	state: RoomRowState;
	addressee: RoomAddressee;
	attachments: RoomMessage["attachments"];
}
interface Progress {
	version: 1;
	target: RoomCoverage | null;
	frontier: RoomCoverage | null;
	before: string | null;
	/** A gap above the saved older-history frontier; null means no such repair. */
	repair: "head" | { before: string } | null;
	deletionsSeen: DeletionSeen | null;
	observedAt: string | null;
	complete: boolean;
}
export type StoredActivityIndex = Omit<ActivityIndex, "status">;
export interface ObservedSnapshot<T = unknown> {
	availability: "available" | "unavailable";
	observedAt: string | null;
	checkedAt: string;
	value: T | null;
}
const EMPTY: Progress = { version: 1, target: null, frontier: null, before: null, repair: null, deletionsSeen: null, observedAt: null, complete: false };
const rank: Record<RoomRowState, number> = { in_progress: 0, final: 1, deleted: 2 };
class CorruptRoomCache extends Error {}
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const scopeIdentity = (s: RoomStoreScope) => [s.endpoint, s.projectId, s.nativeSessionId, s.connectionId, s.sessionId, s.attachmentId];
/** Irreversible selection hint for a same-credential offline reader, never authority. */
export const roomPrincipalFingerprint = (token: string): string => createHash("sha256").update(token).digest("hex");

function directory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("unsafe room cache directory");
	if (process.platform !== "win32") chmodSync(path, 0o700);
}
export function roomStorePath(scope: RoomStoreScope, root = join(devspecDir(), "rooms")): string {
	return join(root, digest(scope.nativeSessionId), `${digest(scopeIdentity(scope))}.sqlite`);
}

/** Import lazily: older hosts retain their existing lane, not a broken extension. */
export async function openRoomStore(scope: RoomStoreScope, options: {
	root?: string;
	principalFingerprint?: string;
	/** This connection's "Tool · Codename" label, or null without a codename (ce1ffca1). */
	selfLabel?: string | null;
	current?: () => boolean;
	crash?: (boundary: "after_records" | "before_commit" | "after_commit") => void;
} = {}): Promise<RoomStore> {
	const { DatabaseSync } = await import("node:sqlite");
	if (options.current && !options.current()) throw new Error("room attachment changed before storage opened");
	const root = options.root ?? join(devspecDir(), "rooms");
	directory(root);
	const parent = join(root, digest(scope.nativeSessionId)); directory(parent);
	const path = roomStorePath(scope, root);
	// Expire only this native session's old attachment copies, never other agents' data.
	for (const name of readdirSync(parent)) {
		if (!/^[a-f0-9]{64}\.sqlite$/.test(name)) continue;
		const candidate = join(parent, name); const st = lstatSync(candidate);
		if (candidate !== path && !st.isSymbolicLink() && st.isFile() && Date.now() - st.mtimeMs > RETENTION_MS) {
			rmSync(candidate, { force: true }); rmSync(`${candidate}-journal`, { force: true });
		}
	}
	if (existsSync(path)) {
		const st = lstatSync(path);
		if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new Error("unsafe room cache file");
	} else closeSync(openSync(path, "wx", 0o600));
	if (process.platform !== "win32") chmodSync(path, 0o600);
	const construct = () => {
		const db = new DatabaseSync(path);
		try { return new RoomStore(db, path, scope, options.current ?? (() => true), options.crash, options.principalFingerprint, options.selfLabel); }
		catch (e) { db.close(); throw e; }
	};
	try { return construct(); }
	catch (error) {
		const code = Number((error as { errcode?: unknown })?.errcode) & 255;
		if (!(error instanceof CorruptRoomCache) && code !== 11 && code !== 26) throw error;
		if (options.current && !options.current()) throw error;
		// Only recognized corruption of our derived cache is rebuilt. Busy files,
		// unknown future formats and permission failures are never deleted.
		rmSync(path, { force: true }); rmSync(`${path}-journal`, { force: true });
		closeSync(openSync(path, "wx", 0o600));
		return construct();
	}
}

export class RoomStore {
	private closed = false;
	private online = false;
	private failure = false;
	private db: DatabaseSync;
	readonly path: string;
	readonly scope: RoomStoreScope;
	private current: () => boolean;
	private crash?: (boundary: "after_records" | "before_commit" | "after_commit") => void;
	constructor(db: DatabaseSync, path: string, scope: RoomStoreScope,
		current: () => boolean,
		crash?: (boundary: "after_records" | "before_commit" | "after_commit") => void, principalFingerprint?: string, selfLabel?: string | null) {
		this.db = db; this.path = path; this.scope = scope; this.current = current; this.crash = crash;
		const format = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (format > 1) throw new Error("unsupported future room cache format");
		db.exec("PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;");
		db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sequence INTEGER UNIQUE NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY);");
		// Additive table: existing v1 caches and older readers remain valid.
		db.exec("CREATE TABLE IF NOT EXISTS session_events (id TEXT PRIMARY KEY, body TEXT NOT NULL);");
		db.exec(ROOM_MARKS_TABLE);
		const prior = this.meta<RoomStoreScope>("scope");
		if (prior && JSON.stringify(scopeIdentity(prior)) !== JSON.stringify(scopeIdentity(scope))) throw new Error("room cache scope mismatch");
		const version = this.meta<number>("schema");
		if (version !== undefined && version !== 1) throw new Error("unsupported room cache schema");
		this.setMeta("scope", scope);
		this.setMeta("schema", 1);
		db.exec("PRAGMA user_version=1");
		const progress = this.meta<Progress>("progress");
		if (progress && (progress.version !== 1 || typeof progress.complete !== "boolean" || (progress.before !== null && typeof progress.before !== "string") || (progress.complete && !progress.target))) throw new CorruptRoomCache("invalid recovery checkpoint");
		if (principalFingerprint !== undefined) {
			if (!/^[a-f0-9]{64}$/.test(principalFingerprint)) throw new Error("invalid principal fingerprint");
			this.setMeta("principal_fingerprint", principalFingerprint);
		}
		if (selfLabel !== undefined) this.setMeta("self_label", selfLabel);
	}
	private assertCurrent(): void { if (this.closed || !this.current()) throw new Error("room cache attachment no longer current"); }
	private meta<T>(key: string): T | undefined {
		const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
		try { return row ? JSON.parse(String(row.value)) as T : undefined; }
		catch { throw new CorruptRoomCache("invalid cache metadata"); }
	}
	private setMeta(key: string, value: unknown): void { this.db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); }
	private progress(): Progress { return this.meta<Progress>("progress") ?? structuredClone(EMPTY); }
	private row(id: string): StoredRoomRecord | undefined {
		const r = this.db.prepare("SELECT body FROM messages WHERE id=?").get(id);
		return r ? JSON.parse(String(r.body)) as StoredRoomRecord : undefined;
	}
	private number(sql: string, ...args: number[]): number { return Number(this.db.prepare(sql).get(...args)?.n ?? 0); }
	private merge(record: RoomRecord, description: RoomMessage): void {
		const id = record.message_id;
		const old = this.row(id);
		const deleted = description.state === "deleted" || old?.state === "deleted" || Boolean(this.db.prepare("SELECT 1 FROM tombstones WHERE id=?").get(id));
		const keepOld = old && rank[old.state] > rank[description.state];
		const result: StoredRoomRecord = deleted
			? { ...(old ?? record), message_id: id, content: "", state: "deleted", addressee: old?.addressee ?? description.addressee, attachments: [] }
			: keepOld ? old : { ...record, state: description.state, addressee: description.addressee, attachments: description.attachments };
		if (deleted) this.db.prepare("INSERT OR IGNORE INTO tombstones VALUES (?)").run(id);
		this.db.prepare("INSERT INTO messages VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body").run(id, record.order.sequence, result.state, JSON.stringify(result));
	}
	private tombstone(id: string): void {
		this.db.prepare("INSERT OR IGNORE INTO tombstones VALUES (?)").run(id);
		const old = this.row(id);
		if (old) this.merge(old, { message_id: id, addressee: old.addressee, attachments: [], state: "deleted" });
	}
	private snapshot(key: string, value: unknown, available: boolean, now: string): void {
		const old = this.meta<ObservedSnapshot>(`snapshot:${key}`);
		this.setMeta(`snapshot:${key}`, { availability: available ? "available" : "unavailable", checkedAt: now, observedAt: available ? now : old?.observedAt ?? null, value: available ? value : old?.value ?? null } satisfies ObservedSnapshot);
	}
	private mergeEvents(section: SessionEvents | null, now: string): void {
		const old = this.meta<StoredEventStatus>("session_events_status");
		// Events arriving late still belong in history; observation time is not a cursor.
		if (section?.status === "available") {
			const insert = this.db.prepare("INSERT OR IGNORE INTO session_events VALUES (?,?)");
			for (const event of section.events) insert.run(event.id, JSON.stringify(event));
		}
		if (section && old?.response_as_of && Date.parse(section.as_of) < Date.parse(old.response_as_of)) return;
		const available = section && (section.status === "available" || (section.status === "unchanged" && section.revision === old?.revision));
		this.setMeta("session_events_status", {
			availability: available ? "available" : "unavailable",
			as_of: available ? section.as_of : old?.as_of ?? null,
			response_as_of: section?.as_of ?? old?.response_as_of ?? null, checked_at: now,
			// Do not acknowledge a revision we did not commit. A mismatch requests a full list.
			revision: available ? section.revision : null,
			truncated: available ? section.truncated : old?.truncated ?? false,
		} satisfies StoredEventStatus);
	}
	private suffixComplete(p: Progress): boolean {
		if (!p.target || !p.frontier) return false;
		const expected = p.target.eligible_count - p.frontier.eligible_count;
		return expected >= 0 && this.number("SELECT count(*) AS n FROM messages WHERE sequence>? AND sequence<=?", p.frontier.through.sequence, p.target.through.sequence) === expected;
	}

	/** One committed page owns both the data and the next recovery request. */
	apply(pkg: PollPackage, kind: "live" | "older" | "repair" = "live", now = new Date().toISOString()): void {
		this.assertCurrent();
		const page = pkg.roomPage;
		if (!page || pkg.canonicalState !== "valid") { this.markOffline(); return; }
		if (kind !== "live" && (!page.history || pkg.ownerBundle || pkg.control || pkg.systemNotices.length)) throw new Error("non-historical repair rejected");
		let begun = false; let committed = false;
		try {
			this.db.exec("BEGIN IMMEDIATE"); begun = true;
			const p = this.progress();
			const descriptions = new Map(page.room.messages.map(m => [m.message_id, m]));
			for (const record of page.records) {
				const description = descriptions.get(record.message_id);
				if (!description) throw new Error("missing room record metadata");
				this.merge(record, description);
			}
			for (const check of page.room.open_check ?? []) {
				const old = this.row(check.message_id);
				if (check.state === "deleted") this.tombstone(check.message_id);
				else if (check.state === "absent") this.db.prepare("DELETE FROM messages WHERE id=?").run(check.message_id);
				else if (check.state === "final" && check.entry && old) {
					const { message_id, order, actor, source_type, content } = check.entry;
					this.merge({ message_id, order, actor, source_type, content }, { message_id, addressee: old.addressee, attachments: old.attachments, state: "final" });
				}
			}
			const d = page.room.deletions;
			if (d) {
				for (const id of d.message_ids) this.tombstone(id);
				p.deletionsSeen = d.seen;
				if (!d.truncated && this.number("SELECT count(*) AS n FROM tombstones") < d.total) p.deletionsSeen = null;
			}
			this.crash?.("after_records");
			const coverage = page.room.coverage;
			if (coverage && (!p.target || coverage.through.sequence >= p.target.through.sequence)) p.target = coverage;
			if (!p.frontier && !p.before && page.window.omission_reason === "history_before_window") p.before = page.window.next_cursor;
			if (!p.frontier && coverage) {
				p.frontier = coverage;
				p.before = page.window.omission_reason === "history_before_window" ? page.window.next_cursor : null;
			}
			if (kind === "older") {
				p.before = page.window.has_more ? page.window.next_cursor : null;
				if (coverage) p.frontier = coverage;
			}
			if (kind === "repair") {
				if (!p.before && p.repair === "head" && page.window.has_more) p.before = page.window.next_cursor;
				p.repair = page.window.has_more && page.window.next_cursor ? { before: page.window.next_cursor } : null;
			}
			if (p.repair && this.suffixComplete(p)) p.repair = null;
			if (p.target && p.frontier && !this.suffixComplete(p) && !p.repair) {
				p.repair = page.window.omission_reason === "history_before_window" && page.window.next_cursor ? { before: page.window.next_cursor } : "head";
			}
			p.complete = false;
			if (p.target && !d?.truncated && !(d && p.deletionsSeen === null)) {
				const held = this.number("SELECT count(*) AS n FROM messages WHERE sequence<=?", p.target.through.sequence);
				const deleted = this.number("SELECT count(*) AS n FROM messages WHERE sequence<=? AND state='deleted'", p.target.through.sequence);
				const open = new Set(p.target.open_message_ids);
				const unsettled = this.db.prepare("SELECT id FROM messages WHERE sequence<=? AND state='in_progress' LIMIT 501").all(p.target.through.sequence).some(r => !open.has(String(r.id)));
				if (coverage && page.room.open_check !== null && d !== null && held === p.target.eligible_count && deleted >= p.target.deleted_count && !unsettled && !p.repair) {
					p.complete = true; p.before = null; p.frontier = p.target;
				}
				if (held > p.target.eligible_count) {
					// An observed hard delete/corrupt extra row is different from an
					// unfinished history. Rebuild this derived copy, never the server.
					this.db.exec("DELETE FROM messages; DELETE FROM tombstones; DELETE FROM meta WHERE key LIKE 'snapshot:%';");
					Object.assign(p, structuredClone(EMPTY), { repair: "head" });
				} else {
					if (deleted < p.target.deleted_count) p.deletionsSeen = null;
					// Missing prefixes continue; they are never treated as corruption.
					if (!p.before && !p.repair && held < p.target.eligible_count) p.repair = "head";
				}
			}
			p.observedAt = now;
			this.setMeta("progress", p);
			// A quiet initial room may arrive entirely through read-only recovery.
			// Bootstrap missing views there, but an old background reply cannot
			// overwrite newer foreground snapshots lacking server timestamps.
			const capture = (key: string) => kind === "live" || this.meta(`snapshot:${key}`) === undefined;
			if (capture("plans") && pkg.activeSessionPlans !== undefined) this.snapshot("plans", pkg.activeSessionPlans, true, now);
			if (capture("polls")) {
				if (pkg.sessionPolls !== undefined) this.snapshot("polls", pkg.sessionPolls, true, now);
				else if (pkg.advisoryRejections?.includes("session_polls")) this.snapshot("polls", null, false, now);
			}
			if (capture("discussion") && pkg.stillToDiscuss !== undefined) this.snapshot("discussion", pkg.stillToDiscuss, pkg.stillToDiscuss !== null, now);
			const activity = pkg.sessionActivity;
			const priorActivity = this.meta<ObservedSnapshot<StoredActivityIndex>>("snapshot:activity");
			if (capture("activity") || (activity && Date.parse(activity.as_of) > Date.parse(priorActivity?.value?.as_of ?? "1970-01-01T00:00:00Z"))) {
				const index: StoredActivityIndex | null = activity ? {
					version: 1, as_of: activity.as_of, truncated: activity.truncated,
					entries: activity.entries.map(({ kind, id, relation }) => ({ kind, id, relation })),
				} : null;
				this.snapshot("activity", index, Boolean(activity && activity.status === "available"), now);
			}
			if (pkg.sessionEvents !== undefined) this.mergeEvents(pkg.sessionEvents, now);
			// This is a delivery observation, NOT the current pending-notice inventory.
			if (kind === "live" && pkg.systemNotices.length) this.snapshot("notice_delivery", pkg.systemNotices.map(n => ({ notice_id: n.notice_id, task_id: n.kind === "unlinked_commit_item_review" ? n.task_id : null, kind: n.kind })), true, now);
			this.assertCurrent(); this.crash?.("before_commit");
			this.db.exec("COMMIT"); committed = true;
			this.online = true; this.failure = false;
			this.crash?.("after_commit");
		} catch (error) {
			this.failure = true; this.online = false;
			if (begun && !committed) {
				try { this.db.exec("ROLLBACK"); } catch { /* SQLite may already have rolled back an I/O failure. */ }
			}
			throw error;
		}
	}

	watch(): { room_open_message_ids: string[]; room_deletions_seen: DeletionSeen | null } {
		this.assertCurrent();
		return { room_open_message_ids: this.db.prepare("SELECT id FROM messages WHERE state='in_progress' ORDER BY sequence LIMIT 500").all().map(r => String(r.id)), room_deletions_seen: this.progress().deletionsSeen };
	}
	eventsWatch(): { session_events_version: 1; session_events_revision: string | null } {
		this.assertCurrent();
		return { session_events_version: 1, session_events_revision: this.meta<StoredEventStatus>("session_events_status")?.revision ?? null };
	}
	nextRepair(): { kind: "older" | "repair"; before?: string } | null {
		this.assertCurrent(); const p = this.progress();
		if (this.failure || (!p.target && !p.before)) return { kind: "repair" };
		if (p.repair) return { kind: "repair", ...(p.repair === "head" ? {} : { before: p.repair.before }) };
		if (p.before) return { kind: "older", before: p.before };
		return !p.complete ? { kind: "repair" } : null;
	}
	contact(): void { this.assertCurrent(); this.online = true; utimesSync(this.path, new Date(), new Date()); }
	markOffline(): void { this.online = false; }
	markBehind(): void {
		this.assertCurrent(); const p = this.progress();
		p.complete = false; p.repair = "head";
		this.setMeta("progress", p); this.online = true;
	}
	status(): { complete: boolean; online: boolean; storageError: boolean; observedAt: string | null; through: RoomCoverage["through"] | null; records: number } {
		this.assertCurrent(); const p = this.progress();
		return { complete: p.complete && !this.failure, online: this.online, storageError: this.failure, observedAt: p.observedAt, through: p.target?.through ?? null, records: this.number("SELECT count(*) AS n FROM messages") };
	}
	/** Internal bounded read primitive. Public native readers are a separate slice. */
	read(before = Number.MAX_SAFE_INTEGER, limit = 50): StoredRoomRecord[] {
		this.assertCurrent();
		return this.db.prepare("SELECT body FROM messages WHERE sequence<? ORDER BY sequence DESC LIMIT ?").all(before, Math.max(1, Math.min(100, Math.trunc(limit)))).map(r => JSON.parse(String(r.body)) as StoredRoomRecord);
	}
	activity(): ObservedSnapshot<StoredActivityIndex> | undefined { this.assertCurrent(); return this.meta("snapshot:activity"); }
	/** Versioned last-observed views; absence is never an authoritative empty list. */
	state(): { version: 1; snapshots: Record<string, ObservedSnapshot | null> } {
		this.assertCurrent();
		return { version: 1, snapshots: Object.fromEntries(["plans", "polls", "discussion", "activity", "question_event", "notice_delivery"].map(key => [key, this.meta<ObservedSnapshot>(`snapshot:${key}`) ?? null])) };
	}
	/** A row Pi itself posted (exact receipt id): never unread for this agent (ce1ffca1). */
	markOwn(messageIds: readonly string[]): void { this.mark("own", messageIds.map(id => [id.toLowerCase(), ""] as const)); }
	/** The model was TOLD these exist (a delivered command). Never a read mark. */
	markPresented(keys: readonly string[]): void { this.mark("presented", keys.map(key => [key, ""] as const)); }
	private mark(kind: RoomMarkKind, entries: ReadonlyArray<readonly [string, string]>): void {
		this.assertCurrent();
		if (!entries.length) return;
		this.db.exec("BEGIN IMMEDIATE");
		try { writeRoomMarks(this.db, kind, entries); this.db.exec("COMMIT"); }
		catch (error) { try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
	}
	/** A last-observed event pointer, not a pending-question inventory or an ACK. */
	observeQuestion(event: { question_id: string; event_id: string; kind: string }, now = new Date().toISOString()): void {
		this.assertCurrent();
		this.snapshot("question_event", { question_id: event.question_id, event_id: event.event_id, kind: event.kind }, true, now);
	}
	close(purge = false): void {
		if (!this.closed) { this.closed = true; this.online = false; this.db.close(); }
		if (purge) { rmSync(this.path, { force: true }); rmSync(`${this.path}-journal`, { force: true }); }
	}
}
