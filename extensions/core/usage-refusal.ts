/**
 * DevSpec Pi — telling DevSpec when this agent's model provider refuses it for
 * usage (task 04a1fe8f; server item 4d744b7b; the remote-ingress contract's
 * semantics.check_job.usage_refusal).
 *
 * A Pi whose provider has stopped it (a rate-limit stop, an exhausted quota, a
 * provider's usage 429) cannot run a turn until that lifts, so a check job
 * offered to it would sit there unruled while the work it checks waits. The
 * host reports `usage_refused_until` on its status updates (heartbeat_connection
 * and poll_connection): the time the refusal said it lifts, or a short bounded
 * cool-off when it gave none. It is sent with each status update while it
 * stands, and null once a turn succeeds. While it is ahead DevSpec offers this
 * agent no check job and hands any it holds to the next in line; the agent still
 * shows online.
 *
 * Only an actual refusal counts. A usage percentage is never one: some accounts
 * keep working past 100% of a reported limit. And a run that Pi's own automatic
 * retries carried through was never refused, so the report is decided once the
 * run is over, from how its last model call ended.
 */

/**
 * How long Pi reports a refusal that did not say when it lifts. Short on
 * purpose: a Pi that is still refused when it passes is refused again on its
 * next turn and reports again, while one that is not gets check jobs back.
 */
export const USAGE_REFUSAL_COOL_OFF_MS = 5 * 60_000;

/**
 * The server stores a reported time at most seven days ahead
 * (USAGE_REFUSAL_MAX_AHEAD_MS in DevSpecV2 packages/core/src/connections/usage-refusal.ts),
 * the longest window any provider reports. Pi holds a parsed hint to the same
 * bound so what it sends is what DevSpec keeps.
 */
export const USAGE_REFUSAL_MAX_AHEAD_MS = 7 * 24 * 60 * 60_000;

/**
 * Provider wording for a usage refusal. Overload and server errors (529, 5xx,
 * "overloaded") are capacity, not usage, and are left out, as is the context
 * window: neither is the account being refused.
 */
const USAGE_REFUSAL_PATTERN = new RegExp([
	"rate.?limit", // rate_limit_error, "Rate limit exceeded", "rate limited"
	"too many requests",
	"\\b429\\b",
	"usage.?limit", // usage_limit_reached, GoUsageLimitError, "You have hit your ChatGPT usage limit"
	"quota", // insufficient_quota, "quota exceeded", "exceeded your current quota"
	"resource.?exhausted", // Google's RESOURCE_EXHAUSTED
	"out of budget",
	"credit balance", // "Your credit balance is too low"
].join("|"), "i");

/** Whether a failed model call's error text is a usage refusal. */
export function isUsageRefusal(errorMessage: string | null | undefined): boolean {
	return typeof errorMessage === "string" && USAGE_REFUSAL_PATTERN.test(errorMessage);
}

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
	[/^(?:ms|msecs?|milliseconds?)$/i, 1],
	[/^(?:s|secs?|seconds?)$/i, 1_000],
	[/^(?:m|mins?|minutes?)$/i, 60_000],
	[/^(?:h|hrs?|hours?)$/i, 3_600_000],
	[/^(?:d|days?)$/i, 86_400_000],
];

function unitMs(unit: string): number | null {
	for (const [pattern, ms] of UNIT_MS) if (pattern.test(unit)) return ms;
	return null;
}

/** "1h 30m", "~5 min", "16 seconds", "2.5s": the sum, or null when nothing reads. */
function durationMs(text: string): number | null {
	const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)];
	let total = 0;
	let read = false;
	for (const [, amount, unit] of parts) {
		const ms = unitMs(unit!);
		if (ms === null) break;
		total += Number(amount) * ms;
		read = true;
	}
	return read ? total : null;
}

/**
 * When the refusal says it lifts, as epoch milliseconds, or null when it does
 * not say. Reads the forms providers and Pi's own retry layer use: "try again in
 * ~12 min", "retry after 16 seconds", "resets in 3h 20m", "Server requested 90s
 * retry delay", "retry-after: 30" and "resets at <ISO time>".
 */
