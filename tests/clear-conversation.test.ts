import assert from "node:assert/strict";
import { test } from "node:test";
import { clearConversation, firstConversationEntryId, type BranchEntryLike } from "../extensions/core/clear-conversation.ts";

const branch: BranchEntryLike[] = [
	{ id: "m0", type: "model_change" },
	{ id: "t0", type: "thinking_level_change" },
	{ id: "ctx", type: "custom_message" },
	{ id: "u1", type: "message", message: { role: "user" } },
	{ id: "a1", type: "message", message: { role: "assistant" } },
];

test("clears back to before the first thing the agent was told, keeping the session's settings", () => {
	assert.equal(firstConversationEntryId(branch), "ctx");
	assert.equal(firstConversationEntryId(branch.filter((entry) => entry.id !== "ctx")), "u1");
	assert.equal(firstConversationEntryId(branch.slice(0, 2)), null);
});

function host(entries: BranchEntryLike[], editor = "") {
	const state = { editor, navigatedTo: [] as string[] };
	return {
		state,
		branch: () => entries,
		navigateTree: async (targetId: string) => {
			state.navigatedTo.push(targetId);
			// What /tree does: the first message's text lands in an empty editor.
			if (!state.editor) state.editor = "the first message";
			return { cancelled: false };
		},
		getEditorText: () => state.editor,
		setEditorText: (text: string) => { state.editor = text; },
	};
}

test("navigates the tree and leaves the editor as it was", async () => {
	const empty = host(branch);
	assert.equal(await clearConversation(empty), "cleared");
	assert.deepEqual(empty.state.navigatedTo, ["ctx"]);
	assert.equal(empty.state.editor, "");
	const drafting = host(branch, "a half-typed note");
	await clearConversation(drafting);
	assert.equal(drafting.state.editor, "a half-typed note");
});

test("a conversation with nothing in it is already clear, and a cancelled clear is an error", async () => {
	const fresh = host(branch.slice(0, 2));
	assert.equal(await clearConversation(fresh), "already_clear");
	assert.deepEqual(fresh.state.navigatedTo, []);
	await assert.rejects(clearConversation({ ...host(branch), navigateTree: async () => ({ cancelled: true }) }));
});
