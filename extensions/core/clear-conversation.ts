/**
 * Clear this agent's conversation for the owner's CONTROL `clear` (item 6beb89c6).
 *
 * Pi's own tree navigation, back to just before the first thing the agent was told
 * (a message, or a context message DevSpec added): the model's context is empty
 * again, and the session is the same one, so the DevSpec connection, which is keyed
 * by the session id, stays bonded and in its room. The old conversation stays in the session tree, reachable with /tree. A new
 * session (/new) would replace the session id, and with it the connection.
 *
 * The context DevSpec adds (instructions, repository facts, room orientation) is
 * added again on the next turn, because each is added whenever the branch lacks it.
 *
 * Navigating to a message puts its text back into an empty editor. That is
 * right for /tree, where the person means to edit and resend it, and wrong here:
 * nobody asked to resend anything, so the editor is left as it was.
 */

/** The part of a session entry this reads. */
export interface BranchEntryLike {
	id: string;
	type: string;
	message?: { role?: string };
}

/**
 * The first thing the agent was told on this branch, or null when it has been told
 * nothing. Entries before it (the model and thinking level the session started
 * with) are settings, not conversation, and stay.
 */
export function firstConversationEntryId(branch: readonly BranchEntryLike[]): string | null {
	return branch.find((entry) =>
		entry.type === "custom_message" || (entry.type === "message" && entry.message?.role === "user"))?.id ?? null;
}

export interface ClearConversationHost {
	/** The current branch, root first (`sessionManager.getBranch()`). */
	branch(): readonly BranchEntryLike[];
	navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
	getEditorText(): string;
	setEditorText(text: string): void;
}

export type ClearOutcome = "cleared" | "already_clear";

export async function clearConversation(host: ClearConversationHost): Promise<ClearOutcome> {
	const target = firstConversationEntryId(host.branch());
	if (!target) return "already_clear";
	const editorBefore = host.getEditorText();
	const result = await host.navigateTree(target);
	if (result.cancelled) throw new Error("Pi cancelled clearing the conversation.");
	if (host.getEditorText() !== editorBefore) host.setEditorText(editorBefore);
	return "cleared";
}