export function refusalLiftsAt(errorMessage: string, nowMs: number): number | null {
	const at = /\bresets?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(errorMessage);
	if (at) {
		const ms = Date.parse(at[1]!);
		if (Number.isFinite(ms)) return ms;
	}
	const relative = /\b(?:try(?:ing)? again|retry(?:ing)?|resets?|available again)\s+(?:in|after)\s+~?\s*((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(errorMessage);
	if (relative) {
		const ms = durationMs(relative[1]!);
		if (ms !== null) return nowMs + ms;
	}
	const requested = /\brequested\s+(\d+(?:\.\d+)?)\s*s\s+retry delay/i.exec(errorMessage);
	if (requested) return nowMs + Number(requested[1]) * 1_000;
	const header = /\bretry-after\s*[:=]?\s*(\d+(?:\.\d+)?)\b/i.exec(errorMessage);
	if (header) return nowMs + Number(header[1]) * 1_000;
	return null;
}

/** The time a refusal is reported until: its own, else the cool-off, held to the server's bound. */
export function reportedRefusalUntil(errorMessage: string, nowMs: number): number {
	const said = refusalLiftsAt(errorMessage, nowMs);
	const until = said !== null && said > nowMs ? said : nowMs + USAGE_REFUSAL_COOL_OFF_MS;
	return Math.min(until, nowMs + USAGE_REFUSAL_MAX_AHEAD_MS);
}

/** The field a status update carries: absent (unchanged), a time, or null (cleared). */
export type UsageRefusalField = { usage_refused_until?: string | null };

/** The parts of a finished model call this reads (Pi's AssistantMessage). */
export interface ModelCallEnd {
	stopReason?: string | null;
	errorMessage?: string | null;
}

/**
 * What this Pi tells DevSpec about a usage refusal. One per Pi process: the
 * refusal belongs to this agent's provider account, whichever connection it is
 * bonded as.
 */
export class UsageRefusalReport {
	/** Epoch ms the standing refusal is reported until, or null when none stands. */
	private untilMs: number | null = null;
	/** How the current run's last model call ended: refused until, answered, or not yet known. */
	private runOutcome: { refusedUntilMs: number } | "answered" | null = null;
	/**
	 * Whether DevSpec may still hold a refusal from this agent. True at start, because a
	 * refusal reported before Pi restarted lasts until its time on the server, so the first
	 * turn that succeeds sends null once.
	 */
	private serverMayHoldRefusal = true;
	/** A turn succeeded since the last refusal: the next status update carries null. */
	private clearPending = false;

	/** A model call ended (Pi's message_end for an assistant message). */
	noteModelCall(call: ModelCallEnd, nowMs: number): void {
		if (call.stopReason === "error") {
			this.runOutcome = isUsageRefusal(call.errorMessage)
				? { refusedUntilMs: reportedRefusalUntil(call.errorMessage!, nowMs) }
				: null;
			return;
		}
		// A user's Stop says nothing about the provider; anything else is an answer.
		if (call.stopReason === "aborted") return;
		this.runOutcome = "answered";
		this.untilMs = null;
		if (this.serverMayHoldRefusal) this.clearPending = true;
	}

	/**
	 * The run is over (Pi's agent_settled). A run whose last model call was refused,
	 * after Pi's own retries, stands refused; a run that ended any other way changes
	 * nothing more.
	 */
	settleRun(): void {
		const outcome = this.runOutcome;
		this.runOutcome = null;
		if (outcome === null || outcome === "answered") return;
		this.untilMs = outcome.refusedUntilMs;
		this.serverMayHoldRefusal = true;
		this.clearPending = false;
	}

	/** What the next status update carries. */
	statusField(nowMs: number): UsageRefusalField {
		if (this.untilMs !== null && this.untilMs > nowMs) return { usage_refused_until: new Date(this.untilMs).toISOString() };
		// A time that has passed has lifted on the server too; null waits for a turn that succeeds.
		if (this.untilMs !== null) this.untilMs = null;
		return this.clearPending ? { usage_refused_until: null } : {};
	}

	/**
	 * A status update carrying `field` reached DevSpec. Status updates can overlap a
	 * run (a long poll is in flight while a turn ends), so a delivered null clears
	 * only when no refusal has come to stand since it was read.
	 */
	delivered(field: UsageRefusalField): void {
		if (field.usage_refused_until === undefined) return;
		if (field.usage_refused_until !== null) {
			this.serverMayHoldRefusal = true;
			return;
		}
		if (this.untilMs !== null) return;
		this.clearPending = false;
		this.serverMayHoldRefusal = false;
	}
}
