import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setBond, type BondState } from "../extensions/core/bond-state.ts";
import { buildBondedInstructions } from "../extensions/devspec-context.ts";

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

test("bonded block carries identity and the heavy tiers", () => {
	setBond(bonded());
	const block = buildBondedInstructions();
	assert.ok(block);
	assert.ok(block.includes("Amber Hawk"));
	assert.ok(block.includes("Better rhythm"));
	assert.ok(block.includes("Project principles: No hacky workarounds."));
	assert.ok(block.includes("Project agent rules (mandatory): Target branch is staging."));
	assert.ok(block.includes("Owner machine rules: Never touch the everyday browser."));
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

test("unbonded sessions build no bonded block", () => {
	setBond(null);
	assert.equal(buildBondedInstructions(), null);
});
