import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URIS,
	type EffectiveImplementationContext,
} from "../extensions/core/implementation-contract.ts";
import { buildWorkPrompt, type WorkTarget } from "../extensions/core/work-prompt.ts";

const item: WorkTarget = {
	id: "e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d",
	title: "Preview conflict resolution before committing",
	payload: { id: "e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d", description: "..." },
};

const contract: EffectiveImplementationContext = {
	executionMode: "attended",
	contractVersion: "1.0.0",
	contractHash: "sha256:contract",
	resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URIS.attended,
	source: "resource",
	coreRules: [{ id: "core.claim-before-edit", requirement: "Claim before editing." }],
	modeRules: [{ id: "attended.no-implicit-queue-drain", requirement: "Do not drain a queue." }],
};

test("buildWorkPrompt carries thin work/mode/contract identity and mechanically loaded rules", () => {
	const prompt = buildWorkPrompt(item, contract);
	assert.match(prompt, /^DevSpec work kickoff: /);
	assert.match(prompt, /"action_item_ids":\["e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d"\]/);
	assert.match(prompt, /"execution_mode":"attended"/);
	assert.match(prompt, /"contract_version":"1.0.0"/);
	assert.match(prompt, /devspec:\/\/product\/implementation-contract\/attended/);
	assert.match(prompt, /core\.claim-before-edit/);
	assert.match(prompt, /attended\.no-implicit-queue-drain/);
	assert.match(prompt, /explicit attended selection/);
	assert.match(prompt, /```json/);
});

test("buildWorkPrompt does not maintain a second detailed workflow", () => {
	const prompt = buildWorkPrompt(item, contract);
	assert.doesNotMatch(prompt, /Follow the DevSpec workflow/);
	assert.doesNotMatch(prompt, /next staged item from the project queue/);
	assert.doesNotMatch(prompt, /unless the project's branch_prefix/);
	assert.doesNotMatch(prompt, /Act on any own_criteria_follow_through/);
});
