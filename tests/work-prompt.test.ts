import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	type ImplementationContractContext,
} from "../extensions/core/implementation-contract.ts";
import { buildWorkPrompt, type WorkTarget } from "../extensions/core/work-prompt.ts";

const item: WorkTarget = {
	id: "e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d",
	title: "Preview conflict resolution before committing",
	payload: { id: "e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d", description: "..." },
};

const contract: ImplementationContractContext = {
	contractVersion: "4.2.0",
	contractHash: "sha256:contract",
	resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
	source: "resource",
	rules: [
		{ id: "core.claim-early", requirement: "Claim early; missing claims never block local work." },
		{ id: "core.truthful-handoff", requirement: "Hand work back truthfully." },
	],
};

test("buildWorkPrompt carries thin work/contract identity and mechanically loaded rules", () => {
	const prompt = buildWorkPrompt(item, contract);
	assert.match(prompt, /^DevSpec work kickoff: /);
	assert.match(prompt, /"task_ids":\["e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d"\]/);
	assert.match(prompt, /"contract_version":"4.2.0"/);
	assert.doesNotMatch(prompt, /assignment_id|assignmentId/);
	assert.match(prompt, /devspec:\/\/product\/implementation-contract"/);
	assert.match(prompt, /core\.claim-early/);
	assert.match(prompt, /core\.truthful-handoff/);
	assert.match(prompt, /explicitly selected here/);
	assert.match(prompt, /```json/);
	// No mode rides on the prompt, and no mode-specific resource is named.
	assert.doesNotMatch(prompt, /execution_mode|attended|unattended/);
});

test("buildWorkPrompt does not maintain a second detailed workflow", () => {
	const prompt = buildWorkPrompt(item, contract);
	assert.doesNotMatch(prompt, /Follow the DevSpec workflow/);
	assert.doesNotMatch(prompt, /next staged item from the project queue/);
	assert.doesNotMatch(prompt, /unless the project's branch_prefix/);
	assert.doesNotMatch(prompt, /Act on any own_criteria_follow_through/);
});
