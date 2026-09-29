import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setBond, type BondState } from "../extensions/core/bond-state.ts";
import { buildBondedInstructions } from "../extensions/devspec-context.ts";
import { instructionContextMessage, applyConnectionContext } from "../extensions/core/connection-context.ts";

afterEach(() => {
	setBond(null);
});

function bonded(overrides: Partial<BondState> = {}): BondState {
	return {
		connectionId: "11111111-1111-4111-8111-111111111111",
		codename: "Amber Hawk",
		sessionId: "22222222-2222-4222-8222-222222222222",
		sessionTitle: "Better rhythm",
		instructions: {
			owner_custom_instructions: "Talk to me like a person talking aloud.",
			owner_agent_rules: "Never touch the everyday browser.",
			project_custom_instructions: "No hacky workarounds.",
			project_agent_rules: "Target branch is staging.",
		},
		...overrides,
	};
}

test("bonded block carries identity while heavy tiers live in an immutable tail", () => {
	setBond(bonded());
	const block = buildBondedInstructions();
	assert.ok(block);
	assert.ok(block.includes("Amber Hawk"));
	assert.ok(block.includes("Better rhythm"));
	assert.doesNotMatch(block, /No hacky workarounds|Target branch is staging|Never touch the everyday browser/);
	const context = instructionContextMessage(bonded());
	assert.match(context, /No hacky workarounds/);
	assert.match(context, /Target branch is staging/);
	assert.match(context, /Never touch the everyday browser/);
	assert.doesNotMatch(context, /Talk to me like a person/);
});

test("bonded block carries no response style: style rides each command, not the prompt (6a511dab)", () => {
	setBond(bonded());
	const block = buildBondedInstructions()!;
	assert.doesNotMatch(block, /Owner style/);
	// The owner's saved style text must not appear anywhere in the prompt,
	// even though the server still sends it on the connect tiers.
	assert.ok(!block.includes("Talk to me like a person talking aloud."));
});

test("bonded block is byte-stable across preference edits", () => {
	setBond(bonded());
	const before = buildBondedInstructions();
	setBond(bonded({
		instructions: {
			owner_custom_instructions: "A completely different style, edited mid-session.",
			owner_agent_rules: "Never touch the everyday browser.",
			project_custom_instructions: "No hacky workarounds.",
			project_agent_rules: "Target branch is staging.",
		},
	}));
	const after = buildBondedInstructions();
	assert.equal(after, before);
});

test("clears explicit null rules, preserves omitted rules and keeps the system prefix stable", () => {
	const previous = bonded({projectId:'project'});
	setBond(previous); const prefix = buildBondedInstructions();
	const next = applyConnectionContext(previous, {project_id:'project',project_agent_rules:null,owner_agent_rules:'New machine rule',session_id:'not-adopted',speech_attachment_id:'not-adopted'});
	assert.equal(next.sessionId, previous.sessionId);
	assert.equal(next.speechAttachmentId, previous.speechAttachmentId);
	assert.equal(next.instructions?.project_agent_rules, undefined);
	assert.equal(next.instructions?.owner_agent_rules, 'New machine rule');
	assert.equal(next.instructions?.project_custom_instructions, previous.instructions?.project_custom_instructions);
	assert.equal(previous.instructions?.project_agent_rules, 'Target branch is staging.');
	setBond(next); assert.equal(buildBondedInstructions(), prefix);
	assert.notEqual(instructionContextMessage(next), instructionContextMessage(previous));
	assert.throws(()=>applyConnectionContext(previous,{project_id:'other'}), /different project/);
});

test("unbonded sessions build no bonded block", () => {
	setBond(null);
	assert.equal(buildBondedInstructions(), null);
});
