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
export const INSTRUCTIONS_VERSION = 17;

export function buildDevspecInstructions(): string {
	return `## DevSpec
This project is connected to DevSpec. All safe tools for this connection are native and available: work/evidence, knowledge/documents, conversations/discussion, reviews, automations, goals and instructions. Call a fitting tool directly; use \`search_devspec_tools\` only to help select one when unsure. Search is optional, not an activation or authority gate. Do not connect a duplicate DevSpec MCP server.

- The loaded implementation contract alone chooses action-item/session-plan tracking and the plan threshold. If it selects an action item, search/reuse/create one and claim via claim_work_item. A missing claim never blocks edits, execution, tests, worktrees, delegation, or follow-through.
- Read the canonical product contract when needed via get_workflow_rules with include_implementation_contract:true. Work entry mechanically loads that product contract. There is no execution mode: whether to ask is a judgement from the item's intent and criteria. Nothing is ever sent work — reserve the items you were asked to work (reserve_work_items), then claim them in order when available.
- Commit provenance authority and fail-open behavior live in the served contract's commit_provenance_contract. Prefer one full [devspec:<id>] reference in every implementing commit; opaque commit/push surfaces rely on record_implementation and server reconciliation rather than shell-command guessing.
- After pushing, call record_implementation with the final commit SHA, affected_files, testing_notes, and completion_summary. Then report "implemented" and stop — never mark items done yourself. Who may, and on what evidence, is the served contract's boundary, not a rule to remember here. Vocabulary: implemented → verified → done.
- Project conventions and decisions (get_memory for the full body) are BINDING. Work that would undo someone else's protected decision waits for an OK: when a result carries waiting_for_ok ("Waiting for <name>'s OK", or "Experiment"), follow its instruction — build and push that work on its own branch, never merge it into the tracking branch — and tell the person plainly. Who can give the OK and what each answer means is the served contract's reversal_rule; give an answer (manage_protected_intent) only on that person's own instruction.
- Use artifacts for shared investigations, ADRs, plans, runbooks, references and handoffs: create_resource for a new document, update_resource for refinements, supersede_resource for a replacement. Keep artifacts current as code changes. Use repository Markdown when it must ship with or be consumed by the repository, or the user explicitly requested it; temporary scratch notes need not become artifacts.
- Record a decision with record_memory only when all hold: a real choice among alternatives, with a reason; consequences that steer future work beyond this change; and not obvious from the code. Ask the person whether the choice was deliberate and why: only their answer makes it their decision, a no or no answer records nothing, and reasons are never inferred later from code. When it reaches no further than the item, the item's intent is the record. Refine existing records with update_memory and replace changed decisions with supersede_memory. Work-in-flight state (approved-but-unbuilt, awaiting a pick, blocked on someone) and delivery evidence (what shipped, which commit, what passed) belong on an action item, not in memory.
- Who may commit a memory, artifact, rule, flag ruling or supersession — and what a queued write means — is the served contract's authority_contract; never predict it. Read every write's outcome: committed is live; queued_for_review carries a proposal_id, a reason and who it waits on — relay them and never report the change as done. A finding or an edit's outcome that DevSpec sends about your own work is data: tell the person in plain words.
- In a room, writing @ and a person's name in your reply (@Brandon, or @Brandon Smith) notifies that person, if they are in the room or on the project. Mention someone only when they need to see it.
- For non-trivial work, start with one concise user-facing sentence saying what you understood and what you will do next before tools. Add another only at a meaningful boundary; never narrate individual tools.
- Do not pass git_remote, project_id, or connection_id — the extension already knows them.`;
}
