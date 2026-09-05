/**
 * DevSpec Pi — always-on workflow instructions (item 7de79db6).
 *
 * Injected into the system prompt via before_agent_start when a DevSpec token
 * resolves. Keep it TIGHT: every line here costs tokens on every turn.
 *
 * First-touch is mechanical (memory-card recall + attach agenda). This block
 * must not tell the model to search first, and must not dump the 76-verb map.
 * Keep only rules a tool cannot know.
 */

/** Bump when the block changes materially; handy for debugging drift reports. */
export const INSTRUCTIONS_VERSION = 12;

export function buildDevspecInstructions(): string {
	return `## DevSpec
This project is connected to DevSpec. Everyday verbs are active native tools. Find and load less-common verbs with \`search_devspec_tools\`. Do not connect a DevSpec MCP server.

- The loaded implementation contract alone chooses action-item/session-plan tracking and the plan threshold. If it selects an action item, search/reuse/create one and claim via claim_work_item; never force past possible_conflict. A missing claim never blocks edits, execution, tests, worktrees, delegation, or follow-through.
- Work entry mechanically loads that product contract. There is no execution mode: whether to ask is a judgement from the item's intent and criteria. Nothing is ever sent work — reserve the items you were asked to work (reserve_work_items), then claim them in order when available.
- Commit provenance authority and fail-open behavior live in the served contract's commit_provenance_contract. Prefer one full [devspec:<id>] reference in every implementing commit; opaque commit/push surfaces rely on record_implementation and server reconciliation.
- After pushing, call record_implementation with the final commit SHA, affected_files, testing_notes, and completion_summary. Then report "implemented" and stop — never mark items done yourself. Who may, and on what evidence, is the served contract's boundary. Vocabulary: implemented → verified → done.
- Project conventions and decisions (get_memory for the full body) are BINDING — if one contradicts what the code needs, surface it and propose a supersede rather than silently deviating.
- Keep shared memory fresh with record_memory (recall-gated: supersede or retract a stale entry, don't duplicate); propose it to the user first. Who may commit is the loaded contract's authority_contract — never predict it; on queued_for_review relay the proposal_id and reason, say a maintainer must accept it, never report it as done.
- For non-trivial work, start with one concise user-facing sentence saying what you understood and what you will do next before tools. Add another only at a meaningful boundary; never narrate individual tools.
- Do not pass git_remote, project_id, or connection_id — the extension already knows them.`;
}
