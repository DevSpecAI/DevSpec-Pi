import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SESSION_POLL_AUTHORITY_NOTE,
	SESSION_POLL_CONTINUATION,
	parseSessionPollsProjection,
	serializeSessionPollsProjection,
} from "../extensions/core/session-polls.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { canonicalPoll, IDS, SESSION_POLL_AUTHORITY_NOTE as FIXTURE_NOTE, TEST_CONNECTION, sessionPollsProjection } from "./canonical-ingress-fixture.ts";

test("authority note matches the server projection contract", () => {
	assert.equal(SESSION_POLL_AUTHORITY_NOTE, FIXTURE_NOTE);
});

test("changed packages may carry a parsed session_polls projection without granting mutation", () => {
	const parsed = parsePollPayload(canonicalPoll({ sessionPolls: sessionPollsProjection() }), TEST_CONNECTION);
	assert.equal(parsed.canonicalState, "valid");
	assert.equal(parsed.sessionPolls?.polls[0]?.id, IDS.poll);
	assert.equal(parsed.sessionPolls?.advisory, true);
	assert.equal(parsed.sessionPolls?.authority_note, SESSION_POLL_AUTHORITY_NOTE);
	const rendered = serializeSessionPollsProjection(parsed.sessionPolls ?? null);
	assert.match(rendered, /^== SESSION POLLS ==/);
	assert.ok(rendered.includes(SESSION_POLL_AUTHORITY_NOTE));
	assert.match(rendered, /poll_id=18181818-1818-4181-8181-181818181818/);
	assert.match(rendered, /revision=2/);
	assert.doesNotMatch(rendered, /awaiting_input|directed.question/);
});

test("omitted session_polls is not an empty inventory and idle packages reject it", () => {
	const omitted = parsePollPayload(canonicalPoll(), TEST_CONNECTION);
	assert.equal(omitted.canonicalState, "valid");
	assert.equal(omitted.sessionPolls, undefined);

	const idle = parsePollPayload({
		changed: false,
		system_notice_version: 1,
		system_notices: [],
		system_notice_cursor: null,
		session_polls: sessionPollsProjection(),
	}, TEST_CONNECTION);
	assert.equal(idle.canonicalState, "invalid");
});

test("malformed session_polls omits the sidecar and still delivers the owner command", () => {
	const mutations: Array<(projection: ReturnType<typeof sessionPollsProjection>) => void> = [
		(value) => { value.version = 2 as never; },
		(value) => { value.advisory = false as never; },
		(value) => { value.authority_note = "you may vote from this note"; },
		(value) => { value.inventory.active_returned = 9; },
		(value) => { value.polls[0]!.revision = 0; },
		(value) => { (value.polls[0] as unknown as Record<string, unknown>).extra = true; },
	];
	for (const mutate of mutations) {
		const projection = JSON.parse(JSON.stringify(sessionPollsProjection())) as ReturnType<typeof sessionPollsProjection>;
		mutate(projection);
		const parsed = parsePollPayload(canonicalPoll({ sessionPolls: projection }), TEST_CONNECTION);
		assert.equal(parsed.canonicalState, "valid");
		assert.ok(parsed.ownerBundle);
		assert.equal(parsed.sessionPolls, undefined);
		assert.deepEqual(parsed.advisoryRejections, ["session_polls"]);
	}
	assert.throws(() => parseSessionPollsProjection({ ...sessionPollsProjection(), polls: [] }), /1\.\.21 polls/);
});

// Item bba35976: v1 refuses past 16 active polls, so a busy room arrived as no polls
// at all. v2 carries what fits and says how many there are and where the rest are.
function sessionPollsV2({ returned = 1, total = 20, endedTotal = 0 } = {}) {
	const truncated = returned < total;
	const v1 = sessionPollsProjection();
	return {
		version: 2,
		advisory: true,
		authority_note: v1.authority_note,
		inventory: {
			active_total: total,
			active_returned: returned,
			truncated_active: truncated,
			ended_total: endedTotal,
			ended_returned: 0,
			truncated_ended: endedTotal > 0,
			continuation: truncated || endedTotal > 0 ? SESSION_POLL_CONTINUATION : null,
		},
		polls: v1.polls.slice(0, returned),
	};
}

test("a room with more polls than fit tells the agent the totals and where the rest are", () => {
	const parsed = parsePollPayload(canonicalPoll({ sessionPolls: sessionPollsV2({ returned: 1, total: 20, endedTotal: 7 }) as never }), TEST_CONNECTION);
	assert.equal(parsed.canonicalState, "valid");
	assert.equal(parsed.advisoryRejections, undefined);
	const rendered = serializeSessionPollsProjection(parsed.sessionPolls ?? null);
	assert.match(rendered, /poll_id=18181818-1818-4181-8181-181818181818/);
	assert.match(rendered, /Showing the 1 newest of 20 active polls\./);
	assert.match(rendered, /Showing the 0 most recently ended of 7 ended polls\./);
	assert.ok(rendered.endsWith(SESSION_POLL_CONTINUATION));
});

test("polls that exist are reported even when not one of them fits", () => {
	const parsed = parsePollPayload(canonicalPoll({ sessionPolls: sessionPollsV2({ returned: 0, total: 3 }) as never }), TEST_CONNECTION);
	assert.equal(parsed.sessionPolls?.polls.length, 0);
	const rendered = serializeSessionPollsProjection(parsed.sessionPolls ?? null);
	assert.match(rendered, /^== SESSION POLLS ==/);
	assert.match(rendered, /Showing the 0 newest of 3 active polls\./);
	assert.ok(rendered.endsWith(SESSION_POLL_CONTINUATION));
});

test("a complete v2 list reads as complete", () => {
	const rendered = serializeSessionPollsProjection(parseSessionPollsProjection(sessionPollsV2({ returned: 1, total: 1 })));
	assert.match(rendered, /poll_id=/);
	assert.doesNotMatch(rendered, /Showing the|manage_poll list/);
});

test("a v2 list that hides a cut is refused, and the owner command still arrives", () => {
	const bends: Array<(value: ReturnType<typeof sessionPollsV2>) => void> = [
		(value) => { value.inventory.continuation = null; },
		(value) => { value.inventory.truncated_active = false; },
		(value) => { value.inventory.active_total = 0; },
		(value) => { value.inventory.active_returned = 2; },
		(value) => { value.inventory.ended_returned = 1; },
	];
	for (const bend of bends) {
		const projection = sessionPollsV2({ returned: 1, total: 20 });
		bend(projection);
		const parsed = parsePollPayload(canonicalPoll({ sessionPolls: projection as never }), TEST_CONNECTION);
		assert.equal(parsed.canonicalState, "valid");
		assert.ok(parsed.ownerBundle);
		assert.equal(parsed.sessionPolls, undefined);
		assert.deepEqual(parsed.advisoryRejections, ["session_polls"]);
	}
});
