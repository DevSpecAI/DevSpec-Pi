/**
 * Owner-command inject hygiene (item aa98098f).
 *
 * Rebond starts a new pump with no cursor. The first poll is catch-up
 * (already-answered history). If that lap is an empty wake, `synced`
 * must not flip — the next cursor-less poll is still catch-up. Commands
 * seen on a skipped lap must never be injected later.
 *
 * send("now") while the runtime is busy prints
 * "already processing" and is fire-and-forget — we cannot catch it.
 * Never choose `now` unless idle at send time.
 */

import type { OwnerCommand } from "./remote-payload.ts";
import { sendModeFor, type OwnerDeliveryMode, type OwnerSendMode } from "./preempt.ts";

export class SeenOwnerCommands {
	private readonly ids = new Set<string>();

	remember(commands: readonly OwnerCommand[]): void {
		for (const cmd of commands) {
			if (cmd.id) this.ids.add(cmd.id);
		}
	}

	/** Commands that have not been seen. Marks them seen. */
	takeUnseen(commands: readonly OwnerCommand[]): OwnerCommand[] {
		const out: OwnerCommand[] = [];
		for (const cmd of commands) {
			if (cmd.id && this.ids.has(cmd.id)) continue;
			if (cmd.id) this.ids.add(cmd.id);
			out.push(cmd);
		}
		return out;
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}

	get size(): number {
		return this.ids.size;
	}
}

/**
 * First poll after rebond: adopt cursors, remember ids, deliver nothing.
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
