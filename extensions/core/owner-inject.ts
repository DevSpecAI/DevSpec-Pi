/**
 * Owner-command inject hygiene (items aa98098f, 09d4993e).
 *
 * Rebond starts a new pump with no cursor. The first poll is catch-up
 * (already-answered history). If that lap is an empty wake, `synced`
 * must not flip — the next cursor-less poll is still catch-up.
 *
 * Only PRE-ATTACH commands on that lap are history. A live owner
 * command created at/after this bond attached must still be delivered
 * even when it rides the cursor-less window (live miss: Ali 2026-08-13,
 * “can you pick up from here?” swallowed on Rapid Quokka’s first sync).
 *
 * send("now") while the runtime is busy prints
 * "already processing" and is fire-and-forget — we cannot catch it.
 * Never choose `now` unless idle at send time.
 */

import type { OwnerCommand } from "./remote-payload.ts";
import { sendModeFor, type OwnerDeliveryMode, type OwnerSendMode } from "./preempt.ts";

type OwnerCommandIdentity = Pick<OwnerCommand, "id"> & Partial<Pick<OwnerCommand, "text" | "createdAt" | "userName">>;

export type BundleReservation = "reserved" | "seen" | "conflict";

export class SeenOwnerCommands {
	private readonly ids = new Set<string>();
	private readonly inFlight = new Set<string>();

	private addSeen(id: string): void {
		// Stable ids are never evicted during this pump generation: cursor state is
		// primary, but replay defense must not become time/volume dependent.
		this.ids.add(id);
	}

	remember(commands: readonly OwnerCommandIdentity[]): void {
		for (const cmd of commands) this.addSeen(cmd.id);
	}

	/** Reserve all ids in one canonical turn or none of them. */
	reserveBundle(commands: readonly OwnerCommandIdentity[]): BundleReservation {
		if (commands.length === 0) return "conflict";
		const ids = commands.map((command) => command.id);
		const seenCount = ids.filter((id) => this.ids.has(id)).length;
		if (seenCount === ids.length) return "seen";
		if (seenCount > 0 || ids.some((id) => this.inFlight.has(id))) return "conflict";
		for (const id of ids) this.inFlight.add(id);
		return "reserved";
	}

	commitBundle(commands: readonly OwnerCommandIdentity[]): void {
		for (const command of commands) {
			this.inFlight.delete(command.id);
			this.addSeen(command.id);
		}
	}

	releaseBundle(commands: readonly OwnerCommandIdentity[]): void {
		for (const command of commands) this.inFlight.delete(command.id);
	}

	/** Reserve unseen commands without committing replay state yet. */
	takeUnseen<T extends OwnerCommandIdentity>(commands: readonly T[]): T[] {
		const out: T[] = [];
		for (const cmd of commands) {
			if (this.ids.has(cmd.id) || this.inFlight.has(cmd.id)) continue;
			this.inFlight.add(cmd.id);
			out.push(cmd);
		}
		return out;
	}

	/** Commit only after hidden context + hydrated command were accepted by Pi. */
	commit(command: Pick<OwnerCommandIdentity, "id">): void {
		this.inFlight.delete(command.id);
		this.addSeen(command.id);
	}

	/** Release a failure so the unchanged canonical cursor can retry it. */
	release(command: Pick<OwnerCommandIdentity, "id">): void {
		this.inFlight.delete(command.id);
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}

	isInFlight(id: string): boolean {
		return this.inFlight.has(id);
	}

	get size(): number {
		return this.ids.size;
	}
}

export function parseTimestampMs(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

/** Prefer the server attach stamp; otherwise the moment the pump started. */
export function resolveAttachedAtMs(value: unknown, fallbackMs: number): number {
	return parseTimestampMs(value) ?? fallbackMs;
}

/**
 * Split the cursor-less catch-up window into already-answered history
 * (created before this bond attached) and live first-touch commands.
 * Missing/unparseable created_at is live — dropping an instruction is worse
 * than a possible replay.
 */
export function splitCatchUpCommands<T extends OwnerCommandIdentity>(
	commands: readonly T[],
	attachedAtMs: number,
): { historical: T[]; live: T[] } {
	const historical: T[] = [];
	const live: T[] = [];
	for (const cmd of commands) {
		const createdMs = parseTimestampMs(cmd.createdAt);
		if (createdMs !== null && createdMs < attachedAtMs) historical.push(cmd);
		else live.push(cmd);
	}
	return { historical, live };
}

/**
 * First poll after rebond: adopt cursors, remember historical ids.
 * An empty wake (no cursor, no commands) is not a completed sync — the
 * next cursor-less poll is still the catch-up window.
 */
export function shouldCompleteSync(pkg: {
	cursor?: string;
	ownerCommands: readonly OwnerCommand[];
}): boolean {
	return Boolean(pkg.cursor) || pkg.ownerCommands.length > 0;
}

/** Never `now` unless the runtime is idle right now. */
export function sendModeAtSendTime(
	mode: OwnerDeliveryMode,
	idleNow: boolean,
	settled = false,
): OwnerSendMode {
	if (mode === "immediate" && !idleNow) return "steer";
	if (mode === "preempt") return sendModeFor(mode, settled && idleNow);
	return sendModeFor(mode, settled);
}
