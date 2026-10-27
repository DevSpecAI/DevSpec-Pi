import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	noteDeliveredCommandRefs,
	noteObservedClaimRef,
	observeResultClaimRefs,
	clearDealtRefs,
	guardWriteRefs,
} from "../extensions/core/provenance-refs.ts";

const DELIVERED = "5733cc70-9ca8-4bb5-8261-2493b069941b";
const PRIMARY = "5733cc70-9ca8-4bb5-8261-aaaaaaaaaaaa";
const CLAIM = "330389f6-839d-48a3-9edb-54ec3f55b22d";
// The actual corruption from session 340ca456, 2026-09-20: same 64-bit prefix,
// fabricated tail — what a model produces when it retypes a UUID.
const FABRICATED = "5733cc70-9ca8-4f6d-9f10-f1c0dae08992";

const command = (ref: string, primary: string, turnId = "b7045ae2-0000-4000-8000-000000000000") => ({
	delivery: { provenance_ref: ref, primary_provenance_ref: primary, turn_id: turnId, is_primary: ref === primary },
});

test("omission is always allowed — it is the default", () => {
	clearDealtRefs();
	assert.equal(guardWriteRefs({}).ok, true);
	assert.equal(guardWriteRefs({ provenance_ref: undefined }).ok, true);
	assert.equal(guardWriteRefs({ provenance_ref: "" }).ok, true);
	assert.equal(guardWriteRefs({ provenance_ref: "   " }).ok, true);
});

test("a delivered ref passes, case- and whitespace-insensitively", () => {
	clearDealtRefs();
	noteDeliveredCommandRefs([command(DELIVERED, PRIMARY)]);
	assert.equal(guardWriteRefs({ provenance_ref: DELIVERED }).ok, true);
	assert.equal(guardWriteRefs({ provenance_ref: PRIMARY }).ok, true);
	assert.equal(guardWriteRefs({ provenance_ref: ` ${DELIVERED.toUpperCase()} ` }).ok, true);
});

test("the incident replay: a fabricated same-prefix tail is refused locally with the valid refs and the omission guidance", () => {
	clearDealtRefs();
	noteDeliveredCommandRefs([command(DELIVERED, PRIMARY)]);
	const verdict = guardWriteRefs({ provenance_ref: FABRICATED });
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.match(verdict.message, /never delivered to this process/);
	assert.match(verdict.message, new RegExp(DELIVERED));
	assert.match(verdict.message, /omit the parameter/);
});

test("a malformed value is refused the same way — it was never delivered either", () => {
	clearDealtRefs();
	noteDeliveredCommandRefs([command(DELIVERED, PRIMARY)]);
	assert.equal(guardWriteRefs({ provenance_ref: "not-a-uuid" }).ok, false);
});

test("a supplied ref with nothing delivered is refused with the no-deliveries guidance", () => {
	clearDealtRefs();
	const verdict = guardWriteRefs({ provenance_ref: DELIVERED });
	assert.equal(verdict.ok, false);
	if (verdict.ok) return;
	assert.match(verdict.message, /No command has been delivered to this process/);
	assert.match(verdict.message, /Omit the parameter/);
});

test("claim refs are dealt through results, not deliveries", () => {
	clearDealtRefs();
	assert.equal(guardWriteRefs({ work_claim_ref: CLAIM }).ok, false, "unseen claim ref refused");
	noteObservedClaimRef(CLAIM);
	assert.equal(guardWriteRefs({ work_claim_ref: CLAIM }).ok, true);
});

test("observeResultClaimRefs reads details.work_claim_ref and the top level", () => {
	clearDealtRefs();
	observeResultClaimRefs({ details: { work_claim_ref: CLAIM } });
	assert.equal(guardWriteRefs({ work_claim_ref: CLAIM }).ok, true);
	clearDealtRefs();
	observeResultClaimRefs({ work_claim_ref: CLAIM });
	assert.equal(guardWriteRefs({ work_claim_ref: CLAIM }).ok, true);
	observeResultClaimRefs(null);
	observeResultClaimRefs({ details: { work_claim_ref: "junk" } });
	assert.equal(guardWriteRefs({ work_claim_ref: "junk" }).ok, false);
});

test("dealt refs survive turn closes but not bond resets", () => {
	clearDealtRefs();
	noteDeliveredCommandRefs([command(DELIVERED, PRIMARY)]);
	// A turn closing does NOT un-deal its refs — the server owns liveness; this
	// guard only knows never-dealt.
	assert.equal(guardWriteRefs({ provenance_ref: DELIVERED }).ok, true);
	clearDealtRefs();
	assert.equal(guardWriteRefs({ provenance_ref: DELIVERED }).ok, false);
});

test("refs are recorded per turn and the guidance names the latest turn's refs", () => {
	clearDealtRefs();
	noteDeliveredCommandRefs([command("11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111", "00000000-0000-4000-8000-000000000001")]);
	noteDeliveredCommandRefs([command(DELIVERED, PRIMARY, "00000000-0000-4000-8000-000000000002")]);
	const verdict = guardWriteRefs({ provenance_ref: FABRICATED });
	if (verdict.ok) throw new Error("expected refusal");
	assert.match(verdict.message, new RegExp(DELIVERED));
	assert.doesNotMatch(verdict.message, /11111111-1111-4111-8111-111111111111/, "older turns' refs are not offered as suggestions");
	assert.equal(guardWriteRefs({ provenance_ref: "11111111-1111-4111-8111-111111111111" }).ok, true, "an older dealt ref still passes — liveness is the server's call");
});

test("wiring: the guard stands before the network, refs are noted at delivery acceptance, and the delivery text teaches omission", () => {
	const tools = readFileSync(new URL("../extensions/devspec-tools.ts", import.meta.url), "utf8");
	// executeVerb is the single choke point for every catalog tool call: the
	// guard runs before resolveToken — no server round-trip with a fabricated id.
	const verb = tools.slice(tools.indexOf("async function executeVerb"));
	assert.ok(verb.indexOf("guardWriteRefs(params)") < verb.indexOf("resolveToken()"));
	assert.match(tools, /observeResultClaimRefs\(result\)/);

	const remote = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
	// Both acceptance boundaries (owner bundle and rejected bundle) note the refs.
	assert.equal(remote.match(/noteDeliveredCommandRefs\(unseen\)/g)?.length, 2);
	// Bond/connection resets clear the dealt set with the turn bindings.
	assert.ok((remote.match(/clearDealtRefs\(\);/g)?.length ?? 0) >= 4);

	const payload = readFileSync(new URL("../extensions/core/remote-payload.ts", import.meta.url), "utf8");
	assert.match(payload, /Omit provenance_ref unless you are certain — the active turn is the default write attribution/);
});
