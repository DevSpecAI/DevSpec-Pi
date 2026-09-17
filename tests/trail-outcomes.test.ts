import assert from "node:assert/strict";
import { test } from "node:test";
import { TrailBuilder } from "../extensions/core/trail.ts";
import { toolErrorResult } from "../extensions/core/result.ts";
import { domainIdentity, writeOutcomeFromResult } from "../extensions/core/trail-events.ts";

const SOURCE = "74000000-0000-4000-8000-000000000001";
const RETURNED = "74000000-0000-4000-8000-000000000002";
const PROPOSAL = "74000000-0000-4000-8000-000000000003";
const PRIVATE = "PRIVATE_RECEIPT_SENTINEL";
const wrappers = {
	plain: (row: Record<string, unknown>) => row,
	details: (row: Record<string, unknown>) => ({ details: row, content: [{ type: "text", text: PRIVATE }] }),
	json: (row: Record<string, unknown>) => ({ content: [{ type: "text", text: JSON.stringify(row) }] }),
};

function completed(name: string, result: unknown, ok = true) {
	const trail = new TrailBuilder();
	trail.toolStart("call", name, { id: SOURCE, title: "Recorded title", body: PRIVATE });
	trail.toolEnd("call", name, ok, result);
	const event = trail.events()[0];
	assert.equal(event?.kind, "domain");
	if (event?.kind !== "domain") throw new Error("Expected domain event");
	assert.ok(!JSON.stringify(trail.events()).includes(PRIVATE));
	assert.ok(!trail.render().includes(PRIVATE));
	return event;
}

const softGates: Array<[string, Record<string, unknown>]> = [
	["supersede_memory", { superseded: false, reconcile_required: true }],
	["supersede_resource", { superseded: false, reconcile_required: true }],
	["update_resource", { updated: false, reconcile_required: true }],
	["record_memory", { recorded: false, reconcile_required: true }],
	["create_resource", { created: false }],
	["claim_work_item", { claim_success: false }],
	["record_implementation", { implementation_recorded: false }],
	["retract_memory", { retracted: false }],
	["archive_resource", { archived: false }],
	["resolve_action_item_conflict", { resolved: false }],
	["update_action_item", { applied: false }],
];
for (const [wrapperName, wrap] of Object.entries(wrappers)) {
	for (const [name, receipt] of softGates) {
		test(`${name}: ${wrapperName} non-applied receipt never links the original or a suggested match`, () => {
			const result = wrap({ ...receipt, closest_match: { id: RETURNED, body: PRIVATE }, guidance: PRIVATE });
			assert.equal(writeOutcomeFromResult(result), "not_applied");
			assert.equal(domainIdentity(name, { id: SOURCE }, result).id, undefined);
			const event = completed(name, result);
			assert.equal(event.status, "ok"); // The comparison completed; the write did not apply.
			assert.equal(event.action, "not applied");
			assert.equal(event.id, undefined);
			assert.match(event.result ?? "", /outcome=not_applied/);
		});
	}

	for (const name of ["record_memory", "supersede_memory", "create_resource", "update_resource", "supersede_resource", "resolve_action_item_conflict"]) {
		test(`${name}: ${wrapperName} proposal is not an applied source record or a record with the proposal's ID`, () => {
			const result = wrap({ outcome: "queued_for_review", recorded: false, committed: false,
				proposal_id: PROPOSAL, id: SOURCE, payload: { body: PRIVATE } });
			assert.equal(writeOutcomeFromResult(result), "queued_for_review");
			const event = completed(name, result);
			assert.equal(event.status, "ok");
			assert.equal(event.action, name === "resolve_action_item_conflict" ? "contested" : "proposed");
			assert.equal(event.id, undefined);
			assert.match(event.result ?? "", /outcome=queued_for_review/);
		});
	}

	for (const name of ["supersede_memory", "supersede_resource", "record_memory", "create_resource", "create_action_item", "record_implementation"]) {
		test(`${name}: ${wrapperName} success uses the exact returned identity rather than the original`, () => {
			const event = completed(name, wrap({ outcome: "committed", id: RETURNED, superseded: SOURCE, body: PRIVATE }));
			assert.equal(event.status, "ok");
			assert.equal(event.id, RETURNED);
			assert.notEqual(event.action, "not applied");
		});
	}
}

