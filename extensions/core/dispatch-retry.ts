/**
 * Revalidate retry identity against the server-owned live dispatch inbox.
 * A captured envelope explains what failed; it is never durable authority to
 * start work after the dispatch cursor has advanced.
 */
export interface DispatchRetryInbox<T> {
	dispatches: readonly T[];
	/** True only for a server-confirmed exact identity read. */
	identityComplete: boolean;
}

export async function revalidateDispatchRetry<T>(input: {
	key: string;
	loadCurrentInbox: () => Promise<DispatchRetryInbox<T>>;
	identity: (dispatch: T) => string | undefined;
	assertCurrent?: () => void;
	withdrawCurrent?: () => void;
	enqueueCurrent: (dispatch: T) => void;
}): Promise<"enqueued" | "withdrawn" | "retry"> {
	const inbox = await input.loadCurrentInbox();
	input.assertCurrent?.();
	const current = inbox.dispatches.find((dispatch) => input.identity(dispatch) === input.key);
	if (!current) {
		if (!inbox.identityComplete) return "retry";
		input.withdrawCurrent?.();
		return "withdrawn";
	}
	input.assertCurrent?.();
	input.enqueueCurrent(current);
	return "enqueued";
}
