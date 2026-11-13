/**
 * DevSpec Pi — reaching DevSpec when interactive Pi starts (item dffdc30a).
 *
 * Pi runs every extension's session_start handler, one after another, before
 * it takes the first prompt, and interactive Pi connects to DevSpec in that
 * handler. A DevSpec server that accepted connections but never replied used
 * to hold the first prompt for minutes. Ali Price decided the limits on
 * 13 Nov 2026: start-up waits at most 30 seconds for DevSpec, then carries on
 * without it, says so once, and tries again every 30 seconds in the background
 * for as long as the session is open, so the agent appears on the Agents page
 * as soon as DevSpec answers. The limit covers only whether DevSpec can be
 * reached; nothing else about start-up changes.
 *
 * Pure node, no pi imports — unit-testable under `node --test`.
 */

/** How long start-up, and each background attempt, waits for DevSpec to answer. */
export const DEVSPEC_REACH_LIMIT_MS = 30_000;

/** How often Pi tries again after start-up gave up: attempt starts are this far apart. */
export const DEVSPEC_RETRY_INTERVAL_MS = 30_000;

export interface ReachTiming {
	/** How long start-up, and each background attempt, waits for DevSpec. */
	limitMs: number;
	/** How far apart background attempts start. */
	intervalMs: number;
}

// On globalThis, like the lane client factory: Pi loads each extension file
// with its own module graph.
const TIMING_KEY = "__devspecPiReachTimingForTests";

/** The limits in force: always Ali's 30 s and 30 s, except under a test's override. */
export function reachTiming(): ReachTiming {
	const override = (globalThis as unknown as Record<string, ReachTiming | null | undefined>)[TIMING_KEY];
	return override ?? { limitMs: DEVSPEC_REACH_LIMIT_MS, intervalMs: DEVSPEC_RETRY_INTERVAL_MS };
}

/** Test-only: shorten both limits so a test need not wait 30 real seconds. `null` restores them. */
export function setReachTimingForTests(timing: ReachTiming | null): void {
	(globalThis as unknown as Record<string, ReachTiming | null>)[TIMING_KEY] = timing;
}

/**
 * Emitted on Pi's shared event bus when a background attempt connects: DevSpec
 * is answering again, so another extension's "offline" mark is out of date.
 */
export const DEVSPEC_REACHABLE_EVENT = "devspec:reachable";

/** Said once, when start-up gives up on DevSpec. */
export const DEVSPEC_UNREACHABLE_NOTICE =
	"DevSpec could not be reached, so Pi is carrying on without it. " +
	"Pi keeps trying in the background and connects as soon as DevSpec answers.";

/** What one background attempt found: keep trying, or stop (connected, refused, or no longer wanted). */
export type BackgroundConnectStep = "retry" | "done";

export interface BackgroundConnectOptions {
	/** One attempt. Never runs twice at once. A throw counts as "retry". */
	attempt: () => Promise<BackgroundConnectStep>;
	intervalMs?: number;
	now?: () => number;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

function realTimer(run: () => void, ms: number): unknown {
	const handle = setTimeout(run, ms);
	// Never keep a process alive just to retry a connection.
	(handle as { unref?: () => void }).unref?.();
	return handle;
}

/**
 * Background retries after start-up gave up on DevSpec. Attempts start
 * `intervalMs` apart, measured start to start, and never overlap: an attempt
 * still running when the next is due delays it until it ends. Nothing waits on
 * this; it only runs attempts until one says "done" or it is cancelled.
 */
export class BackgroundConnect {
	private readonly attempt: () => Promise<BackgroundConnectStep>;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly setTimer: (run: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private timer: unknown = null;
	private inFlight: Promise<BackgroundConnectStep> | null = null;
	/** Bumped by start and cancel, so an attempt from an earlier run cannot reschedule. */
	private generation = 0;
	private live = false;

	constructor(options: BackgroundConnectOptions) {
		this.attempt = options.attempt;
		this.intervalMs = options.intervalMs ?? DEVSPEC_RETRY_INTERVAL_MS;
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? realTimer;
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	/** Whether retries are scheduled or running. */
	get active(): boolean {
		return this.live;
	}

	/** Schedule the first attempt one interval from now. A no-op while already active. */
	start(): void {
		if (this.live) return;
		this.live = true;
		this.generation += 1;
		this.schedule(this.intervalMs, this.generation);
	}

	/** Stop retrying. An attempt already running finishes, but nothing follows it. */
	cancel(): void {
		this.live = false;
		this.generation += 1;
		if (this.timer !== null) this.clearTimer(this.timer);
		this.timer = null;
	}

	private schedule(ms: number, generation: number): void {
		this.timer = this.setTimer(() => {
			this.timer = null;
			void this.run(generation);
		}, Math.max(0, ms));
	}

	private async run(generation: number): Promise<void> {
		if (generation !== this.generation || !this.live) return;
		// An attempt left running by an earlier start/cancel finishes first.
		if (this.inFlight) await this.inFlight.catch(() => "retry");
		if (generation !== this.generation || !this.live) return;
		const startedAt = this.now();
		const attempt = this.attempt();
		this.inFlight = attempt;
		let step: BackgroundConnectStep;
		try {
			step = await attempt;
		} catch {
			step = "retry";
		} finally {
			if (this.inFlight === attempt) this.inFlight = null;
		}
		if (generation !== this.generation || !this.live) return;
		if (step === "done") {
			this.live = false;
			return;
		}
		this.schedule(this.intervalMs - (this.now() - startedAt), generation);
	}
}
