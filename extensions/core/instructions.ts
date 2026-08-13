/**
 * DevSpec Pi — always-on workflow instructions (Phase 3 + item 523f1512).
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
 *   - the tool map is byte-stable (generated names, not per-turn discovery)
 */

/** Bump when the block changes materially; handy for debugging drift reports. */
export const INSTRUCTIONS_VERSION = 2;

export function buildDevspecInstructions(): string {
	return `## DevSpec
This project is connected to DevSpec; its tools are registered natively (same names as the DevSpec MCP verbs).

- Check DevSpec first: before broad code search or planning, use get_action_items / search_action_items, search_memories, search_resources, get_project_summary. Project conventions and decisions (get_conventions / get_decisions, then get_memory for the full body) are BINDING — if one contradicts what the code needs, surface it and propose a supersede rather than silently deviating.
- Track work as action items: one unit of work = one item. Claim staged work with claim_work_item (never force past a possible_conflict rejection — resolve the pair or surface it); create new tracked work with create_action_item.
- Tag every commit that implements a tracked item: end the commit message with [devspec:<id>].
- After pushing, call record_implementation with the final commit SHA, affected_files, testing_notes, and completion_summary. Then report "implemented" and stop — never mark items done; a human verifies. Vocabulary: implemented → verified → done.
- Keep shared memory fresh: record durable decisions/conventions/risks with record_memory (it recall-gates near-duplicates — prefer supersede_memory / retract_memory for stale entries). In interactive sessions, propose a memory to the user before recording it.

When X, call Y (full native surface — never describe→call):
verifying → record_criterion_verdicts / classify_criterion / verify_action_item; conflicts → resolve_action_item_conflict / preview_conflict_resolution / resolve_memory_flag / resolve_resource_flag; transcripts → get_session_transcript / get_recent_sessions / create_session; work → fail_work_item / reopen_action_item / spin_off_action_item / record_completed_work; history → get_action_item_history / get_action_item_siblings / add_implementation_note / add_commit_reference; playbooks → get_playbooks / get_playbook_runs / claim_playbook_run / record_playbook_run; reviews → get_claimable_reviews / claim_review / record_review; resources → get_resources / get_resource / create_resource / supersede_resource; instructions → get_project_instruction_rules / write_project_instruction_rule / get_personal_instructions; goals → get_goals / get_project_goals.`;
}
