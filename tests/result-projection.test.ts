import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertMessages as convertGoogleMessages } from "@earendil-works/pi-ai/api/google-shared";
import { convertMessages as convertOpenAICompletionsMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { clearAllFlags, extractFlags, listFlags } from "../extensions/core/conflict-watch.ts";
import { PROJECTION_BUDGETS, projectModelText, projectionFamily } from "../extensions/core/result-projection.ts";
import { projectedToolResult, unwrapMcpResult } from "../extensions/core/result.ts";
import { extractItemRef, getStatusSnapshot, resetStatus } from "../extensions/core/status-line.ts";
import { resetWorkStateForTests } from "../extensions/core/work-state.ts";
import { consumeResultMechanics } from "../extensions/devspec-tools.ts";
import { MCP_CATALOG, MODEL_VERB_NAMES } from "../extensions/generated/mcp-catalog.ts";

const huge = (label: string, length = 12_000) => `${label}: ${"internal payload ".repeat(Math.ceil(length / 17))}`.slice(0, length);

function mcpJson(payload: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function visible(result: ReturnType<typeof projectedToolResult>): string {
	return result.content[0].text;
}

function toolContext(secret: string) {
	return {
		systemPrompt: "system",
		messages: [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "example_tool", arguments: {} }],
				api: "openai-completions",
				provider: "test",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "example_tool",
				content: [{ type: "text", text: "compact visible content" }],
				details: { secret, payload: huge("hidden") },
				isError: false,
				timestamp: 2,
			},
		],
		tools: [],
	};
}

