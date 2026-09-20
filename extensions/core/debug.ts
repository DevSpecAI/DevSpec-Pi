/**
 * DevSpec Pi — debug log (shared, env-gated).
 *
 * DEVSPEC_DEBUG_REMOTE=1 appends privacy-safe pump/recall/lifecycle metadata
 * to a platform-native temporary file. Cross-extension-file safe
 * (append-only). Event labels and numeric/boolean field names are closed here;
 * unknown runtime input is dropped. Prompt text, instructions, context
 * contents, arguments, results, credentials, names and provider payloads have
 * no representable field.
 */

import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEVSPEC_DEBUG_LOG_PATH = join(tmpdir(), "devspec-remote-debug.log");

const DEBUG_FIELDS = {
	"adapter guard applied": ["serverCount", "deactivatedTools"],
	"adapter guard failed": ["errorPresent"],
	"adapter guard get tools failed": ["errorPresent"],
	"adapter guard persist failed": ["errorPresent"],
	"adapter guard set active tools failed": ["errorPresent"],
	"adapter guard turn failed": ["errorPresent"],
	"attachment adopted from server": ["attached"],
	"background task noted": ["pendingBg"],
	"background task resolved from tool result": ["pendingBg"],
	"canonical ingress rejected": ["errors", "errorPresent"],
	"canonical ingress synced": ["cursorPresent"],
	"commit ledger captured": [],
	"context budget": ["staticChars", "injectedChars", "resultCalls", "resultChars"],
	"control completed": ["resultPresent"],
	"control failed": ["messageChars"],
	"control reload": ["succeeded", "errorPresent"],
	"delivery boundary": ["completeTurn"],
	"duplicate-tool recovery": ["count"],
	"duplicate-tool recovery continue failed": ["errorPresent"],
	"duplicate-tool recovery persist failed": ["errorPresent"],
	"ensureTurn: not attached": [],
	"ensureTurn: tracking (run-scoped)": [],
	"interaction event application failed": ["errorPresent"],
	"interaction event persistence confirmation failed": ["errorPresent"],
	"interaction event exact-workflow guard rejected": ["errors"],
	"interaction event payload rejected": ["errors", "errorPresent"],
	"interaction preempt already aborted for event; awaiting idle": [],
	"interaction apply deferred": ["busy", "occupancyBusy", "ctxIdle"],
	"interaction authority revoked before agent start": [],
	"stale tool receipt abort": [],
	"launcher install": ["installed", "keptNewer", "current"],
	"launcher install failed": ["errorPresent"],
	"message_end: no turn": [],
	"poll recoverable": ["errors", "errorPresent"],
	"poll recoverable server response": ["ended", "reasonPresent"],
	"post delivery failed": ["skipped", "rejected", "malformed", "unknown"],
	"post stored": ["idempotent"],
	preempt: ["settled", "immediate"],
	"preempt: aborting running turn for owner instruction": [],
	"preempt: aborting running turn for question answer": [],
	"preempt: cleared stranded busy after unsettled abort": [],
	"push channel closed": ["reasonPresent"],
	"push channel connect failed": ["errorPresent"],
	"push ended recoverable": ["reasonPresent"],
	"push reconnect attempt": ["attempt", "delayMs"],
	"push reconnects exhausted — held long-poll fallback": [],
	"push unavailable — held long-poll fallback": [],
	"push wake": [],
	recall: ["queryChars", "newHits"],
	"recall failed": ["errorPresent"],
	"sender style repair": ["commands"],
	"sender styles without a delivered command": ["count"],
	"session agenda error": ["errorPresent"],
	"session agenda fetch failed": ["resultChars"],
	"session enriched": ["titlePresent", "ownerPresent", "tail", "agenda", "attachContext"],
	"session enrich error": ["errorPresent"],
	"session enrich fetch failed": ["resultChars"],
	"settle segment": ["completeTurn", "trailChars", "planFinal", "planMirror", "answerChars", "pendingBg", "harness", "bound"],
	"settle segment not attached": [],
	"wake adopted command turn": [],
	"settleTurn: no turn state": [],
	"settleTurn: settle": ["answerChars", "pendingBg", "harness"],
	speech: ["candidate", "process", "split", "chars", "tools", "closedStop"],
	"system notice idle delivery failed": ["errorPresent"],
	"system notice memory queue rejected": ["errors", "count"],
	"system notice settle drain failed": ["errorPresent"],
	"sync deferred: empty wake, still cursor-less": [],
	synced: ["cursorPresent", "historical", "live"],
	"synced with room digest": ["digestChars", "historical", "live"],
} as const;

type DebugEvent = keyof typeof DEBUG_FIELDS;
type DebugField = number | boolean;
type DebugFields<E extends DebugEvent> = Partial<Record<(typeof DEBUG_FIELDS)[E][number], DebugField>>;

/** Pure runtime boundary used by tests and by the file writer. */
export function formatDebugRecord(event: unknown, fields: unknown = {}): string | null {
	if (typeof event !== "string" || !Object.hasOwn(DEBUG_FIELDS, event)) return null;
	const allowed = new Set<string>(DEBUG_FIELDS[event as DebugEvent]);
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) return event;
	const suffix = Object.entries(fields as Record<string, unknown>)
		.filter(([key, value]) => allowed.has(key) && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))))
		.map(([key, value]) => `${key}=${value}`)
		.join(" ");
	return `${event}${suffix ? ` ${suffix}` : ""}`;
}

export function debugRemote<E extends DebugEvent>(event: E, fields: DebugFields<E> = {}): void {
	if (!process.env.DEVSPEC_DEBUG_REMOTE) return;
	const record = formatDebugRecord(event, fields);
	if (!record) return;
	try {
		appendFileSync(DEVSPEC_DEBUG_LOG_PATH, `${new Date().toISOString()} ${record}\n`);
	} catch {
		/* debug never breaks anything */
	}
}
