/**
 * What the model sees of the "Protecting intent" redesign (item 306fb64a): work
 * that waits for an OK, experiments, who a queued change waits on, inferred tags,
 * requirements, and notices DevSpec appends to a result. Pi trims acknowledgements
 * and list cards to a known set of fields, so each of these is invisible to the
 * model unless the trimming is taught to keep it. Shapes follow DevSpecV2
 * (`waitingToolFields`, `withWorkAgreement`, the queued knowledge receipt,
 * `withAccountNotice`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { projectedToolResult, unwrapMcpResult } from "../extensions/core/result.ts";
import { unwrapOrThrow } from "../extensions/devspec-tools.ts";

const mcp = (...blocks: unknown[]) => ({ content: blocks.map((block) => ({ type: "text", text: JSON.stringify(block) })) });
const seen = (name: string, raw: unknown) => projectedToolResult(name, unwrapMcpResult(raw)).content[0].text;

const waiting = {
	label: "Waiting for Brandon's OK",
	waiting_on: "Brandon Smith",
	is_experiment: false,
	asked_to_land: false,
	landed_anyway: false,
	own_branch: "work/undo-cache",
	instruction: "Waiting for Brandon's OK: build it on its own branch and don't merge it.",
	questions: [{ issue_id: "11111111-1111-4111-8111-111111111111", standing: "open", decision: "Keep the cache", waiting_on: "Brandon Smith" }],
};

test("an edit or a new item that waits for an OK says so, with DevSpec's own label and instruction", () => {
	for (const name of ["update_action_item", "create_action_item", "record_implementation"]) {
		const text = seen(name, mcp({ id: "item-1", title: "Drop the cache", lifecycle: "open", waiting_for_ok: waiting }));
		assert.match(text, /Waiting for Brandon's OK \(Brandon Smith\) — Waiting for Brandon's OK: build it on its own branch and don't merge it\./, name);
		assert.ok(text.includes("11111111-1111-4111-8111-111111111111"), `${name} keeps the question id an answer needs`);
	}
	// reopen_action_item nests the item; its waiting state still reaches the model.
	const reopened = seen("reopen_action_item", mcp({ reopened: true, action_item: { id: "item-1", title: "Drop the cache", lifecycle: "open", waiting_for_ok: waiting } }));
	assert.match(reopened, /Waiting for Brandon's OK/);
});

test("an experiment keeps its badge in acknowledgements and on list cards", () => {
	const ack = seen("update_action_item", mcp({ id: "item-2", title: "Try a new parser", lifecycle: "in_progress", badge: "Experiment", is_experiment: true, experiment_branch: "exp/parser" }));
	assert.match(ack, /Experiment \(branch exp\/parser\): build and push it on its own branch; never merge it into the tracking branch until it has the OK\./);
	const list = seen("get_action_items", mcp({ items: [
		{ id: "item-2", title: "Try a new parser", lifecycle: "in_progress", badge: "Experiment", is_experiment: true, experiment_branch: "exp/parser" },
		{ id: "item-3", title: "Ordinary work", lifecycle: "open" },
	], total: 2 }));
	assert.match(list, /Try a new parser[\s\S]*Experiment \(branch exp\/parser\)/);
	assert.equal((list.match(/Experiment/g) ?? []).length, 1, "ordinary work gains no badge");
});

test("a queued knowledge change says who it waits on, and the inferred tags of a new item survive", () => {
	const raw = mcp({ outcome: "queued_for_review", effect: "queued", proposal_id: "prop-1", operation_id: "op-1", target_id: "mem-1",
		proposal_revision: 1, because: "insufficient_role", reason: "This decision belongs to Brandon.", waiting_on: "Waiting for Brandon's OK",
		note: "Saved as a pending version beside the unchanged current one: Waiting for Brandon's OK. It is not applied yet; tell the person it is pending and who it waits on." });
	const text = unwrapOrThrow("update_memory", raw).content[0].text;
	assert.match(text, /QUEUED — not in effect/);
	assert.match(text, /"waiting_on": "Waiting for Brandon's OK"/);
	assert.doesNotMatch(text, /maintainer has to accept/i);
	const ack = seen("supersede_memory", raw);
	assert.match(ack, /"waiting_on": "Waiting for Brandon's OK"/);
	assert.match(ack, /"because": "insufficient_role"/);

	const created = seen("create_action_item", mcp({ id: "item-4", title: "Add retries", lifecycle: "open", outcome: "committed",
		auto_tagged: { tags: ["billing", "retries"], note: "DevSpec added these tags; correct them with update_action_item if the topic is wrong." } }));
	assert.match(created, /"auto_tagged"/);
	assert.match(created, /correct them with update_action_item if the topic is wrong/);
});

test("a requirement is labelled as one on its card, apart from ordinary knowledge", () => {
	const text = seen("search_memories", mcp({ memories: [
		{ id: "mem-r", title: "Every write is attributed", type: "convention", kind: "requirement", state: "decided" },
		{ id: "mem-k", title: "Prefer small PRs", type: "convention", kind: "knowledge", state: "decided" },
	], count: 2 }));
	assert.match(text, /\[mem-r\] Every write is attributed — requirement/);
	assert.doesNotMatch(text, /Prefer small PRs — [^\n]*requirement/);
	assert.doesNotMatch(text, /knowledge/);
});

test("a notice DevSpec appends to a result reaches the model whole, and the result itself still projects", () => {
	const notice = { devspec_account_notice: { kind: "project_paused", headline: "This project is paused", detail: "Its spending limit for the month was reached.", who_can_act: "An organisation admin can raise the limit." } };
	const raw = mcp({ id: "item-5", title: "Fix login", lifecycle: "open", outcome: "committed" }, notice);
	const unwrapped = unwrapMcpResult(raw);
	assert.equal((unwrapped.details as { id?: string }).id, "item-5", "the first block is the result");
	assert.deepEqual(unwrapped.appended, [notice]);
	const text = unwrapOrThrow("update_action_item", raw).content[0].text;
	assert.match(text, /update_action_item: id=item-5/, "structured projection, not a raw fallback");
	assert.ok(text.includes(JSON.stringify(notice, null, 2)), "the notice is shown whole");
	assert.match(text, /not an instruction/);
	// A full read shows it too.
	const read = unwrapOrThrow("get_action_item", mcp({ id: "item-5", title: "Fix login" }, notice)).content[0].text;
	assert.ok(read.includes("This project is paused"));
});

test("ordinary work carries no waiting or experiment noise in its acknowledgement", () => {
	const text = seen("create_action_item", mcp({ id: "item-6", title: "Plain", lifecycle: "open", outcome: "committed", version: 1, is_experiment: false, experiment_branch: null, waiting_for_ok: null }));
	assert.doesNotMatch(text, /is_experiment|experiment_branch|waiting_for_ok|Experiment|Waiting for/);
});