function model(api: string) {
	return {
		id: "test-model",
		name: "test-model",
		api,
		provider: "test",
		baseUrl: "http://localhost",
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 4_096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

test("every generated model verb is intentionally assigned to a projection contract", () => {
	const fallback = MODEL_VERB_NAMES.filter((name) => projectionFamily(name) === "fallback");
	assert.deepEqual(fallback, ["generate_commit_message"], "new/changed verbs must choose a projection family explicitly");
});

test("model tool schemas and projection families require an explicit contract-baseline update", () => {
	const contract = MCP_CATALOG
		.filter((entry) => entry.kind === "model")
		.map(({ name, inputSchema }) => ({ name, inputSchema, family: projectionFamily(name) }));
	const fingerprint = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
	// Reviewed against Still to Discuss agent verbs (item f2dbec96). search/get/manage
	// are deferred, not hot-set. search is collection cards; get is full body;
	// manage is ack and returns the row plus list. Do not maintain the board unasked.
	//
	// Rebaselined 2026-09-02 for DevSpec item ab4765f4, which removed the
	// `separate_work` follow-up-step kind. Two input schemas moved and nothing
	// else: the step `kind` enums dropped to required_step|note, and
	// create_action_item gained an optional follow_up_from_action_item_id so work
	// that belongs in its own item becomes one in the same call. No new verbs, and
	// every projection family is unchanged (create_action_item is still `ack`), so
	// budget/quality coverage is unaffected.
	//
	// Rebaselined 2026-09-04 for the Playbooks → Automations rename (DevSpec brief
	// 267da4fa). Eight verbs changed name only (claim_automation_run,
	// record_automation_run, get_automations, get_automation, get_automation_runs,
	// create_automation, update_automation, delete_automation) and their schemas
	// renamed the matching fields; no schema shape or projection family changed.
	//
	// Rebaselined 2026-09-04 for DevSpec items 8bebb66e and ff12609d, which made
	// the two action-item filters mean what they say. Three enums moved and
	// nothing else:
	//   - get_action_items.lifecycle and search_action_items.lifecycle now take the
	//     same nine values (they took seven and five). `implemented` became
	//     askable, `active` names the old catch-all `open` behaviour, and `open`
	//     stopped selecting in_progress+implemented+blocked as well.
	//   - signal_type gained `verification_failed`, the fourth reason the Action
	//     Items page has always shown under Needs attention and the signal axis
	//     never had a name for.
	// Both lifecycle enums and both signal enums are now generated from shared
	// constants in DevSpec core, so a future value arrives here by regeneration
	// rather than by anyone editing a list.
	//
	// No new verbs and no projection family changed, so budget coverage is
	// unaffected. One thing WORTH KNOWING rather than fixing here: the response
	// also gained `summary.attention` (an exact count per attention reason), and
	// collectionProjection reads only `summary.ui_buckets` / `lifecycle_breakdown`
	// for its Counts line, numeric values only — so Pi does not surface the new
	// landscape yet. That is a Pi projection decision, not a catalog one.
	// Rebaselined 2026-09-06 for DevSpec item 39519046, which made an automation
	// run's outcome correctable. Two optional inputs moved and nothing else:
	// record_automation_run gained `force` and `reason`, the deliberate recorded
	// way for one of your agents to correct a report another of them made (a
	// connection id is minted fresh on every reconnect, so the reporting agent is
	// not always still there). No new verbs, no projection family changed —
	// record_automation_run is still `ack` — so budget and quality coverage are
	// unaffected.
	//
	// The DESCRIPTIONS of claim_automation_run and record_automation_run also
	// changed, and that half matters more to Pi than the schema does: the server
	// now returns already_finished / already_yours / not_your_target where it used
	// to call every refusal a lost race, and calling record again on a finished run
	// corrects it rather than failing. Pi carries no restatement of either, which
	// is why regenerating the catalog is the whole of Pi's change here.
	// Rebaselined 2026-09-07 for DevSpec item db00d228 and the instruction-ration
	// correction that came out of it. NO schema changed and no projection family
	// moved — only DESCRIPTIONS, which is the half that matters to Pi:
	//   - the four `commit_sha` descriptions now say "short or full" and "never pad".
	//     record_implementation used to say only "Final commit SHA" while
	//     report_commit_provenance demanded "the FULL 40-character sha", and three
	//     agents on 2026-09-06 invented 31 hex characters to fit that shape.
	//   - four descriptions with an over-long FIRST sentence were split, so the
	//     sentence that reaches the model is complete rather than elided.
	// Pi's own caps were the second half of the same defect: SNIPPET_MAX was 140
	// and the generator truncated at 160, which shipped 19 of 84 tool descriptions
	// and 23 parameter descriptions cut off mid-sentence. Both are 320 now, a new
	// test asserts nothing ships elided, and the prefix went 6,933 -> 7,130 tokens
	// of an 8,000 ceiling to buy that back. Budget and quality coverage unaffected.
	// Rebaselined 2026-09-08 for DevSpec item f68fc217: filtering action items by
	// WHO ASKED for them to exist. Two optional inputs were added to
	// get_action_items and search_action_items and nothing else moved —
	// `requested_by` (a person id, or "me", the same grammar `assigned_to`
	// already uses) and `request_origin` (an enum generated from a shared DevSpec
	// core constant, so a future value arrives here by regeneration rather than
	// by anyone editing a list). No new verbs, and no projection family changed:
	// both remain `collection`.
	//
	// Budget: search_action_items is in the hot set, so its two new parameter
	// descriptions do reach the model prefix. Measured after regenerating,
	// estimatePrefixTokens("") is 6,592 of the 8,000 ceiling. get_action_items is
	// not in the hot set, so its half is wire-only.
	//
	// Quality: Pi carries no restatement of either filter, which is why
	// regenerating the catalog is the whole of Pi's change. Worth knowing rather
	// than fixing here: `nobody_asked` is the one value that covers a SET of
	// stored states (agent_initiative + automatic) and is named as a set on
	// purpose, so a model reading the enum cannot mistake an exact value for a
	// widened one.
	// Rebaselined 2026-09-11 for DevSpec item 27fdc5d6 (allow_custom defaults on)
	// together with item f68fc217's who-asked filters reaching the knowledge verbs.
	// One description and six pairs of optional inputs moved, nothing else:
	//   - manage_directed_question.allow_custom: the description now says the
	//     default is true, so the person asked can always answer in their own
	//     words. Type and optionality are unchanged.
	//   - get_resources, search_resources, search_memories, get_decisions,
	//     get_conventions and get_unresolved_questions gained the same optional
	//     `requested_by` and `request_origin` filters that get_action_items and
	//     search_action_items took on 2026-09-08, generated from the same shared
	//     DevSpec core constant.
	// 84 model verbs before and after, none added or removed, and no projection
	// family changed (the assignment test above still passes). Budget: after
	// regenerating, `npm run benchmark:context` measures the initial DevSpec
	// surface at 7,418 tokens of the 8,000 ceiling. The regenerating commit
	// (8a71a84) shipped without this step and left main red for a day: the guard
	// worked, the step it guards was skipped.
	// Rebaselined 2026-09-15 for DevSpec item 93840514: regenerated the catalog
	// against post-be4a5094 tool definitions. The real delta, measured by the
	// regeneration diff: (1) commit_sha descriptions on record_implementation,
	// update_action_item and add_commit_reference now say short/full/omitted,
	// resolved across the project's tracked repositories, provisional until
	// indexed (the commit-identity direction, ADR 60efaed0); (2) new model verb
	// manage_knowledge_links (85 model verbs now, was 84) — assigned to the
	// full/lossless projection family beside the other revisioned manage_*
	// ledgers, since a dropped companion row would read as "not linked";
	// (3) description-only server deltas already on staging: get_project_summary
	// drops the removed test_commands setting, get_automation_runs says waiting
	// entries are inbox metadata, record_memory/supersede_memory/
	// supersede_resource carry the comparison-gate rewrite (with a new optional
	// connection_id on the two supersedes), and post_session_message's
	// command_turn_unbound wording follows the local-turn change. No projection
	// family other than the new verb's assignment moved; the new verb is
	// wire-only (not in the hot set), so the model prefix budget is untouched.
	// Rebaselined 2026-09-16 for DevSpec items cc93671a + 8729992e: regenerated
	// the catalog against staging e736963bd. Measured delta: (1) record_memory's
	// description gains the memory durability test (durable knowledge only;
	// work-in-flight state belongs on action items — the phantom approval-rule
	// fix, cc93671a); (2) one new model verb absorbed from staging drift:
	// get_review_queue, assigned to the full/lossless family beside
	// claim_review (a dropped queue entry would read as "nothing outstanding").
	// No verb removed; no other family moved. Budget: `npm run benchmark:context`
	// measures the initial surface at 7,459 tokens of the 8,000 ceiling (was
	// 7,418). Same commit fixes the git-observer shim fork bomb (8729992e) that
	// made this full suite unrunnable on the shared machine — the suite is the
	// verification again.
	// Rebaselined 2026-09-17 for DevSpec item 4b5cdc59: regenerated the catalog
	// against staging 7359938af. Three descriptions moved, no verb added or
	// removed, so no projection family changed.
	//   (1) record_memory and supersede_memory: the write path stopped calling a
	//       model. The old text said the create READS the records and quotes the
	//       conflicting passage; it now does neither, so an agent told that was
	//       being told something untrue. The new text says the check is instant,
	//       that the judgement is the caller's, that asking the person is a real
	//       outcome, and that confirm_new is a recorded ruling rather than the
	//       way past the check.
	//   (2) resolve_action_item_conflict: absorbed from staging drift, "Review
	//       tab" -> "Review page, under Proposed changes" (R3's navigation fix).
	// Budget: `npm run benchmark:context` measures the initial surface at 7,456
	// tokens of the 8,000 ceiling — three LOWER than the last baseline, because
	// the memory write verbs are wire-only and not in the model hot set.
	// Rebaselined 2026-09-17 (later) for DevSpec item 4b5cdc59: regenerated the
	// catalog against staging ac714890c. Exactly one property added and nothing
	// else moved — `confirm_new` on update_resource (DevSpec bd84df869).
	//   The gate that stops an artifact edit told the caller to "re-call with
	//   confirm_new", and update_resource did not declare it, so the argument was
	//   stripped against the cached schema and the caller could only loop on the
	//   same refusal. A DevSpec agent stood in that dead end this morning; Pi
	//   would have hit it identically the first time it amended an artifact.
	//   create and supersede already had the parameter, which is why only update
	//   was affected.
	// No verb added or removed, no projection family changed. Budget:
	// `npm run benchmark:context` measures the initial surface at 7,456 tokens of
	// the 8,000 ceiling — UNCHANGED, because update_resource is wire-only and not
	// in the model hot set.
	// Rebaselined 2026-09-19 for DevSpec item 5b86e9f2 (Pi item 0cd198bd):
	// regenerated the catalog against staging 3e8e4d80a. The fingerprinted
	// contract moved in exactly two places, both description values, verified by
	// diffing the old-vs-new contract: 86 model verbs both sides, no
	// additions/removals, and the only diffs are
	// `.properties.confirm_new.description` on record_memory (641→544 chars)
	// and update_resource (456→432 chars), dropping the "give a real reason"
	// wording Ali ruled out (DevSpec 737a5ea57). No shape, enum, or projection
	// family changed — the fallback-set test still pins exactly
	// ["generate_commit_message"]. Outside this fingerprint, the same regen
	// absorbed record_memory's tool-description twin of that wording plus
	// sender_style_version on poll_connection (DevSpec 3686c83ca, pump-only).
	// Budget: `npm run benchmark:context` measures the initial surface at 7,456
	// tokens of the 8,000 ceiling — UNCHANGED, because the memory write verbs
	// are wire-only and not in the model hot set.
	// Rebaselined 2026-09-20 for DevSpec item 134f4454, which gave every write-gate
	// corridor the affordances the repository always returned. Regenerated against
	// staging f5c89d8b3. The fingerprinted contract moved in exactly ONE place,
	// verified by diffing the old-vs-new contract object: 86 model verbs both
	// sides, no additions or removals, and the only diff is create_resource
	// gaining an optional `confirm_new` boolean (2,420 → 2,881 chars). No enum, no
	// required field and no projection family changed — create_resource is still
	// `ack`, and it is not in the hot set, so the surface pays only its first
	// sentence, which is unchanged.
	//
	// Outside this fingerprint the same regen absorbed create_resource's tool
	// description (it now says the check exists, which it never did) and a
	// register_connection bond-key description that had drifted since 2026-09-19
	// (pump-only, not model-facing).
	//
	// Budget: `npm run benchmark:context` measures the initial surface at 7,480
	// tokens of the 8,000 ceiling, up 24 from 7,456. The catalog contributed none
	// of that — every token is the instructions bullet, which stopped claiming
	// only memories are gated and now says what to do when a write is stopped.
	// Rebaselined 2026-09-24 for e2f895ac against server staging 524495b9d.
	// Compared old/new generated objects by name/inputSchema, not commit prose:
	// 86 -> 87 model verbs; update_memory is the only addition, none removed.
	// Its full/lossless family preserves preview receipts, stale-context detail,
	// queued proposals and replacement-version ids; it stays deferred, not hot.
	// resolve_action_item_conflict drops counterpart_item_id from required and
	// explains omission for one-record staleness (existing pair inputs remain).
	// Other existing model schema diffs are descriptions only:
	// get_review_queue.search; get_claimable_reviews/claim_review.agent_tool
	// (cursor_cli); update_action_item.expected_version (spec, not file evidence);
	// record_implementation/record_completed_work.testing_notes; and
	// record_criterion_verdicts criterion_id/text (changed wording needs recheck;
	// caller text is a restatement, server records exact wording).
	// Tool-level descriptions changed on get_review_queue and conflict ruling.
	// Outside this model fingerprint: register_connection.folder_scope_only is
	// pump-only. No existing projection family or hot-set membership changed.
	// Same deterministic benchmark before/after: initial surface 7,480 -> 7,477
	// estimated tokens (ceiling 8,000); all projection fixture budgets unchanged.
	// Rebaselined 2026-09-25 for DevSpec item b69a7b53 (R7) against server staging
	// d39cd98aa. Compared old/new generated objects by name/inputSchema: 87 model
	// verbs before and after, none added or removed. The only model schema change
	// is preview_conflict_resolution: counterpart_item_id is no longer required,
	// and its description says to omit it for a staleness flag that names no
	// other item (DevSpec e599545f — previewing a one-record staleness ruling was
	// refused). Outside this model fingerprint: poll_connection gained the pump-only
	// session_events_version / session_events_revision. Projection family is still
	// "full". Same deterministic benchmark before/after: initial surface 7,732 ->
	// 7,732 estimated tokens, because the verb is not in the hot set.
	// Rebaselined 2026-09-26 for DevSpec item d8cac873 against server staging
	// cf0f2bcd3. Compared old/new generated objects by name/inputSchema: 87 model
	// verbs before and after, none added or removed, no required or type change.
	// Two descriptions only: devspec_help_search.query's example no longer names
	// autopilot, and update_action_item.lifecycle now names "blocked" and says
	// "deferred"/"blocked" are refused on implemented/done items (DevSpec
	// 5c422453). No projection family or hot-set membership changed. Same
	// deterministic benchmark before/after: initial surface 7,732 -> 7,732.
	// Rebaselined 2026-09-27 for DevSpec item 2b2b025e: the orphaned review
	// claim loop is deleted server-side, so get_claimable_reviews, claim_review
	// and record_review leave the catalog (87 -> 84 model verbs) and their
	// model-surface intent entry and projection-family memberships go with them.
	// Nothing an agent could reach changes: evidence recording is
	// record_criterion_verdicts (untouched) and asking for a review is the
	// picker's attach + owner message (ask-review), which never used these.
	// Rebaselined 2026-09-30 for 50eb6a61: get_memory adds only optional
	// history_before/history_limit. It stays a full exact read, and the test
	// below pins lossless body plus actionable continuation. No verbs/families changed.
	// Rebaselined 2026-10-01 for DevSpec item 1b7592bd (sharing an automation with
	// the project), regenerated against server staging plus that change. Compared
	// old/new generated objects by name/inputSchema: 85 model verbs before and
	// after, none added or removed, no required or type change. Two inputs are new
	// — create_automation.visibility and update_automation.visibility (optional
	// private|project) — and the automation verbs' descriptions now say a list
	// includes teammates' shared automations and that only the author can change
	// one. The regeneration also carries server changes Pi had not yet picked up:
	// request_origin gained "unattributed" on get_action_items,
	// search_action_items, get_resources, search_resources, search_memories,
	// get_decisions, get_conventions and get_unresolved_questions, and the
	// personal-instructions descriptions now point at the Agents settings page. No
	// projection family or hot-set membership changed. Benchmark before/after:
	// initial surface 30,722 -> 31,061 estimated tokens; every budget still passes.
	// Rebaselined 2026-10-02 for d4495280: only get_memory gains optional
	// evidence_before/evidence_limit. No verb, required field or projection family
	// changes. Full-memory evidence/wording and independent continuation are
	// pinned losslessly below; generated guidance preserves cautions and failures.
	assert.equal(
		fingerprint,
		// b0507ae2: only the two optional evidence parameter descriptions changed;
		// no inputs, required fields, verb inventory or result projections changed.
		// Rebaselined 2026-10-04 for DevSpec item 54d442b0, regenerated against server
		// staging 13a0c86e1. Descriptions only: write_project_instruction_rule (and its
		// operation/body/rationale), import_instruction_rules (and items.rationale) and
		// update_personal_instructions now tell agents to amend the rule that already
		// covers a subject and keep bodies lean, and no longer claim agents receive the
		// rationale. Also carries server description changes Pi had not picked up:
		// update_action_item.agent_error and the idempotency_key guidance on
		// create_resource/record_memory. 99 verbs before and after; no input, required
		// field, type or projection family changed. Benchmark before/after: initial
		// surface 31,262 -> 31,521 estimated tokens; every budget still passes.
		// Rebaselined 2026-10-04 for DevSpec item d40101aa, regenerated against server
		// work/dev-principles-tools-d40101aa (on staging d13a08ef8). Descriptions:
		// the guidance and parameter text for get_project_instruction_rules,
		// get_personal_instructions, write_project_instruction_rule and
		// update_personal_instructions now say who receives each tier (principles
		// reach agents and Dev; agent rules reach coding agents only), and
		// write_project_instruction_rule adds removing what a change makes redundant.
		// The regeneration also carries a server change Pi had not picked up:
		// update_action_item gains an OPTIONAL idempotency_key (for a change saved for
		// review instead of applied). 99 verbs before and after; no required field,
		// type or projection family changed. Benchmark before/after: initial surface
		// 31,648 -> 31,936 estimated tokens; every budget still passes.
		// Rebaselined 2026-10-04 for DevSpec item cc630fb8 (every list reports its
		// total and pages). Optional inputs only, no required field or type change,
		// 99 verbs before and after, no projection family moved: `offset` on
		// get_decisions, get_conventions, get_unresolved_questions, search_action_items,
		// search_discussion_points, get_resources, search_sessions, get_recent_sessions
		// and get_automation_runs (+ its `limit`); `activity_offset`/`activity_limit` on
		// get_action_item_history; `proposals_offset`/`proposals_limit` on
		// get_project_instruction_rules. Limit descriptions now speak of pages. The
		// collection projection names the exact next page from `page.next_offset`
		// (tested above). Benchmark: initial surface 31,936 -> 32,871 estimated
		// tokens; every budget still passes.
		// Rebaselined 2026-10-04 for DevSpec item 85a0a1a5: manage_discussion_point's
		// title and body now declare maxLength 200 / 8000 and say a longer one is
		// refused, not cut (the server stopped slicing them silently). No verb,
		// required field, type or projection family changed. Benchmark before/after:
		// initial surface 32,871 -> 32,908 estimated tokens; every budget passes.
		// Rebaselined 2026-10-04 for DevSpec item a43f8510 (the server now enforces every
		// declared limit). Declared limits only: post_session_message.message maxLength
		// 100,000 and create_session.title 500 (both new), manage_knowledge_links.note
		// 4,000 -> 1,000 (what the database always enforced), and the reopen note no
		// longer claims a 20-character minimum. No verb, required field, type or
		// projection family changed.
		// Rebaselined 2026-10-04 for DevSpec item 02526f46 (every list tool lets the
		// caller reach the rest): search_memories, search_resources, devspec_help_search
		// and search_devspec_tools gained \`offset\` and say so in their limit and
		// guidance text. No verb, required field or projection family changed; the help
		// and resource projections now name the next offset.
		// Rebaselined 2026-10-05 for DevSpec item 52012b05, regenerated against server
		// work/goal-pages-52012b05 (on staging f7ab17266). get_goals gains OPTIONAL
		// items_offset/items_limit (a goal's item list now pages past 500 instead of
		// stopping there), and its description and guidance say so and that unreadable
		// progress is null, not zero; get_testing_brief's guidance says deployments and
		// test runs are complete. 99 verbs before and after; no required field, type or
		// projection family changed (both stay full exact reads). Benchmark before/after:
		// initial surface 33,286 -> 33,396 estimated tokens; every budget still passes.
		// Rebaselined 2026-10-05 for DevSpec items 3573c378 / 275c625b / 516737fd
		// (item eaa8083c), regenerated against server staging 6504bd589. Each tool now
		// has ONE description, the server's single definition; the catalogue's separate
		// promptSnippet is gone. Compared old/new generated model objects: 85 -> 82
		// model verbs (send_agent_message, control_connection and submit_plan_review
		// removed; none added); no required field changed. Inputs added are those the
		// server's executors already read (e.g. get_database_schema database/offset/
		// limit, archive_resource.reason, update_memory.note) plus the explicit
		// this-room/whole-project scope on search_discussion_points and
		// manage_discussion_point; inputs removed are ones nothing read
		// (get_recent_sessions.status, get_automation_runs provider/model,
		// claim_automation_run.model, update_action_item agent_activity/agent_error).
		// search_devspec_tools takes its own definition's offset paging. Benchmark
		// before/after: initial surface 33,396 -> 41,699 estimated tokens, almost all
		// from tool descriptions (17.9k -> 48.6k characters across the model verbs:
		// the rewrite restores the boundaries and caveats the 30 Sep cut removed);
		// every budget still passes.
		// Rebaselined 2026-10-06 for DevSpec item 2319586a, regenerated against server
		// staging efe38fb88. The server now works out for itself whether a write was
		// unattended (decision 8a157943), so runner_session_id leaves all 45 model write
		// tools that carried it, and send_heartbeat leaves the catalogue (it was a pump
		// verb, never model-facing). Compared old/new generated model objects: 82 -> 82
		// model verbs, none added or removed; 49 changed only in description text. Seven
		// shape changes came with this regeneration from server work since the last one:
		// reopen_action_item.reason_code no longer offers new_followup_scope (8bf07999);
		// add_implementation_note now requires action_item_id (8bf07999);
		// record_implementation.completion_confidence is bounded 0-100;
		// update_memory gains optional expected_version and preview_ack and
		// resolve_resource_flag now requires verdict and note (0ab1054e, on 3573c378);
		// create_automation/update_automation preferred_provider no longer offers codex
		// (3573c378). No projection family changed. Benchmark before/after: initial
		// surface 41,699 -> 43,836 estimated tokens, from the rewritten description
		// text; every budget still passes.
		"78f93bedf3663e46f65204d1a22133f18228ba7871a9ef53d18800210fba4696",
		"a model-facing schema or projection family changed; review quality/budget coverage, then update this fingerprint deliberately",
	);
});

test("memory history continuation survives exact-read projection with all wording intact", () => {
	const payload = { id: "memory", body: huge("complete words"), history: [{ id: "event", sourceSessionId: null }],
		history_has_more: true, history_next_before: "event",
		history_next_call: { tool: "get_memory", args: { id: "memory", history_before: "event", history_limit: 1 } } };
	const text = projectModelText({ toolName: "get_memory", text: JSON.stringify(payload), details: payload });
	assert.equal(JSON.parse(text).body, payload.body);
	assert.deepEqual(JSON.parse(text).history_next_call, payload.history_next_call);
	assert.equal(JSON.parse(text).history_has_more, true);
});

test("requirement evidence stays lossless through full-memory native projection", () => {
	const payload = { id: "old-version", body: huge("complete requirement"),
		requirement_evidence: { status: "available", requirementVersionId: "old-version", version: 2,
			entries: [{ coverage: huge("full coverage"), source: { observationId: "observation", observedAt: "2026-09-01T00:00:00Z" },
				cautions: ["historical_requirement", "stale_observation"], reassessesId: "prior-link", withdrawnAt: "2026-10-01T00:00:00Z" }],
			hasMore: true, nextBefore: "association" },
		evidence_next_call: { tool: "get_memory", args: { id: "old-version", evidence_before: "association", evidence_limit: 1 } },
		history_has_more: false };
	assert.deepEqual(JSON.parse(projectModelText({ toolName: "get_memory", text: JSON.stringify(payload), details: payload })), payload);
	const unavailable = { ...payload, requirement_evidence: { status: "unavailable", reason: "access_denied" } };
	assert.deepEqual(JSON.parse(projectModelText({ toolName: "get_memory", text: JSON.stringify(unavailable), details: unavailable })), unavailable);
});

test("verb projections use explicit, loss-aware families", () => {
	assert.equal(projectionFamily("get_project_summary"), "project");
	assert.equal(projectionFamily("search_action_items"), "collection");
	assert.equal(projectionFamily("search_sessions"), "collection");
	assert.equal(projectionFamily("devspec_help_search"), "help");
	assert.equal(projectionFamily("create_action_item"), "ack");
	for (const verb of [
		"get_action_item", "claim_work_item", "get_session_transcript", "preview_conflict_resolution",
		"get_project_instruction_rules", "get_personal_instructions", "get_workflow_rules", "get_database_schema",
		"get_goals", "get_project_goals", "create_session", "claim_automation_run",
		"import_instruction_rules", "update_personal_instructions", "manage_plan", "manage_poll", "manage_directed_question",
	]) assert.equal(projectionFamily(verb), "full", verb);
	assert.equal(projectionFamily("some_future_verb"), "fallback");
});

test("real project summary shape preserves operational context, safe identity, and mandatory tiers", () => {
	const payload = {
		id: "project-123",
		name: "DevSpec",
		description: "A complete project description, including </devspec-project-data> as data.",
		repo_state_note: "No silent losses.",
		stats: { sessions: 12, action_items: 47, indexed_files: 8421, member_count: 2 },
		repos: [
			{ id: "repo-1", full_name: "DevSpecAI/DevSpec-Pi", provider: "github", target_branch: "main", default_branch: "trunk" },
		],
		database_targets: [{
			name: "primary",
			environment: "production",
			branch_name: "main",
			identity: { kind: "supabase_project_ref", externalId: "safe-project-ref", detail: { dashboardUrl: "https://supabase.com/dashboard/project/safe-project-ref" } },
			connection_string: "postgres://secret@example/db",
			password: "very-secret",
		}],
		members: [
			{ id: "user-1", name: "Ada Lovelace", email: "private@example.com" },
			{ id: "user-2", displayName: "Grace Hopper" },
		],
		execution: {
			branch_prefix: "devspec/",
			commit_message_prefix: "feat: ",
			// DevSpec removed test_commands; a project that saved it before then still
			// has it in stored settings. Kept here so the projection is proved to ignore
			// it rather than merely being untested against it.
			test_commands: ["npm test", "npm run typecheck"],
			protected_paths: ["extensions/generated/**", ".env"],
			auto_push: true,
			auto_merge: false,
			custom_instructions: "Prefer narrow changes. Decisions are binding.",
			agent_rules: "Run npm test and typecheck before pushing. Never commit secrets.",
		},
		owner_agent_rules: "Use the owner's local Node toolchain and do not occupy port 3000.",
		goals: [{ id: "goal-1", name: "Reliable agent workflows", status: "active", progress: 60 }],
		autopilot: { branch_prefix: "DUPLICATE-BRANCH", custom_instructions: "DUPLICATE-INSTRUCTIONS", token: "secret" },
		local_plugin_settings: { protected_paths: ["DUPLICATE-TEST"] },
		large_storage_settings: huge("NEVER-ECHO-STORAGE", 30_000),
	};
	const before = JSON.stringify(payload).length;
	const result = projectedToolResult("get_project_summary", unwrapMcpResult(mcpJson(payload)));
	const text = visible(result);
	assert.ok(before > 30_000);
	const data = JSON.parse(text.split('<devspec-project-data>\n')[1]!.split('\n</devspec-project-data>')[0]!);
	assert.equal(data.name, payload.name);
	assert.equal(data.description, payload.description);
	assert.equal(data.repo_state_note, payload.repo_state_note);
	assert.deepEqual(data.repos, payload.repos);
	assert.deepEqual(data.stats, payload.stats);
	assert.equal(data.execution.agent_rules, payload.execution.agent_rules);
	assert.equal(data.execution.custom_instructions, payload.execution.custom_instructions);
	assert.equal(data.owner_agent_rules, payload.owner_agent_rules);
	assert.equal(data.large_storage_settings, payload.large_storage_settings, 'unrecognised non-secret fields are no longer silently dropped');
	assert.equal(data.database_targets[0].identity.detail.dashboardUrl, payload.database_targets[0]!.identity.detail.dashboardUrl);
	assert.equal(data.members[0].name, 'Ada Lovelace');
	assert.doesNotMatch(text, /postgres|very-secret|private@example|DUPLICATE|npm run typecheck/i);
	assert.match(text, /Omitted security\/retired compatibility fields/);
	assert.equal(data.execution.test_commands, undefined);
	assert.deepEqual(result.details, payload);
});

test("get_action_items combines separate briefs and items and preserves real page counts", () => {
	const payload = {
		summary: { ui_buckets: { open: 8, implemented_awaiting_verify: 3, done: 20 } },
		page: { total_matching: 11, offset: 0, limit: 10, has_more: true, next_offset: 10 },
		briefs: [{ id: "brief-1", title: "Unified review flow", item_type: "brief", lifecycle: "in_progress" }],
		items: [{ id: "item-1", title: "Render brief hierarchy", lifecycle: "open", parent_action_item_id: "brief-1", description_preview: "Keep hierarchy visible." }],
		relationships: [],
	};
	const text = projectModelText({ toolName: "get_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /11 results; 1 additional contextual brief card\(s\)/);
	assert.match(text, /\[brief-1\] Unified review flow/);
	assert.match(text, /\[item-1\] Render brief hierarchy/);
	assert.match(text, /parent\/brief: brief-1/);
	assert.ok(text.indexOf("[item-1]") < text.indexOf("[brief-1]"), "context briefs must not jump ahead of the ordered page");
	assert.match(text, /open=8/);
	assert.match(text, /next offset\/page/);
});

test("compact action-item chronology keeps temporal signals and does not double-count a brief already in the page", () => {
	const payload = {
		page: { fields: "compact", total_matching: 2, offset: 0, limit: 100, has_more: false, next_offset: null },
		items: [
			{ id: "older", title: "Older work", lifecycle: "done", age: "8mo", last_activity: "3mo" },
			{ id: "brief-1", title: "Later brief", lifecycle: "open", age: "2d", last_activity: "1h" },
		],
		briefs: [{ id: "brief-1", title: "Later brief", lifecycle: "open" }],
	};
	const text = projectModelText({ toolName: "get_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /^get_action_items: 2 results\./);
	assert.equal(text.match(/\[brief-1\]/g)?.length, 1);
	assert.ok(text.indexOf("[older]") < text.indexOf("[brief-1]"));
	assert.match(text, /age 8mo · last activity 3mo/);
});

test("an off-page brief is contextual and never inflates the server's paginated result total", () => {
	const payload = {
		page: { fields: "compact", total_matching: 10, offset: 0, limit: 1, has_more: true, next_offset: 1 },
		items: [{ id: "item-1", title: "First page item", lifecycle: "open", age: "1d" }],
		briefs: [{ id: "off-page-brief", title: "Context from outside this page", lifecycle: "open" }],
	};
	const text = projectModelText({ toolName: "get_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /^get_action_items: 10 results; 1 additional contextual brief card\(s\)/);
	assert.doesNotMatch(text, /11 result/);
	assert.match(text, /Omitted 9 action-item result\(s\)/);
});

test("a pending proposal against a recalled record survives the card projection (38576d61)", () => {
	// A proposal never touches its target, so the decided body a search returns looks
	// exactly as it did. Dropping the annotation is how an agent recalls decided text
	// and never learns a colleague has proposed replacing it.
	const payload = {
		memories: [
			{
				id: "mem-1",
				title: "Two-pool metered billing",
				type: "decision",
				state: "decided",
				summary: "Intelligence pays for background work; Assistant pays for what a person clicked.",
				created_at: "2026-09-01T10:00:00Z",
				pending_proposals: [
					{
						proposal_id: "prop-9",
						kind: "memory_supersede",
						what: "proposed replacement",
						by: "Cee Ontributor (Contributor)",
						because: "insufficient_role",
						line: "\u26a0 proposed replacement by Cee Ontributor (Contributor), awaiting a maintainer (proposal prop-9)",
					},
				],
			},
			{ id: "mem-2", title: "Never pad a short SHA", type: "convention", state: "decided", created_at: "2026-08-01T10:00:00Z" },
		],
		count: 2,
	};
	const text = visible(projectedToolResult("search_memories", unwrapMcpResult(mcpJson(payload))));
	assert.match(text, /proposed replacement by Cee Ontributor \(Contributor\), awaiting a maintainer \(proposal prop-9\)/);
	// The decided record is still what the card shows.
	assert.match(text, /\[mem-1\] Two-pool metered billing/);
	// A record with nothing proposed against it gains no line.
	assert.equal((text.match(/awaiting a maintainer/g) ?? []).length, 1);
});

test("pending proposals are bounded, and a row without a served line still names its proposal", () => {
	const payload = {
		memories: [
			{
				id: "mem-3",
				title: "Three changes proposed against this one",
				type: "decision",
				state: "decided",
				created_at: "2026-08-02T10:00:00Z",
				pending_proposals: [
					{ proposal_id: "p1", what: "proposed edit", by: "a contributor", line: "\u26a0 proposed edit by a contributor, awaiting a maintainer (proposal p1)" },
					{ proposal_id: "p2", what: "proposed retraction", by: "an agent, working unattended", line: "\u26a0 proposed retraction by an agent, working unattended, awaiting a maintainer (proposal p2)" },
					{ proposal_id: "p3", what: "proposed replacement", by: "a contributor" },
				],
			},
			{
				id: "mem-4",
				title: "Server sent no rendered line",
				type: "decision",
				state: "decided",
				created_at: "2026-08-03T10:00:00Z",
				pending_proposals: [{ proposal_id: "p7", what: "proposed retraction", by: "a contributor (Contributor)" }],
			},
		],
		count: 2,
	};
	const text = visible(projectedToolResult("search_memories", unwrapMcpResult(mcpJson(payload))));
	assert.match(text, /proposal p1/);
	assert.match(text, /proposal p2/);
	// Third one is summarised rather than listed, and never silently dropped.
	assert.doesNotMatch(text, /proposal p3/);
	assert.match(text, /1 further proposed change\(s\) awaiting a maintainer/);
	// Composed from the parts when the server sent no line.
	assert.match(text, /proposed retraction by a contributor \(Contributor\), awaiting a maintainer \(proposal p7\)/);
});

test("suggested work says it is not agreed on its card, and agreed work gains no line (2ec0e288)", () => {
	const payload = {
		query: "restore",
		count: 3,
		results: [
			{ id: "item-agreed", title: "Restore procedure", lifecycle: "open", type: "task", created_at: "2026-10-01T10:00:00Z" },
			{
				id: "item-suggested", title: "Suggested restore drill", lifecycle: "open", type: "task", created_at: "2026-10-04T09:00:00Z",
				agreement: { state: "awaiting_review", line: "Suggested work, awaiting a Maintainer\u2019s review. It is not agreed: do not claim it, plan around it or report it as project work." },
			},
			{ id: "item-declined", title: "Declined drill", lifecycle: "open", type: "task", created_at: "2026-10-04T09:30:00Z", agreement: { state: "declined" } },
		],
	};
	const text = visible(projectedToolResult("search_action_items", unwrapMcpResult(mcpJson(payload))));
	assert.match(text, /\[item-suggested\] Suggested restore drill[\s\S]*Suggested work, awaiting a Maintainer\u2019s review\. It is not agreed/);
	assert.match(text, /\[item-declined\] Declined drill[\s\S]*Not agreed work \(declined\)\./);
	assert.equal((text.match(/agreed work|not agreed/gi) ?? []).length, 2);
});

test("action-item search renders bounded compact cards with an exact fetch path", () => {
	const items = Array.from({ length: 20 }, (_, index) => ({
		id: `item-${String(index + 1).padStart(2, "0")}`,
		title: `Implement focused change ${index + 1}`,
		lifecycle: index % 2 ? "in_progress" : "open",
		type: index === 0 ? "brief" : "task",
		priority: index < 3 ? "high" : "normal",
		parent_action_item_id: index === 0 ? null : "brief-01",
		why_matched: `Matched result shaping terms for candidate ${index + 1}.`,
		description: huge(`full-description-${index}`, 900),
		embedding: Array.from({ length: 250 }, () => 0.12345),
	}));
	const payload = { results: items, total_matching: 20 };
	const before = JSON.stringify(payload).length;
	const result = projectedToolResult("search_action_items", unwrapMcpResult(mcpJson(payload)));
	const text = visible(result);
	assert.ok(before > 25_000);
	assert.ok(text.length <= PROJECTION_BUDGETS.collection);
	assert.match(text, /20 results; showing 7/);
	assert.match(text, /\[item-01\] Implement focused change 1/);
	assert.match(text, /Omitted 13 result/);
	assert.match(text, /get_action_item\(id\)/);
	assert.doesNotMatch(text, /item-08|embedding|full-description/);
	assert.deepEqual(result.details, payload);
});

test("action-item search preserves intent, parent title, and created chronology without full descriptions", () => {
	const payload = {
		count: 1,
		results: [{
			id: "item-intent",
			title: "Keep retrieval selective",
			lifecycle: "implemented",
			type: "improvement",
			created_at: "2026-08-14T12:54:36.630085+00:00",
			intent: "Preserve project awareness without flooding model context.",
			parent_action_item_id: "brief-1",
			parent_title: "Pi-native retrieval",
			description: huge("MUST-NOT-BE-VISIBLE"),
		}],
	};
	const text = projectModelText({ toolName: "search_action_items", text: JSON.stringify(payload), details: payload });
	assert.match(text, /parent\/brief: Pi-native retrieval/);
	assert.match(text, /created 2026-08-14T12:54:36.630085\+00:00/);
	assert.match(text, /Preserve project awareness without flooding model context/);
	assert.doesNotMatch(text, /MUST-NOT-BE-VISIBLE/);
});

test("session search projects compact cards with excerpts and a transcript follow-up", () => {
	const payload = {
		sessions: [{
			session_id: "841dbaba-3774-4bbc-b88a-0454a8f5006b",
			title: "Enable local agents to search session transcripts",
			started_at: "2026-08-27T19:20:06.731+00:00",
			status: "active",
			matched_by: "keyword",
			match_count: 3,
			excerpt: "I'm sure we talked about this in another session.",
			messages: [{ role: "user", content: "FULL-TRANSCRIPT-MUST-NOT-LEAK" }],
		}],
		transcript_omitted: "Cards only — call get_session_transcript with a session_id to read a room.",
	};
	const text = projectModelText({ toolName: "search_sessions", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.collection);
	assert.match(text, /search_sessions: 1 result/);
	assert.match(text, /\[841dbaba-3774-4bbc-b88a-0454a8f5006b\] Enable local agents to search session transcripts/);
	assert.match(text, /active · keyword · 3 matches/);
	assert.match(text, /started 2026-08-27T19:20:06\.731\+00:00/);
	assert.match(text, /I'm sure we talked about this in another session/);
	assert.match(text, /get_session_transcript/);
	assert.doesNotMatch(text, /FULL-TRANSCRIPT-MUST-NOT-LEAK/);
});

test("long selection cards preserve parent, chronology, and intent before optional signals", () => {
	const payload = {
		count: 1,
		results: [{
			id: huge("long-id", 500),
			title: huge("long-title", 500),
			lifecycle: huge("long-lifecycle", 200),
			type: huge("long-type", 200),
			priority: huge("long-priority", 200),
			parent_title: huge("LOAD-BEARING-PARENT", 500),
			created_at: "2026-08-14T12:54:36.630085+00:00",
			last_activity_at: "2026-08-14T19:54:36.630085+00:00",
			intent: huge("LOAD-BEARING-INTENT", 1_000),
			review_signals: [{ type: huge("OPTIONAL-SIGNAL", 500) }],
		}],
	};
	const text = projectModelText({ toolName: "search_action_items", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.collection);
	assert.match(text, /LOAD-BEARING-PARENT/);
	assert.match(text, /created 2026-08-14T12:54:36.630085\+00:00/);
	assert.match(text, /last activity 2026-08-14T19:54:36.630085\+00:00/);
	assert.match(text, /LOAD-BEARING-INTENT/);
});

test("resource search projects both corpora and their matching passages instead of dropping the hit arrays", () => {
	const payload = {
		query: "Pi result shaping",
		mode: "search",
		counts: { documents: 2, artifacts: 2 },
		documents: [
			{ id: "doc-1", title: "Context study", resource_type: "reference", source: "uploaded", summary: "Study summary", matching_passage: "Measured passage about result costs." },
			{ id: "doc-2", title: "Second study", resource_type: "reference", source: "uploaded", matching_passage: "Second measured passage." },
		],
		artifacts: [
			{ id: "artifact-1", title: "Projection ADR", resource_type: "adr", source: "ai_generated", summary: "Projection decision." },
			{ id: "artifact-2", title: "Projection plan", resource_type: "plan", source: "ai_generated", summary: "Projection plan summary." },
		],
	};
	const text = projectModelText({ toolName: "search_resources", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.collection);
	assert.match(text, /^search_resources: 4 results\./);
	assert.match(text, /\[doc-1\] Context study — reference · uploaded/);
	assert.match(text, /Measured passage about result costs/);
	assert.match(text, /\[artifact-1\] Projection ADR — adr · ai_generated/);
	assert.ok(text.indexOf("[doc-1]") < text.indexOf("[artifact-1]"));
	assert.ok(text.indexOf("[artifact-1]") < text.indexOf("[doc-2]"), "resource corpora should be interleaved");
	assert.doesNotMatch(text, /Unrecognized result shape|fallback field/);
});

test("create/update projections keep decision, reconciliation, conflict, and duplicate gates", () => {
	const payload = {
		action_item: { id: "created-123", title: "Project structured results", lifecycle: "staged", parent_action_item_id: "brief-456", description: huge("REPEATED-INPUT") },
		review_before_proceeding: { required: true, instruction: "Review candidates before creating." },
		check_against_decisions: "Read the related decisions before implementation.",
		related_decisions: [{ id: "decision-1", title: "Preserve criterion evidence", memory_type: "decision", summary: "Promotion follows evidence." }],
		memory_reconciliation: { required: true, instruction: "Reconcile the closest memory first." },
		reconcile_required: true,
		closest_match: { id: "memory-1", title: "Existing result projection", memory_type: "convention" },
		potential_conflicts: [{ id: "conflict-1", title: "Existing adapter work", why: "Touches the same pipeline" }],
		near_duplicates: [{ id: "duplicate-1", title: "Compact result cards", why: "Very similar scope" }],
		unresolved_conflicts: [{ conflicting_item_id: "item-conflict", reason: "May overlap the current adapter" }],
		related_candidates: Array.from({ length: 5 }, (_, index) => ({ id: `candidate-${index + 1}`, title: `Candidate ${index + 1}`, lifecycle: "open" })),
	};
	for (const verb of ["create_action_item", "update_action_item"]) {
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.ok(text.length <= PROJECTION_BUDGETS.ack);
		assert.match(text, /id=created-123 title=Project structured results state=staged/);
		assert.match(text, /review_before_proceeding.*required: true.*Review candidates/);
		assert.match(text, /check_against_decisions.*related decisions/i);
		assert.match(text, /Related decisions:[\s\S]*decision-1/);
		assert.match(text, /memory reconciliation.*required: true/i);
		assert.match(text, /Closest existing memory:[\s\S]*memory-1/);
		assert.match(text, /Potential conflicts:[\s\S]*conflict-1/);
		assert.match(text, /Near duplicates:[\s\S]*duplicate-1/);
		assert.match(text, /item-conflict.*overlap/);
		assert.match(text, /Related candidates: 5; showing top 3/);
		assert.doesNotMatch(text, /candidate-4|REPEATED-INPUT/);
	}
});

/**
 * The write gate refuses documents as well as memories (DevSpec 134f4454), and a
 * refusal is only useful if the reader can go and open what it matched. Sending a
 * document id to get_memory returns nothing, which reads as "the gate matched
 * something that does not exist" — the dead end that item removed.
 */
test("a gated document write points at get_resource, and a gated memory write at get_memory", () => {
	const payload = {
		created: false,
		reconcile_required: true,
		closest_match: { id: "artifact-77", title: "The other ADR" },
		affordances: ["supersede", "link", "dismiss", "proceed_new"],
		guidance: "This closely resembles a record that already exists.",
	};

	const document = projectModelText({ toolName: "create_resource", text: JSON.stringify(payload), details: payload });
	assert.match(document, /Closest existing document/);
	assert.match(document, /artifact-77/);
	// The reader is what mattered: the old label said "memory" whatever the verb,
	// and its fetch hint said get_memory — which returns nothing for a document id.
	assert.doesNotMatch(document, /get_memory/);
	assert.doesNotMatch(document, /Closest existing memory/);
	// It must read as "nothing was written", not as a fault.
	assert.match(document, /nothing was written/i);

	const memory = projectModelText({ toolName: "record_memory", text: JSON.stringify(payload), details: payload });
	assert.match(memory, /Closest existing memory/);
	assert.doesNotMatch(memory, /get_resource/);
	assert.doesNotMatch(memory, /Closest existing document/);
});

test("record_implementation clearly preserves own and brief criterion follow-through plus human steps", () => {
	const payload = {
		item: { id: "work-789", title: "Shape lifecycle response", lifecycle: "implemented" },
		action_item_id: "work-789",
		own_criteria_follow_through: {
			action_item_id: "work-789",
			criteria_total: 3,
			criteria_settled: 1,
			go_and_check: [
				{ criterion_id: "criterion-1", text: "Run npm test and record its exit code.", reason: "not_yet_checked" },
			],
			weak_evidence: [
				{ criterion_id: "criterion-2", text: "Query the projection and record the returned size.", reason: "inference_only" },
			],
			failed: [],
			leave_for_a_person: [],
			instruction: "Run observable checks, then call record_criterion_verdicts for this item.",
		},
		brief_follow_through: {
			brief_id: "brief-456",
			brief_title: "Compact common outputs",
			band: "final",
			children_total: 4,
			children_resolved: 4,
			percent_complete: 100,
			instruction: "This was the last open child; check the brief criteria now.",
			unsettled_criteria: [{ criterion_id: "brief-criterion-1", text: "Compare representative before/after payload sizes." }],
		},
		human_actions_required: [{ kind: "required_step", description: "Enable the production flag after deployment." }],
		manual_followup_steps: [{ kind: "note", description: "This alternate key must not replace human_actions_required." }],
		completion_summary: huge("ECHOED-COMPLETION"),
	};
	const result = projectedToolResult("record_implementation", unwrapMcpResult(mcpJson(payload)));
	const text = visible(result);
	assert.ok(text.length <= PROJECTION_BUDGETS.ack);
	assert.match(text, /Own-criteria follow-through \(act before reporting\)/);
	assert.match(text, /item: \[work-789\]/);
	assert.match(text, /go_and_check: \[criterion-1\] Run npm test and record its exit code.*not_yet_checked/);
	assert.match(text, /weak_evidence: \[criterion-2\] Query the projection.*inference_only/);
	assert.match(text, /Brief follow-through \(act before reporting\)/);
	assert.match(text, /brief: \[brief-456\] Compact common outputs/);
	assert.match(text, /last open child/);
	assert.match(text, /unsettled_criteria: \[brief-criterion-1\] Compare representative before\/after/);
	assert.match(text, /Manual\/human follow-up:[\s\S]*required_step: Enable the production flag/);
	assert.match(text, /note: This alternate key must not replace human_actions_required/);
	assert.doesNotMatch(text, /ECHOED-COMPLETION/);
	assert.deepEqual(result.details, payload);
});

test("record_implementation reserves every own and brief criterion under its explicit safety budget", () => {
	const own = Array.from({ length: 30 }, (_, index) => ({
		criterion_id: `own-${String(index + 1).padStart(2, "0")}`,
		text: huge(`own criterion ${index + 1}`, 2_000),
		reason: index % 2 ? "not_yet_checked" : "inference_only",
	}));
	const brief = Array.from({ length: 30 }, (_, index) => ({
		criterion_id: `brief-${String(index + 1).padStart(2, "0")}`,
		text: huge(`brief criterion ${index + 1}`, 2_000),
		reason: "not_yet_checked",
	}));
	const payload = {
		item: { id: "work-max", title: "Maximum follow-through", lifecycle: "implemented" },
		own_criteria_follow_through: {
			action_item_id: "work-max", criteria_total: 30, criteria_settled: 0,
			go_and_check: own.slice(0, 15), weak_evidence: own.slice(15),
			instruction: huge("Act on every own criterion before reporting", 4_000),
		},
		brief_follow_through: {
			brief_id: "brief-max", brief_title: "Maximum brief", band: "final",
			children_total: 4, children_resolved: 4, percent_complete: 100,
			unsettled_criteria: brief,
			instruction: huge("Act on every brief criterion before reporting", 4_000),
		},
		related_candidates: Array.from({ length: 20 }, (_, index) => ({ id: `optional-${index}`, title: huge("optional", 2_000) })),
	};
	const text = projectModelText({ toolName: "record_implementation", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.recordImplementation, `record_implementation projection was ${text.length}`);
	assert.match(text, /item: \[work-max\]/);
	assert.match(text, /brief: \[brief-max\] Maximum brief/);
	for (const entry of own) assert.match(text, new RegExp(`\\[${entry.criterion_id}\\]`), entry.criterion_id);
	for (const entry of brief) assert.match(text, new RegExp(`\\[${entry.criterion_id}\\]`), entry.criterion_id);
	assert.match(text, /go_and_check/);
	assert.match(text, /weak_evidence/);
	assert.match(text, /unsettled_criteria/);
	assert.match(text, /instruction: Act on every own criterion/);
	assert.match(text, /instruction: Act on every brief criterion/);
});

test("acknowledgements reserve every simultaneous reconciliation category", () => {
	const candidates = (prefix: string) => Array.from({ length: 8 }, (_, index) => ({
		id: `${prefix}-${index + 1}`,
		title: huge(`${prefix} title ${index + 1}`, 2_000),
		why: huge(`${prefix} reason ${index + 1}`, 2_000),
	}));
	const payload = {
		action_item: { id: "created-gates", title: "All gates", lifecycle: "staged" },
		review_before_proceeding: { required: true, instruction: huge("review first", 2_000), candidates: candidates("review") },
		check_against_decisions: { required: true, instruction: huge("check decisions", 2_000), decisions: candidates("check") },
		memory_reconciliation: {
			required: true,
			instruction: huge("reconcile", 2_000),
			potential_conflicts: candidates("memory-conflict"),
			near_duplicates: candidates("memory-duplicate"),
			closest_match: candidates("closest")[0],
		},
		related_decisions: candidates("decision"),
		potential_conflicts: candidates("conflict"),
		near_duplicates: candidates("duplicate"),
		related_candidates: candidates("related"),
	};
	const text = projectModelText({ toolName: "create_action_item", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.ack, `ack projection was ${text.length}`);
	for (const [label, id] of [
		["Review-before-proceeding candidates", "review-1"],
		["Decisions to check", "check-1"],
		["Related decisions", "decision-1"],
		["Potential conflicts", "conflict-1"],
		["Near duplicates", "duplicate-1"],
		["Related candidates", "related-1"],
		["Closest existing memory", "closest-1"],
	] as const) {
		const prefix = ["Related decisions", "Potential conflicts", "Near duplicates", "Related candidates"].includes(label) ? "Related context \\(advisory\\)" : "Gate category";
		assert.match(text, new RegExp(`${prefix} — ${label}:[^\\n]*\\[${id}\\]`), label);
	}
	assert.match(text, /7 more omitted from this mandatory summary/);
	assert.match(text, /Gate — review_before_proceeding/);
	assert.match(text, /Gate — check_against_decisions/);
	assert.match(text, /Gate — memory reconciliation/);
});

test("claim_work_item remains a realistic lossless implementation-context read", () => {
	const payload = {
		id: "claim-123",
		title: "Apply accepted review fixes",
		description: huge("FULL-IMPLEMENTATION-CONTEXT", 8_000),
		intent: "Compact common results without losing implementation context.",
		acceptance_criteria: [{ id: "criterion-1", text: "All exact reads remain lossless." }],
		ai_instructions: "Preserve compact output without losing load-bearing context.",
		agent_activity: "implementing",
		agent_branch: "devspec/claim-123",
		claim_success: true,
		relevant_memories: [{ id: "memory-1", title: "Binding projection decision", body: "Do not hide mandatory rules." }],
		relevant_artifacts: [{ id: "resource-1", title: "Review findings", content: "Fix follow-through rendering." }],
		review_signals: [{ type: "needs_attention", reason: "Accepted blocker fixes remain." }],
		project_custom_instructions: "Team principles are mandatory.",
		project_agent_rules: "Run npm test and typecheck before reporting.",
		owner_agent_rules: "Use the local Node toolchain.",
	};
	const text = projectModelText({ toolName: "claim_work_item", text: JSON.stringify(payload), details: payload });
	assert.deepEqual(JSON.parse(text), payload);
	assert.match(text, /FULL-IMPLEMENTATION-CONTEXT/);
	assert.match(text, /ai_instructions/);
	assert.match(text, /relevant_memories/);
	assert.match(text, /relevant_artifacts/);
	assert.match(text, /project_custom_instructions/);
	assert.match(text, /project_agent_rules/);
	assert.match(text, /owner_agent_rules/);
});

test("full exact decision, instruction, transcript, and schema reads are never capped", () => {
	const payload = { id: "exact", body: huge("LOSSLESS-EXACT-CONTENT", 9_000) };
	for (const verb of [
		"get_action_item", "get_session_transcript", "preview_conflict_resolution", "get_project_instruction_rules",
		"get_personal_instructions", "get_workflow_rules", "get_database_schema", "manage_plan", "manage_poll",
	]) {
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.ok(text.length > PROJECTION_BUDGETS.fallback, verb);
		assert.deepEqual(JSON.parse(text), payload, verb);
	}
});

test("create_session and read-like writes preserve their complete load-bearing responses", () => {
	const session = {
		session_id: "session-123",
		session_url: "https://app.devspec.ai/projects/project-1/sessions/session-123",
		title: "Colorful Possum · Pi",
		session_type: "agent_remote_control",
		project_custom_instructions: huge("PROJECT-PRINCIPLES", 7_000),
		project_custom_instructions_note: "Inject team principles.",
		project_agent_rules: huge("PROJECT-AGENT-RULES", 7_000),
		project_agent_rules_note: "Inject team execution mechanics.",
		owner_custom_instructions: huge("OWNER-STYLE", 7_000),
		owner_custom_instructions_note: "Inject owner chat style.",
		owner_agent_rules: huge("OWNER-AGENT-RULES", 7_000),
		owner_agent_rules_note: "Inject owner machine rules.",
	};
	const sessionText = projectModelText({ toolName: "create_session", text: JSON.stringify(session), details: session });
	assert.deepEqual(JSON.parse(sessionText), session);
	assert.match(sessionText, /session_url/);
	assert.match(sessionText, /PROJECT-PRINCIPLES/);
	assert.match(sessionText, /OWNER-AGENT-RULES/);

	for (const verb of ["claim_automation_run", "import_instruction_rules", "update_personal_instructions"]) {
		const payload = { id: `${verb}-1`, permission: "look_only", preview: huge(`${verb}-LOAD-BEARING`, 8_000) };
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.deepEqual(JSON.parse(text), payload, verb);
	}
});

test("update_memory preserves version identity, proposals and exact refusal/preview data", () => {
	assert.equal(projectionFamily("update_memory"), "full");
	const payloads = [
		{ id: "memory-new", updated: "memory-old", new_version: true, previous_version_id: "memory-old", outcome: "committed", note: "Cite the new id from now on." },
		{ id: "memory-old", updated: "memory-old", new_version: false, outcome: "committed", note: "Changed in place." },
		{ updated: false, outcome: "queued_for_review", proposal_id: "proposal-1", reason: "A maintainer must accept it." },
		{ updated: false, outcome: "preview_required", receipt_id: "receipt-1", expires_at: "2026-09-24T09:00:00Z", preview: { id: "memory-old", before: huge("original words"), after: huge("proposed words") }, guidance: "Review the exact change before confirming." },
		{ updated: false, outcome: "stale_context", reason: "The memory changed.", detail: { current_version: 4, expected_version: 3 } },
		{ updated: false, reconcile_required: true, closest_match: { id: "other-memory", title: "Existing decision" }, affordances: ["supersede", "link"], guidance: "Read the counterpart first." },
	];
	for (const details of payloads) {
		const projected = projectModelText({ toolName: "update_memory", text: JSON.stringify(details), details });
		assert.deepEqual(JSON.parse(projected), details, "no version, proposal, preview or refusal field may disappear");
	}
});

test("reserve_work_items keeps what was reserved and why each item was skipped", () => {
	// Live on 2026-10-04: a Reviewed Contributor asked Pi to start suggested work. The
	// server skipped it as approval_required, but the card said only "see skipped for
	// why", so Pi could not tell the person what stopped it or which proposal to review.
	assert.equal(projectionFamily("reserve_work_items"), "ack");
	const details = {
		outcome: "committed", assignment_id: null, reserved: [], reserved_count: 0,
		skipped: [{ reason: "approval_required", proposal_id: "proposal-9", action_item_id: "item-9" }],
		note: "Nothing could be reserved; see skipped for why. No batch was created.",
	};
	const text = projectModelText({ toolName: "reserve_work_items", text: JSON.stringify(details), details });
	assert.match(text, /approval_required/);
	assert.match(text, /proposal-9/);
	assert.match(text, /"reserved_count": 0/);
});

test("a queued suggestion keeps its effect, revision and review route", () => {
	assert.equal(projectionFamily("create_action_item"), "ack");
	const details = {
		recorded: false, outcome: "queued_for_review", effect: "queued", id: "item-7", operation_id: "op-7",
		proposal_id: "proposal-7", proposal_revision: 1, review_url: "/projects/p/review?tab=proposals&key=proposal%7Cproposal-7",
		note: "Saved as suggested work for a Maintainer to review. No work was authorized and no agent was started.",
	};
	const text = projectModelText({ toolName: "create_action_item", text: JSON.stringify(details), details });
	for (const expected of [/outcome=queued_for_review/, /"effect": "queued"/, /"proposal_revision": 1/, /review\?tab=proposals/, /proposal-7/]) {
		assert.match(text, expected);
	}
});

test("write_project_instruction_rule acknowledgement preserves committed versus queued outcome", () => {
	for (const outcome of ["committed", "queued_for_review"]) {
		const payload = { id: `rule-${outcome}`, title: "Run typecheck before push", outcome };
		const text = projectModelText({ toolName: "write_project_instruction_rule", text: JSON.stringify(payload), details: payload });
		assert.match(text, new RegExp(`outcome=${outcome}`));
		assert.ok(text.length <= PROJECTION_BUDGETS.ack);
	}
});

test("goal reads preserve authoritative exact items, project vision, and every current goal", () => {
	const exactGoal = {
		project_id: "project-1",
		goal: { id: "goal-1", title: "Reliable workflows", description: huge("GOAL-DESCRIPTION", 4_000), progress: { total: 20, done: 5 } },
		items: Array.from({ length: 20 }, (_, index) => ({ id: `goal-item-${index + 1}`, title: `Counting item ${index + 1}`, lifecycle: "open", source: index ? "inherited" : "direct" })),
		items_page: { total_matching: 20, offset: 0, limit: 500, returned: 20, has_more: false, next_offset: null },
	};
	const exactText = projectModelText({ toolName: "get_goals", text: JSON.stringify(exactGoal), details: exactGoal });
	assert.deepEqual(JSON.parse(exactText), exactGoal);
	assert.match(exactText, /goal-item-20/);
	assert.match(exactText, /GOAL-DESCRIPTION/);

	const projectGoals = {
		project: { id: "project-1", name: "DevSpec", vision: huge("PROJECT-VISION", 5_000) },
		current_goals: Array.from({ length: 12 }, (_, index) => ({ id: `goal-${index + 1}`, title: `Goal ${index + 1}`, success_criteria: [`Criterion ${index + 1}`] })),
	};
	const projectText = projectModelText({ toolName: "get_project_goals", text: JSON.stringify(projectGoals), details: projectGoals });
	assert.deepEqual(JSON.parse(projectText), projectGoals);
	assert.match(projectText, /PROJECT-VISION/);
	assert.match(projectText, /goal-12/);
});

test("manual follow-up arrays stay bounded with IDs, kinds, counts, and an exact recovery path", () => {
	const steps = Array.from({ length: 100 }, (_, index) => ({
		id: `step-${index + 1}`,
		kind: index % 2 === 0 ? "required_step" : "note",
		description: huge(`follow-up ${index + 1}`, 2_000),
	}));
	const payload = {
		item: { id: "work-followups", title: "Bound follow-up output", lifecycle: "implemented" },
		manual_followup_steps: steps,
	};
	const text = projectModelText({ toolName: "record_implementation", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.recordImplementation);
	assert.match(text, /Manual\/human follow-up: 100; showing 3/);
	assert.match(text, /\[step-1\] required_step/);
	assert.match(text, /\[step-2\] note/);
	assert.match(text, /\[step-3\] required_step/);
	assert.match(text, /97 additional follow-up step\(s\) omitted; use get_action_item\(work-followups\)/);
	assert.doesNotMatch(text, /step-4/);
});

test("DevSpec help projection keeps citeable URLs and bounded section content", () => {
	const results = Array.from({ length: 12 }, (_, index) => ({
		doc: `Guide ${index + 1}`,
		section: `Configure workflow ${index + 1}`,
		url: `https://docs.devspec.ai/guides/workflows#section-${index + 1}`,
		category: "workflows",
		content: `${index === 0 ? "Authoritative answer: reserve the work and record implementation." : `Supporting section ${index + 1}.`}\n\n${huge(`HELP-${index}`, 2_000)}`,
	}));
	const payload = { query: "how does work complete", count: results.length, results };
	const text = projectModelText({ toolName: "devspec_help_search", text: JSON.stringify(payload), details: payload });
	assert.ok(text.length <= PROJECTION_BUDGETS.help);
	assert.match(text, /Guide 1 — Configure workflow 1 \[workflows\]/);
	assert.match(text, /URL: https:\/\/docs\.devspec\.ai\/guides\/workflows#section-1/);
	assert.match(text, /Authoritative answer: reserve the work and record implementation/);
	assert.match(text, /section character\(s\) omitted/);
	assert.match(text, /narrower query/);
	assert.match(text, /More sections: call devspec_help_search again with offset 8\./);
});

test("a later help page says where it starts, that its count is a floor, and the next offset (02526f46)", () => {
	const results = [{ doc: "Guide 9", section: "Ninth", url: "https://docs.devspec.ai/guides/nine", category: "workflows", content: "Nine." }];
	const payload = { query: "workflows", count: 1, page: { total_matching: 10, total_is_lower_bound: true, offset: 8, limit: 1, returned: 1, has_more: true, next_offset: 9 }, results };
	const text = projectModelText({ toolName: "devspec_help_search", text: JSON.stringify(payload), details: payload });
	assert.match(text, /at least 10 sections; showing 1 from 9\./);
	assert.match(text, /call devspec_help_search again with offset 9\./);
});

test("search_resources names one offset that continues both corpora (02526f46)", () => {
	const payload = {
		documents: [{ id: "doc-1", title: "Runbook" }],
		artifacts: [{ id: "art-1", title: "ADR" }],
		pages: {
			documents: { total_matching: 1, offset: 0, limit: 1, returned: 1, has_more: false, next_offset: null },
			artifacts: { total_matching: 101, total_is_lower_bound: true, offset: 0, limit: 1, returned: 1, has_more: true, next_offset: 1 },
		},
	};
	const text = projectModelText({ toolName: "search_resources", text: JSON.stringify(payload), details: payload });
	assert.match(text, /Next page: call search_resources again with offset 1 \(matches: documents 1, artifacts 101\+\)\./);
	assert.match(text, /count marked \+ is a floor/);
});

test("a search that could not reach part of its corpus says so, and is never read as empty (0ab1054e)", () => {
	const payload = {
		documents: [],
		artifacts: [],
		counts: { documents: null, artifacts: 0 },
		incomplete: true,
		unavailable: ["documents"],
		unavailable_note: "The documents lookup failed. Do not report that no matching documents exist; search again, or say the search was incomplete.",
		pages: { artifacts: { total_matching: 0, offset: 0, limit: 20, returned: 0, has_more: false, next_offset: null } },
	};
	const text = projectModelText({ toolName: "search_resources", text: JSON.stringify(payload), details: payload });
	assert.match(text, /Incomplete: The documents lookup failed\. Do not report that no matching documents exist/);
	assert.doesNotMatch(text, /recognized empty result set/);
});

test("known-family unknown shapes fall back transparently instead of inventing empty/ack responses", () => {
	for (const [verb, payload] of [
		["search_action_items", { entries: [{ uuid: "future-item", label: "Future shape" }] }],
		["create_action_item", { created_entity: { uuid: "future-created" } }],
		["get_project_summary", { orientation_v2: { uuid: "future-project" } }],
	] as const) {
		const text = projectModelText({ toolName: verb, text: JSON.stringify(payload), details: payload });
		assert.match(text, /future-/);
		assert.doesNotMatch(text, /No matching entities|acknowledged|Project: \(name not returned\)/);
	}
});

test("production family budgets hold on adversarial selected fields without arbitrary JSON cuts", () => {
	const noisyItems = Array.from({ length: 30 }, (_, index) => ({
		id: huge(`id-${index}`, 2_000), title: huge(`title-${index}`, 3_000), lifecycle: huge("state", 1_000),
		why: huge("why", 4_000), signals: [huge("signal", 2_000)],
	}));
	const collection = projectModelText({ toolName: "search_action_items", text: "", details: { results: noisyItems, total: 30 } });
	assert.ok(collection.length <= PROJECTION_BUDGETS.collection);
	assert.match(collection, /omitted/i);

	const project = projectModelText({
		toolName: "get_project_summary",
		text: "",
		details: {
			id: huge("project-id", 2_000), name: huge("project-name", 4_000),
			repos: noisyItems, database_targets: noisyItems, members: noisyItems, goals: noisyItems,
			execution: {
				branch_prefix: huge("branch", 2_000),
				protected_paths: noisyItems.map((_, index) => huge(`path-${index}`, 2_000)),
				custom_instructions: huge("principles", 9_000), agent_rules: huge("agent-rules", 9_000),
			},
			owner_agent_rules: huge("owner-rules", 9_000),
		},
	});
	const complete = JSON.parse(project.split('<devspec-project-data>\n')[1]!.split('\n</devspec-project-data>')[0]!);
	assert.deepEqual(complete.repos, noisyItems);
	assert.deepEqual(complete.members, noisyItems);
	assert.deepEqual(complete.database_targets, noisyItems);
	assert.deepEqual(complete.goals, noisyItems);
	assert.equal(complete.execution.custom_instructions, huge('principles', 9_000));
	assert.equal(complete.execution.agent_rules, huge('agent-rules', 9_000));
	assert.equal(complete.owner_agent_rules, huge('owner-rules', 9_000));
	assert.equal(complete.execution.protected_paths.length, 30);
	assert.doesNotMatch(project, /omitted/i);

	const ack = projectModelText({
		toolName: "create_action_item",
		text: "",
		details: {
			action_item: { id: huge("id", 2_000), title: huge("title", 3_000), lifecycle: huge("state", 2_000) },
			review_before_proceeding: { required: true, instruction: huge("instruction", 5_000) },
			related_candidates: noisyItems,
			potential_conflicts: noisyItems,
			near_duplicates: noisyItems,
		},
	});
	assert.ok(ack.length <= PROJECTION_BUDGETS.ack);
	assert.match(ack, /omitted/i);
});

test("unknown structured fallback omits whole fields and non-JSON fallback is truthful", () => {
	const structured = projectModelText({
		toolName: "future_server_verb",
		text: "",
		details: { small: "kept", huge_field: huge("large", 10_000), tail: "also-kept" },
	});
	assert.ok(structured.length <= PROJECTION_BUDGETS.fallback);
	assert.match(structured, /"small": "kept"/);
	assert.match(structured, /"tail": "also-kept"/);
	assert.match(structured, /complete payload is host-retained in details, which is not a model-visible continuation/);
	assert.doesNotMatch(structured, /large: internal payload internal paylo$/);

	const plain = projectModelText({ toolName: "future_server_verb", text: "x".repeat(9_000), details: null });
	assert.ok(plain.length <= PROJECTION_BUDGETS.fallback);
	assert.match(plain, /Non-JSON source truncated; no structured details are available/);
	assert.match(plain, /narrower parameters/);
	assert.doesNotMatch(plain, /remains in tool result details/i);
});

test("full details still drive conflict flags and work status", () => {
	const itemId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const payload = {
		claim_success: true,
		item: { id: itemId, title: "Shape lifecycle response", lifecycle: "implemented" },
		action_item_id: itemId,
		unresolved_conflicts: [{ conflicting_item_id: "work-older", reason: "Potentially superseded" }],
	};
	const result = projectedToolResult("record_implementation", unwrapMcpResult(mcpJson(payload)));
	assert.deepEqual(extractItemRef(result), { id: itemId, title: "Shape lifecycle response" });
	const extracted = extractFlags("record_implementation", result.details);
	assert.equal(extracted.length, 1);
	assert.equal(extracted[0].subject, itemId);
	assert.equal(extracted[0].counterpart, "work-older");
	assert.equal(extracted[0].kind, "item_conflict");
	assert.match(extracted[0].label, /get_action_item/);
	clearAllFlags();
	resetStatus();
	resetWorkStateForTests();
	const sessionId = "projection-test-session";
	const claim = projectedToolResult("claim_work_item", unwrapMcpResult(mcpJson(payload)));
	consumeResultMechanics("claim_work_item", claim, { action_item_id: itemId }, sessionId);
	assert.equal(getStatusSnapshot().workId, itemId);
	assert.equal(listFlags()[0]?.subject, itemId);
	assert.equal(listFlags()[0]?.counterpart, "work-older");
	assert.notEqual(listFlags()[0]?.scope, "legacy", "native calls isolate observations by session/project");
	const decisionResolution = projectedToolResult(
		"resolve_action_item_decision_flag",
		unwrapMcpResult(mcpJson({ ok: true, action_item_id: itemId, marks_cleared: { actionItem: 1 } })),
	);
	consumeResultMechanics("resolve_action_item_decision_flag", decisionResolution);
	assert.equal(getStatusSnapshot().workId, itemId, "a flag ruling is not a work-status transition");
	consumeResultMechanics("record_implementation", result, { action_item_id: itemId }, sessionId);
	assert.equal(getStatusSnapshot().workId, undefined);
	clearAllFlags();
	resetStatus();
});

test("Pi OpenAI completions, Codex/responses, and Google adapters serialize content, never details", () => {
	const secret = "DETAILS-MUST-NOT-ENTER-MODEL-CONTEXT";
	const context = toolContext(secret);
	const openAI = convertOpenAICompletionsMessages(model("openai-completions") as never, context as never, {} as never);
	// Codex and OpenAI Responses use this exported shared converter.
	const codex = convertResponsesMessages(model("openai-codex-responses") as never, context as never, new Set(["test"]));
	const google = convertGoogleMessages(model("google-generative-ai") as never, context as never);
	for (const [provider, wire] of [["OpenAI completions", openAI], ["OpenAI Codex", codex], ["Google", google]] as const) {
		const encoded = JSON.stringify(wire);
		assert.match(encoded, /compact visible content/, provider);
		assert.doesNotMatch(encoded, new RegExp(secret), provider);
		assert.doesNotMatch(encoded, /hidden/, provider);
	}
});

test("Pi Anthropic adapter payload hook observes content, never details", async () => {
	const secret = "ANTHROPIC-DETAILS-MUST-STAY-HIDDEN";
	let captured: unknown;
	const sentinel = new Error("captured-before-network");
	const events = streamAnthropic(model("anthropic-messages") as never, toolContext(secret) as never, {
		client: {} as never,
		onPayload(payload) {
			captured = payload;
			throw sentinel;
		},
	} as never);
	const terminal = await events.result();
	assert.equal(terminal.stopReason, "error");
	assert.match(terminal.errorMessage ?? "", /captured-before-network/);
	const wire = JSON.stringify(captured);
	assert.match(wire, /compact visible content/);
	assert.doesNotMatch(wire, new RegExp(secret));
	assert.doesNotMatch(wire, /hidden/);
});

test("a paged DevSpec list names the exact next page, and a ranked floor says so (item cc630fb8)", () => {
	const page = { total_matching: 327, offset: 0, limit: 20, returned: 2, has_more: true, next_offset: 20 };
	const payload = { memories: [{ id: "m1", title: "One" }, { id: "m2", title: "Two" }], page };
	const text = projectModelText({ toolName: "get_decisions", text: JSON.stringify(payload), details: payload });
	assert.match(text, /get_decisions: 327 results; showing 2\./);
	assert.match(text, /Next page: call get_decisions again with offset 20\./);
	const last = { ...payload, page: { ...page, has_more: false, next_offset: null } };
	assert.doesNotMatch(projectModelText({ toolName: "get_decisions", text: JSON.stringify(last), details: last }), /Next page/);
	const floor = { results: [{ id: "a1", title: "A" }], page: { total_matching: 200, total_is_lower_bound: true, offset: 0, limit: 1, returned: 1, has_more: true, next_offset: 1 } };
	assert.match(projectModelText({ toolName: "search_action_items", text: JSON.stringify(floor), details: floor }), /the count is a floor/);
});
