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
export const INSTRUCTIONS_VERSION = 3;

export function buildDevspecInstructions(): string {
	return `## DevSpec
This project is connected to DevSpec. Everyday verbs are native tools. Less-common verbs go through the \`devspec\` gateway (verb + args). Do not connect a DevSpec MCP server.

- Track work as action items: one unit of work = one item. Claim staged work with claim_work_item (never force past a possible_conflict rejection — resolve the pair or surface it); create new tracked work with create_action_item.
- Tag every commit that implements a tracked item: end the commit message with [devspec:<id>].
- After pushing, call record_implementation with the final commit SHA, affected_files, testing_notes, and completion_summary. Then report "implemented" and stop — never mark items done; a human verifies. Vocabulary: implemented → verified → done.
- Project conventions and decisions (get_memory for the full body) are BINDING — if one contradicts what the code needs, surface it and propose a supersede rather than silently deviating.
- Keep shared memory fresh: record durable decisions/conventions/risks with record_memory (it recall-gates near-duplicates — prefer superseding or retracting a stale entry rather than duplicating). In interactive sessions, propose a memory to the user before recording it.
- Do not pass git_remote, project_id, or session id — the extension already knows them.`;
}