for (const name of ["supersede_memory", "supersede_resource", "record_memory", "create_resource", "create_action_item"]) {
	test(`${name}: a missing new identity does not reuse an input ID at toolEnd`, () => {
		for (const result of [undefined, {}, { outcome: "committed" }, { id: "invalid" }]) {
			assert.equal(completed(name, result).id, undefined);
		}
	});
}

test("same-record mutations may retain an exact safe argument ID when the receipt omits it", () => {
	for (const name of ["update_resource", "retract_memory", "archive_resource", "update_action_item", "claim_work_item"]) {
		assert.equal(completed(name, { outcome: "committed" }).id, SOURCE);
	}
});

test("returned nested entities and implementation action-item wrappers preserve exact identity", () => {
	for (const [name, result] of [
		["record_memory", { memory: { id: RETURNED } }],
		["supersede_memory", { item: { memory: { id: RETURNED } } }],
		["update_resource", { resource: { id: RETURNED } }],
		["record_implementation", { item: { action_item: { id: RETURNED } } }],
	] as const) assert.equal(completed(name, { details: result }).id, RETURNED);
});

test("explicit failed receipts clear an identity even if the transport reports success", () => {
	for (const result of [
		{ isError: true, id: RETURNED },
		{ isError: true, details: { outcome: "committed", id: RETURNED } },
		{ details: { success: false, id: RETURNED } },
		{ details: { ok: false, id: RETURNED } },
		{ outcome: "failed", id: RETURNED },
		{ outcome: "error", id: RETURNED },
	]) {
		const event = completed("supersede_memory", result);
		assert.equal(event.status, "error");
		assert.equal(event.action, "failed");
		assert.equal(event.id, undefined);
	}
});

for (const name of ["update_resource", "retract_memory", "archive_resource", "update_action_item", "claim_work_item", "record_implementation"]) {
	test(`${name}: native adapter errors fail without linking the source or exposing private error text`, () => {
		const result = toolErrorResult(PRIVATE);
		assert.equal(writeOutcomeFromResult(result), "failed");
		assert.equal(domainIdentity(name, { id: SOURCE }, result).id, undefined);
		// executeVerb returns this normally, so the host can report transport success.
		// completed also checks private-text exclusion in both typed and markdown trails.
		const event = completed(name, result, true);
		assert.equal(event.status, "error");
		assert.equal(event.action, "failed");
		assert.equal(event.id, undefined);
		assert.equal(event.result, "outcome=failed");
	});
}

test("native error classification uses the structured string marker, not message truthiness", () => {
	assert.equal(writeOutcomeFromResult(toolErrorResult("")), "failed");
	assert.equal(completed("update_resource", { outcome: "committed", id: RETURNED, error: null }).id, RETURNED);
});

test("transport failure overrides an apparent successful receipt", () => {
	const event = completed("supersede_resource", { outcome: "committed", id: RETURNED }, false);
	assert.equal(event.status, "error");
	assert.equal(event.action, "failed");
	assert.equal(event.id, undefined);
});

test("unknown dispositions are not projected verbatim or treated as applied writes", () => {
	const event = completed("supersede_memory", { outcome: PRIVATE, id: RETURNED });
	assert.equal(event.action, "not applied");
	assert.equal(event.id, undefined);
});

test("only structured fields establish a non-applied outcome, never free-text heuristics", () => {
	assert.equal(writeOutcomeFromResult({ content: [{ type: "text", text: "superseded:false reconcile_required:true" }] }), undefined);
	assert.equal(writeOutcomeFromResult({ title: "not applied", note: "failed" }), undefined);
	assert.equal(writeOutcomeFromResult({ outcome: "committed", superseded: false }), "not_applied");
});
