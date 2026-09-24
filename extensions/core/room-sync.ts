/** Bounded, read-only history recovery beside the existing foreground pump. */
import type { PollPackage } from "./remote-payload.ts";
import type { RoomStore } from "./room-store.ts";

export interface RoomSyncOptions {
	store: RoomStore;
	current(): boolean;
	liveCursor(): string | undefined;
	fetchHistory(args: Record<string, unknown>): Promise<PollPackage>;
	/** Wake the existing transport waiter, never the model. */
	wake(): void;
	onError(): void;
	/** At most12 recovery requests/minute; shared client cooldown still applies. */
	intervalMs?: number;
}
export class RoomSync {
	readonly store: RoomStore;
	private options: RoomSyncOptions;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = false;
	constructor(options: RoomSyncOptions) { this.options = options; this.store = options.store; }
	private current(): boolean { return !this.stopped && this.options.current(); }
	observe(pkg: PollPackage): void {
		if (!this.current()) return;
		try {
			if (pkg.roomPage) this.store.apply(pkg);
			else if (pkg.canonicalState === "idle") this.store.contact();
			else this.store.markBehind();
			// A partial tombstone listing must continue even if SSE sees no insert.
			if (pkg.roomPage?.room.deletions && (pkg.roomPage.room.deletions.truncated || this.store.watch().room_deletions_seen === null)) this.options.wake();
			if (pkg.roomPage?.room.open_check?.some(c => c.state !== "in_progress")) this.options.wake();
			this.schedule();
		} catch { this.store.markOffline(); this.options.onError(); }
	}
	schedule(): void {
		if (!this.current() || this.running || this.timer || !this.options.liveCursor()) return;
		try { if (!this.store.nextRepair()) return; }
		catch { this.store.markOffline(); this.options.onError(); return; }
		this.timer = setTimeout(() => { this.timer = undefined; void this.repairOnce(); }, this.options.intervalMs ?? 5_000);
		this.timer.unref?.();
	}
	/** Public for deterministic transport tests; never a model tool. */
	async repairOnce(): Promise<void> {
		if (!this.current() || this.running) return;
		const cursor = this.options.liveCursor();
		if (!cursor) return; // catch_up WITHOUT a cursor is not a read-only lane.
		this.running = true;
		try {
			const next = this.store.nextRepair();
			if (!next) return;
			const pkg = await this.options.fetchHistory({
				cursor_v2: cursor, catch_up: true,
				...(next.before ? { catch_up_cursor: next.before } : {}),
				...this.store.watch(),
			});
			if (!this.current()) return;
			if (pkg.canonicalState !== "valid" || !pkg.roomPage?.history || pkg.ownerBundle || pkg.rejectedBundle || pkg.control || pkg.systemNotices.length) throw new Error("repair response is not inactive room history");
			this.store.apply(pkg, next.kind);
			if (pkg.roomPage.room.deletions && (pkg.roomPage.room.deletions.truncated || this.store.watch().room_deletions_seen === null)) this.options.wake();
		} catch { if (this.current()) { this.store.markOffline(); this.options.onError(); } }
		finally { this.running = false; if (this.current()) this.schedule(); }
	}
	close(purge = false): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		try { this.store.close(purge); }
		catch { this.options.onError(); } // cleanup cannot break detach/shutdown
	}
}
