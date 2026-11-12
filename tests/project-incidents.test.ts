import assert from "node:assert/strict";
import { test } from "node:test";
import {
	PROJECT_INCIDENTS_AUTHORITY_NOTE,
	parseProjectIncidentsProjection,
	serializeProjectIncidentsProjection,
} from "../extensions/core/project-incidents.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { buildDevspecInstructions } from "../extensions/core/instructions.ts";
import { buildBondedInstructions } from "../extensions/devspec-context.ts";
import { setBond } from "../extensions/core/bond-state.ts";
import { canonicalPoll, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";

function validProjectIncidents() {
	return {
		version: 1 as const,
		authority: "advisory_read_awareness" as const,
		recent_resolved_window_minutes: 60,
		active: [
			{
				id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				short_code: "aaaaaaaa",
				kind: "checks_failing" as const,
				kind_label: "Checks failing",
				title: "Typecheck broken on staging",
				summary: "tsc failing in packages/core",
				state: "handled" as const,
				since: "2026-11-12T01:00:00.000Z",
				last_seen_at: "2026-11-12T01:05:00.000Z",
				status_line: "Handled by Pi · Gentle Otter",
				handler: {
					kind: "agent_connection" as const,
					label: "Pi · Gentle Otter",
					user_id: null,
					connection_id: TEST_CONNECTION.connection_id,
					run_id: null,
					expires_at: null,
				},
				decision_prompt: null,
				blocked_pull_request_count: 2,
				blocked_task_count: 1,
			},
		],
		recently_resolved: [
			{
				id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				short_code: "bbbbbbbb",
				kind: "deploy_failed" as const,
				kind_label: "Deployment failed",
				title: "Vercel preview build timeout",
				state: "cleared" as const,
				resolved_at: "2026-11-12T00:30:00.000Z",
				resolution_kind: "signal_cleared",
				resolution_summary: "Preview deployment green again",
			},
		],
		truncated: { active_omitted: 0, resolved_omitted: 0 },
		note: "Server explanatory note.",
	};
}

test("changed packages parse project_incidents passively and normalize the authority note", () => {
	const raw = { ...canonicalPoll(), project_incidents: validProjectIncidents() };
	const parsed = parsePollPayload(raw, TEST_CONNECTION);
	assert.equal(parsed.canonicalState, "valid");
	assert.equal(parsed.projectIncidents?.note, PROJECT_INCIDENTS_AUTHORITY_NOTE);
	const rendered = serializeProjectIncidentsProjection(parsed.projectIncidents);
	assert.match(rendered, /== PROJECT INCIDENTS ==/);
	assert.match(rendered, /\[ACTIVE aaaaaaaa\] Checks failing: "Typecheck broken on staging"/);
	assert.match(rendered, /blocked_prs=2 \| blocked_tasks=1/);
	assert.match(rendered, /\[RESOLVED bbbbbbbb\] Deployment failed: "Vercel preview build timeout"/);
});

test("omitted project_incidents renders zero footprint and idle packages reject it", () => {
	const omitted = parsePollPayload(canonicalPoll(), TEST_CONNECTION);
	assert.equal(omitted.projectIncidents, null);
	assert.equal(serializeProjectIncidentsProjection(omitted.projectIncidents), "");

	const idle = {
		changed: false,
		cursor_v2: "v2:1",
		system_notice_version: 1,
		system_notices: [],
		project_incidents: validProjectIncidents(),
	};
	assert.equal(parsePollPayload(idle, TEST_CONNECTION).canonicalState, "invalid");
});

test("malformed project_incidents omits the sidecar without dropping canonical commands", () => {
	const bad = {
		...canonicalPoll(),
		project_incidents: { ...validProjectIncidents(), active: [], recently_resolved: [] },
	};
	const parsed = parsePollPayload(bad, TEST_CONNECTION);
	assert.equal(parsed.canonicalState, "valid");
	assert.ok(parsed.ownerBundle);
	assert.equal(parsed.projectIncidents, undefined);
	assert.deepEqual(parsed.advisoryRejections, ["project_incidents"]);
	assert.throws(
		() => parseProjectIncidentsProjection({ ...validProjectIncidents(), active: [], recently_resolved: [] }),
		/empty projection/,
	);
});

test("workflow and bonded instructions point at served incident contracts without restating them", () => {
	assert.match(buildDevspecInstructions(), /core\.respect-incidents-and-escalate-delivery-blockers/);
	setBond({
		connectionId: TEST_CONNECTION.connection_id,
		codename: TEST_CONNECTION.codename,
		localId: "local-1",
		projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
	});
	try {
		const bonded = buildBondedInstructions()!;
		assert.match(bonded, /semantics\.project_incidents/);
		assert.match(bonded, /core\.respect-incidents-and-escalate-delivery-blockers/);
	} finally {
		setBond(null);
	}
});
