import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildDevspecInstructions, INSTRUCTIONS_VERSION } from "../extensions/core/instructions.ts";
import { HOT_SET, TOOL_LOADER_NAME, rareModelVerbs } from "../extensions/core/model-surface.ts";
import { modelFacingCatalog } from "../extensions/devspec-tools.ts";
import { PUMP_VERBS } from "../extensions/generated/mcp-catalog.ts";

test("instructions reference only tools this package registers", () => {
	const text = buildDevspecInstructions();
	const registered = new Set(modelFacingCatalog().map((e) => e.name));
	registered.add(TOOL_LOADER_NAME);
	const mentioned = text.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
	for (const word of new Set(mentioned)) {
		if (word === TOOL_LOADER_NAME) continue;
		if (!HOT_SET.has(word) && !rareModelVerbs().includes(word)) continue;
		assert.ok(
			registered.has(word),
			`instructions mention a rare/unregistered tool as if it were always-on: ${word}`,
		);
	}
});

test("instructions carry the load-bearing rules", () => {
	const text = buildDevspecInstructions();
	assert.match(text, /\[devspec:<id>\]/);
	assert.match(text, /record_implementation/);
	assert.match(text, /never mark items done/i);
	// It must NOT restate who may verify. "a human verifies" was true until
	// evidence promotion shipped, and then quietly became a lie in six of seven
	// hosts for months (48d53ea3, memory d4e62185). The boundary belongs to the
	// served contract; this block points at it.
	assert.doesNotMatch(text, /a human verifies/i);
	// The acquisition shape every host now teaches: reserve what you were asked
	// to work, claim in order. Nothing arrives by assignment (item 3b601ffa).
	assert.match(text, /reserve_work_items/);
	assert.doesNotMatch(text, /arrives by assignment/i);
	assert.match(text, /claim_work_item/);
	// No claim waits on a pairwise conflict check any more (DevSpec item df1e2277).
	assert.doesNotMatch(text, /possible_conflict/);
	assert.match(text, /missing claim never blocks edits, execution, tests, worktrees, delegation, or follow-through/i);
	assert.match(text, /commit_provenance_contract/);
	// Who may commit, and what a queued write means, is the served authority section — pointed at, never restated (item 06936ee9).
	// The pointer is a full sentence plus the operational relay of a queued write (item 45588384); it does not name who may commit.
	assert.match(text, /authority_contract/);
	assert.match(text, /Who may commit a memory, artifact, rule, flag ruling or supersession/);
	assert.match(text, /queued_for_review carries a proposal_id, a reason and who it waits on/);
	// Who a queued change waits on is DevSpec's to say: not always a Maintainer (contract 4.31.0).
	assert.doesNotMatch(text, /a maintainer has to accept/i);
	// Waiting work stays on its own branch; who gives the OK is pointed at, never restated.
	assert.match(text, /waiting_for_ok/);
	assert.match(text, /never merge it into the tracking branch/);
	assert.match(text, /reversal_rule/);
	// The capture bar (ADR "Protecting intent" §11): only the person's answer makes a decision.
	assert.match(text, /only their answer makes it their decision/);
	assert.match(text, /never report the change as done/i);
	assert.match(text, /not a rule to remember here/);
	// Knowledge writes no longer stop on a close match, and confirm_new is gone (df1e2277).
	assert.doesNotMatch(text, /close match|confirm_new/);
	assert.match(text, /create_resource/);
	assert.match(text, /Search is optional/);
	assert.match(text, /include_implementation_contract:true/);
	assert.doesNotMatch(text, /interactive authority|maintainer-only|always queues/i);
	assert.match(text, /server reconciliation/);
	assert.doesNotMatch(text, /trusted subprocess|trusted child/i);
	assert.match(text, /record_memory/);
	assert.match(text, /git_remote/);
	assert.match(text, /extension already knows/i);
	assert.doesNotMatch(text, /or session id/i);
	assert.match(text, /search_devspec_tools/);
	assert.match(text, /concise user-facing sentence/);
	assert.match(text, /never narrate individual tools/);
});

test("bonded remote prose distinguishes delegated scope and points to served policy", () => {
	const source = readFileSync(new URL("../extensions/devspec-context.ts", import.meta.url), "utf8");
	assert.match(source, /Owner authority and delegated project scope differ/);
	assert.match(source, /devspec:\/\/product\/remote-ingress-contract/);
	assert.doesNotMatch(source, /owner instructions delivered via the bond/);
	assert.doesNotMatch(source, /sandbox|mechanical(?:ly)? enforce/i);
});

test("instructions do not dump search-first or the 76-verb map", () => {
	const text = buildDevspecInstructions();
	assert.doesNotMatch(text, /Check DevSpec first/);
	assert.doesNotMatch(text, /When X, call Y/);
	assert.doesNotMatch(text, /never describe→call/);
	assert.doesNotMatch(text, /search_tasks/);
	assert.doesNotMatch(text, /search_resources/);
	assert.doesNotMatch(text, /get_tasks/);
	assert.doesNotMatch(text, /record_criterion_verdicts/);
	assert.doesNotMatch(text, /get_session_transcript/);
	for (const pump of PUMP_VERBS) {
		assert.ok(!text.includes(pump), `instructions leaked pump verb ${pump}`);
	}
	assert.ok(!text.includes("post_session_message"));
});

test("instructions stay compact (every line costs tokens per turn)", () => {
	const text = buildDevspecInstructions();
	// Every line here costs tokens on every turn, so keep a test. The budget exists
	// to catch a dumped verb map or a pasted contract, not to ration a sentence.
	// At Pi 0.3.0 the block was 2,192 chars; adding the authority pointer meant
	// squeezing it to a fragment and trimming two unrelated lines to stay under
	// 2,200 (item 45588384). Quality of instruction beats a few hundred characters;
	// the block is tiny relative to any model context.
	const COMPACT_CEILING_CHARS = 8_000;
	assert.ok(
		text.length < COMPACT_CEILING_CHARS,
		`instructions bloated: ${text.length} chars (ceiling ${COMPACT_CEILING_CHARS})`,
	);
	const PER_BULLET_CEILING_CHARS = 1_200;
	for (const line of text.split("\n")) {
		const bullet = line.trim();
		if (!bullet.startsWith("- ")) continue;
		assert.ok(
			bullet.length < PER_BULLET_CEILING_CHARS,
			`instruction bullet is an essay (${bullet.length} chars, ceiling ${PER_BULLET_CEILING_CHARS}): ${bullet.slice(0, 80)}`,
		);
	}
	assert.ok(INSTRUCTIONS_VERSION >= 13);
});
