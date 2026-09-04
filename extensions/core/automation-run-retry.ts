/**
 * Revalidate an automation-run retry against the server-owned exact-target inbox.
 * A captured envelope explains what failed; only the current server read grants
 * authority after the transport cursor advances.
 */
export interface AutomationRunRetryInbox<T> {
	dispatches: readonly T[];
	/** True only for a server-confirmed exact identity read. */
	identityComplete: boolean;
}

export async function revalidateAutomationRunRetry<T>(input: {
	key: string;
	loadCurrentInbox: () => Promise<AutomationRunRetryInbox<T>>;
	identity: (value: T) => string | undefined;
	assertCurrent?: () => void;
	withdrawCurrent?: () => void;
	enqueueCurrent: (value: T) => void;
}): Promise<"enqueued" | "withdrawn" | "retry"> {
	const inbox = await input.loadCurrentInbox();
	input.assertCurrent?.();
	const current = inbox.dispatches.find((value) => input.identity(value) === input.key);
	if (!current) {
		if (!inbox.identityComplete) return "retry";
		input.withdrawCurrent?.();
		return "withdrawn";
	}
	input.assertCurrent?.();
	input.enqueueCurrent(current);
	return "enqueued";
}
