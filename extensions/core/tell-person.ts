/**
 * DevSpec's tell_person mark on a write's result (item a868f41f, "Telling a
 * person anyway"; served contract semantics.notice_audience.telling_anyway).
 *
 * A write that changed a record its requester does not own comes back with one
 * extra text block, `{"tell_person": {...}}`, appended after the result itself.
 * Pi reads the mark mechanically, never the wording around it: a run that is
 * quiet by what woke it (run-voice.ts) speaks once one of its writes carries it.
 *
 * The tools extension sees the raw result and the remote extension owns the
 * run, so the mark crosses between them by tool call id, in one process-wide
 * store (the same pattern as the system-notice store).
 */

/** The key the mark travels under on the appended block. */
export const TELL_PERSON_RESULT_KEY = "tell_person";
/** Marks not yet taken by a run; old ones fall off so a missed take cannot grow it. */
const MAX_PENDING_MARKS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether DevSpec appended a tell_person mark to this result (`UnwrappedResult.appended`). */
export function carriesTellPerson(appended: readonly unknown[] | undefined): boolean {
	return (appended ?? []).some((block) => isRecord(block) && isRecord(block[TELL_PERSON_RESULT_KEY]));
}

const STORE_KEY = Symbol.for("devspec.pi.tell-person.v1");

function store(): Set<string> {
	const root = globalThis as typeof globalThis & { [STORE_KEY]?: Set<string> };
	if (!root[STORE_KEY]) root[STORE_KEY] = new Set();
	return root[STORE_KEY];
}

/** The tools extension: this tool call's write carried the mark. */
export function noteTellPerson(toolCallId: string): void {
	if (!toolCallId) return;
	const pending = store();
	pending.add(toolCallId);
	while (pending.size > MAX_PENDING_MARKS) {
		const oldest = pending.values().next().value;
		if (oldest === undefined) break;
		pending.delete(oldest);
	}
}

/** The remote extension, once per finished tool call: whether its write carried the mark. */
export function takeTellPerson(toolCallId: string): boolean {
	return store().delete(toolCallId);
}

export function resetTellPersonForTests(): void {
	store().clear();
}
