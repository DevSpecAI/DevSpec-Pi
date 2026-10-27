/** Exact local admission uses existing attempt IDs, never speech or latest-at-completion. */
export interface LocalActivityScope {
	connection_id: string;
	expected_session_id: string;
	expected_attachment_id: string;
	expected_attached_at: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function startLocalActivity(input: {
	scope: LocalActivityScope;
	attemptId: string;
	previousAttemptId: string | null;
	current: () => boolean;
	request: (args: Record<string, unknown>) => Promise<unknown>;
}): Promise<string | null> {
	const { scope, attemptId, current, request } = input;
	let previous = input.previousAttemptId;
	try {
		for (let retry = 0; retry < 2; retry++) {
			if (!current()) return null;
			const raw = await request({ ...scope, local_activity_version: 1, local_turn: true,
				attempt_id: attemptId, previous_attempt_id: previous });
			if (!current() || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
			const result = raw as Record<string, unknown>;
			if (result.connection_id !== scope.connection_id || result.attempt_id !== attemptId ||
				result.expected_session_id !== scope.expected_session_id || result.expected_attachment_id !== scope.expected_attachment_id ||
				typeof result.expected_attached_at !== "string" || Date.parse(result.expected_attached_at) !== Date.parse(scope.expected_attached_at)) return null;
			if (result.status === "working" && typeof result.already_started === "boolean") return attemptId;
			if (result.status !== "predecessor_changed" || typeof result.previous_attempt_id !== "string" || !uuid.test(result.previous_attempt_id)) return null;
			previous = result.previous_attempt_id;
		}
	} catch { /* Unknown admission never becomes a completion identity. */ }
	return null;
}
