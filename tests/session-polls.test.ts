import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SESSION_POLL_AUTHORITY_NOTE,
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

test("malformed session_polls fails the package atomically", () => {
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
		assert.equal(parsed.canonicalState, "invalid");
		assert.equal(parsed.ownerBundle, undefined);
	}
	assert.throws(() => parseSessionPollsProjection({ ...sessionPollsProjection(), polls: [] }), /1\.\.21 polls/);
});
