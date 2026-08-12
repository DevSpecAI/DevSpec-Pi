import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkPrompt, suggestBranch } from "../extensions/core/work-prompt.ts";
import type { WorkTarget } from "../extensions/core/work-prompt.ts";

const item: WorkTarget = {
	id: "e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d",
	title: "Preview conflict resolution before committing",
	payload: { id: "e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d", description: "..." },
	fromQueue: false,
};

test("suggestBranch: short id + slugified title, capped at 40 slug chars", () => {
	assert.equal(suggestBranch(item), "devspec/e10f3ad1-preview-conflict-resolution-before-commi");
	const slug = suggestBranch(item).split("/")[1];
	assert.ok(slug.length <= 8 + 1 + 40);
});

test("suggestBranch tolerates missing title", () => {
	assert.equal(suggestBranch({ ...item, title: undefined }), "devspec/e10f3ad1");
});

test("buildWorkPrompt carries the workflow contract", () => {
	const p = buildWorkPrompt(item);
	assert.match(p, /claim_work_item/);
	assert.match(p, /do not force past/i);
	assert.match(p, /\[devspec:e10f3ad1-c2ce-4d56-a87f-8f00d6c6384d\]/);
	assert.match(p, /record_implementation/);
	assert.match(p, /never mark the item done/i);
	assert.match(p, /"implemented" and stop/);
	assert.match(p, /```json/);
});

test("buildWorkPrompt distinguishes queue picks from explicit choices", () => {
	assert.match(buildWorkPrompt(item), /chosen explicitly/);
	assert.match(buildWorkPrompt({ ...item, fromQueue: true }), /next staged item from the project queue/);
});
