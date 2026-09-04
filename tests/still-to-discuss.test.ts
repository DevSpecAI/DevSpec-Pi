import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import {
	STILL_TO_DISCUSS_AUTHORITY_NOTE,
	serializeStillToDiscussProjection,
} from "../extensions/core/still-to-discuss.ts";
import { canonicalPoll, stillToDiscussProjection, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";

test("changed poll packages accept this-session Still to Discuss", () => {
	const parsed = parsePollPayload(canonicalPoll({ stillToDiscuss: stillToDiscussProjection() }), TEST_CONNECTION);
	assert.equal(parsed.stillToDiscuss?.rows[0]?.title, "Investigate remaining CI unit-test failures");
	assert.equal(parsed.stillToDiscuss?.advisory, true);
	assert.equal(parsed.stillToDiscuss?.authority_note, STILL_TO_DISCUSS_AUTHORITY_NOTE);
	const rendered = serializeStillToDiscussProjection(parsed.stillToDiscuss ?? null);
	assert.match(rendered, /== STILL TO DISCUSS ==/);
	assert.match(rendered, /Investigate remaining CI unit-test failures/);
	assert.doesNotMatch(rendered, /maintain the list/i);
});

test("empty Still to Discuss serializes to no tail", () => {
	const rendered = serializeStillToDiscussProjection(stillToDiscussProjection({ empty: true }));
	assert.equal(rendered, "");
});

test("omitted still_to_discuss is not an empty inventory and idle packages reject it", () => {
	const omitted = parsePollPayload(canonicalPoll(), TEST_CONNECTION);
	assert.equal(omitted.canonicalState, "valid");
	assert.equal(omitted.stillToDiscuss, undefined);

	const idle = parsePollPayload({
		changed: false,
		system_notice_version: 1,
		system_notices: [],
		system_notice_cursor: null,
		still_to_discuss: stillToDiscussProjection(),
	}, TEST_CONNECTION);
	assert.equal(idle.canonicalState, "invalid");
});

test("a 161-character ellipsis preview still delivers the owner command", () => {
	const preview = `${"x".repeat(160)}…`;
	assert.equal(preview.length, 161);
	const parsed = parsePollPayload(canonicalPoll({
		stillToDiscuss: {
			...stillToDiscussProjection(),
			rows: [{
				id: "20752a57-9169-4a89-b5ce-b824c174deed",
				title: "Separate automation triggers from participation and harness selection",
				state: "discussed",
				preview,
			}],
		},
	}), TEST_CONNECTION);
	assert.equal(parsed.canonicalState, "valid");
	assert.ok(parsed.ownerBundle);
	assert.equal(parsed.stillToDiscuss?.rows[0]?.preview, preview);
});

test("a malformed Still to Discuss sidecar does not deafen the owner command", () => {
	const payload = canonicalPoll({ stillToDiscuss: stillToDiscussProjection() }) as {
		still_to_discuss: Record<string, unknown>;
	};
	payload.still_to_discuss.extra = true;
	const parsed = parsePollPayload(payload, TEST_CONNECTION);
	assert.equal(parsed.canonicalState, "valid");
	assert.ok(parsed.ownerBundle);
	assert.equal(parsed.stillToDiscuss, undefined);
});
