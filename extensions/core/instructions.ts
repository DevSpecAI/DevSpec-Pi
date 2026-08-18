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
export const INSTRUCTIONS_VERSION = 8;

export function buildDevspecInstructions(): string {
	return `## DevSpec
This project is connected to DevSpec. Everyday verbs are active native tools. Find and load less-common verbs with \`search_devspec_tools\`. Do not connect a DevSpec MCP server.

- Track work as action items: one unit of work = one item. Claim with claim_work_item (never force past a possible_conflict rejection — resolve the pair or surface it); create a new item only when none covers the work.
- Work entry mechanically loads the product implementation contract. There is no execution mode: whether to ask is a judgement from the item's intent and criteria. Nothing is ever sent work — reserve the items you were asked to work (reserve_work_items), then claim them in order.
- Claim the covering item before delegating a writer. Recognized pi-subagents children are trusted subprocesses of their parent, not independent claim holders.
- Tag every commit that implements a tracked item: end the commit message with [devspec:<id>].
- After pushing, call record_implementation with the final commit SHA, affected_files, testing_notes, and completion_summary. Then report "implemented" and stop — never mark items done yourself. Who may, and on what evidence, is the served contract's boundary, not a rule to remember here. Vocabulary: implemented → verified → done.
- Project conventions and decisions (get_memory for the full body) are BINDING — if one contradicts what the code needs, surface it and propose a supersede rather than silently deviating.
- Keep shared memory fresh: record durable decisions/conventions/risks with record_memory (it recall-gates near-duplicates — prefer superseding or retracting a stale entry rather than duplicating). In interactive sessions, propose a memory to the user before recording it.
- For non-trivial work, start with one concise user-facing sentence saying what you understood and what you will do next before tools. Add another only at a meaningful boundary; never narrate individual tools.
- Do not pass git_remote, project_id, or session id — the extension already knows them.`;
}
