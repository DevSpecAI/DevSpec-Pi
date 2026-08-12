/**
 * DevSpec Pi — always-on workflow instructions (Phase 3).
 *
 * Injected into the system prompt via before_agent_start when a DevSpec token
 * resolves. This is the native replacement for the instruction files other
 * plugins ship — versioned with the package, impossible to drift or fail to
 * load (VISION.md, "Instructions without skill-sprawl").
 *
 * Pure builder — unit-tested. Keep it TIGHT: every line here costs tokens on
 * every turn of every session. Rules of thumb:
 *   - only reference tools this package actually registers
 *   - only load-bearing rules, not prose
 */

/** Bump when the block changes materially; handy for debugging drift reports. */
export const INSTRUCTIONS_VERSION = 1;

export function buildDevspecInstructions(): string {
	return `## DevSpec
This project is connected to DevSpec; its tools are registered natively (same names as the DevSpec MCP verbs).

- Check DevSpec first: before broad code search or planning, use get_action_items / search_action_items, search_memories, search_resources, get_project_summary. Project conventions and decisions (get_conventions / get_decisions, then get_memory for the full body) are BINDING — if one contradicts what the code needs, surface it and propose a supersede rather than silently deviating.
- Track work as action items: one unit of work = one item. Claim staged work with claim_work_item (never force past a possible_conflict rejection — resolve the pair or surface it); create new tracked work with create_action_item.
- Tag every commit that implements a tracked item: end the commit message with [devspec:<id>].
- After pushing, call record_implementation with the final commit SHA, affected_files, testing_notes, and completion_summary. Then report "implemented" and stop — never mark items done; a human verifies. Vocabulary: implemented → verified → done.
- Keep shared memory fresh: record durable decisions/conventions/risks with record_memory (it recall-gates near-duplicates — prefer supersede_memory / retract_memory for stale entries). In interactive sessions, propose a memory to the user before recording it.`;
}
