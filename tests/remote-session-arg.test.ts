import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	bondedRemoteAction,
	namedSessionFromRemoteArg,
} from "../extensions/core/remote-session-arg.ts";

const ROOM = "b5401606-1111-4222-8222-aaaaaaaaaaaa";
const SHORT = "b5401606";

test("names a room from --session and -s, including the resume-command payload", () => {
	assert.equal(namedSessionFromRemoteArg(`--session ${ROOM}`), ROOM);
	assert.equal(namedSessionFromRemoteArg(`-s ${ROOM}`), ROOM);
	assert.equal(namedSessionFromRemoteArg(`  --session ${SHORT}  `), SHORT);

	// DevSpec resume: pi --session <chat> "/devspec.remote --session <room>"
	// Pi slash-command args are everything after the command name.
	const resumePrompt = `/devspec.remote --session ${ROOM}`;
	const args = resumePrompt.replace(/^\/devspec\.remote\s+/, "");
	assert.equal(args, `--session ${ROOM}`);
	assert.deepEqual(bondedRemoteAction(args), { type: "attach", sessionId: ROOM });
});

test("a bare or unrelated remote arg while bonded is not an attach", () => {
	assert.equal(namedSessionFromRemoteArg(""), undefined);
	assert.equal(namedSessionFromRemoteArg("stop"), undefined);
	assert.equal(namedSessionFromRemoteArg("auto on"), undefined);
	assert.deepEqual(bondedRemoteAction(""), { type: "report_already_bonded" });
	assert.deepEqual(bondedRemoteAction("stop"), { type: "report_already_bonded" });
});

test("bonded --session path calls attach_connection and does not write bond/tool state", () => {
	const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
	const start = source.indexOf("const sessionId = namedSessionFromRemoteArg(arg);");
	const end = source.indexOf("const outcome = await bondNow(ctx, sessionId);");
	assert.ok(start >= 0 && end > start, "bonded-session handler block missing");
	const bonded = source.slice(start, end);
	assert.match(bonded, /bondedRemoteAction\(arg\)/);
	assert.match(bonded, /"attach_connection"/);
	assert.match(bonded, /session_id: action\.sessionId/);
	assert.match(bonded, /already bonded as/);
	assert.doesNotMatch(bonded, /bond\.sessionId\s*=/);
	assert.doesNotMatch(bonded, /pi_setPlanToolActive|pi_setQuestionToolActive|pi_setPollToolActive/);
	assert.doesNotMatch(bonded, /setBond\(/);
});
