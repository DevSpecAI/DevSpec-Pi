import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_TERMINAL_TITLE,
	clearPlaybook,
	clearWork,
	extractItemRef,
	extractPlaybookRef,
	firstTextPreview,
	formatStatusLine,
	formatTerminalTitle,
	getStatusSnapshot,
	isDevspecVerb,
	isRealSessionTitle,
	notePlaybook,
	noteVerbEnd,
	noteVerbStart,
	noteWork,
	patchStatus,
	previewFromText,
	resetStatus,
	resolveExecutingVerb,
	setSessionPreview,
	syncBondIntoStatus,
	truncateLabel,
	verbLabel,
} from "../extensions/core/status-line.ts";

test("real titles exclude empty and the literal New session placeholder", () => {
	assert.equal(isRealSessionTitle("Pi TUI footer"), true);
	assert.equal(isRealSessionTitle("  New session  "), false);
	assert.equal(isRealSessionTitle("New session"), false);
	assert.equal(isRealSessionTitle(""), false);
	assert.equal(isRealSessionTitle(null), false);
	assert.equal(isRealSessionTitle("  "), false);
});

test("sessionless bond is just the codename", () => {
	assert.equal(formatStatusLine({ codename: "Golden Possum" }), "⛁ Golden Possum");
	assert.equal(formatStatusLine({}), undefined);
});

test("titled session sits next to the codename", () => {
	assert.equal(
		formatStatusLine({
			codename: "Golden Possum",
			sessionId: "d8883a49-5e1f-416f-8384-7fd65e2e016b",
			sessionTitle: "Pi TUI footer",
		}),
		"⛁ Golden Possum · “Pi TUI footer”",
	);
});

test("untitled session uses an honest stand-in, never a leftover or blank", () => {
	assert.equal(
		formatStatusLine({
			codename: "Golden Possum",
			sessionId: "sess-1",
		}),
		"⛁ Golden Possum · untitled",
	);
	assert.equal(
		formatStatusLine({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionTitle: "New session",
			sessionPreview: "first owner message",
		}),
		"⛁ Golden Possum · untitled “first owner message”",
	);
	assert.equal(
		formatStatusLine({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionTitle: "New session",
		}),
		"⛁ Golden Possum · untitled",
	);
});

test("real title wins over a leftover first-text preview", () => {
	assert.equal(
		formatStatusLine({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionTitle: "Generated title",
			sessionPreview: "first message that should disappear",
		}),
		"⛁ Golden Possum · “Generated title”",
	);
});

test("claimed work and a live DevSpec verb append; bash does not", () => {
	assert.equal(
		formatStatusLine({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionTitle: "Room",
			workTitle: "Show the session title",
			verb: "claim_work_item",
		}),
		"⛁ Golden Possum · “Room” · “Show the session title” · claiming",
	);
	assert.equal(isDevspecVerb("claim_work_item"), true);
	assert.equal(isDevspecVerb("devspec"), true);
	assert.equal(isDevspecVerb("bash"), false);
	assert.equal(isDevspecVerb("read"), false);
	assert.equal(isDevspecVerb("edit"), false);
	assert.equal(resolveExecutingVerb("bash", { command: "ls" }), undefined);
	assert.equal(resolveExecutingVerb("claim_work_item", { action_item_id: "x" }), "claim_work_item");
	assert.equal(resolveExecutingVerb("devspec", { verb: "release_work_item" }), "release_work_item");
	assert.equal(verbLabel("record_implementation"), "recording");
});

test("first-text preview skips presence markers and empty / non-human rows", () => {
	assert.equal(
		firstTextPreview([
			{ message_type: "remote_control_started", content: "joined", author: { kind: "system" } },
			{ author: { kind: "human" }, content: "   " },
			{ author: { kind: "external_agent" }, content: "an answer" },
			{ author: { kind: "human" }, content: "first owner message" },
		]),
		"first owner message",
	);
	assert.equal(previewFromText("look at this"), "look at this");
	assert.equal(truncateLabel("abcdefghijklmnopqrstuvwxyz012345", 10), "abcdefghi…");
});

test("extractItemRef reads claim / nested item payloads", () => {
	assert.deepEqual(extractItemRef({ id: "abc", title: "Footer" }), { id: "abc", title: "Footer" });
	assert.deepEqual(
		extractItemRef({ item: { id: "abc", title: "Footer" }, claim_success: true }),
		{ id: "abc", title: "Footer" },
	);
	assert.deepEqual(extractItemRef({ action_item_id: "abc", action_item: { title: "Footer" } }), {
		id: "abc",
		title: "Footer",
	});
	assert.deepEqual(
		extractItemRef({ details: { id: "abc", title: "Footer", claim_success: true } }),
		{ id: "abc", title: "Footer" },
	);
});

test("status store: session change drops the old preview; a real title replaces the stand-in", () => {
	resetStatus();
	syncBondIntoStatus({
		codename: "Golden Possum",
		sessionId: "sess-old",
		sessionTitle: "Old room",
	});
	setSessionPreview("should not stick after retitle");
	assert.equal(getStatusSnapshot().sessionPreview, undefined, "real title refuses a preview write");

	syncBondIntoStatus({
		codename: "Golden Possum",
		sessionId: "sess-new",
	});
	assert.equal(getStatusSnapshot().sessionTitle, undefined);
	assert.equal(getStatusSnapshot().sessionPreview, undefined);
	setSessionPreview("first owner message");
	assert.equal(getStatusSnapshot().sessionPreview, "first owner message");
	assert.equal(
		formatStatusLine(getStatusSnapshot()),
		"⛁ Golden Possum · untitled “first owner message”",
	);

	syncBondIntoStatus({
		codename: "Golden Possum",
		sessionId: "sess-new",
		sessionTitle: "Generated later",
	});
	assert.equal(getStatusSnapshot().sessionPreview, undefined);
	assert.equal(formatStatusLine(getStatusSnapshot()), "⛁ Golden Possum · “Generated later”");
	resetStatus();
});

test("live verbs stack and pop; non-DevSpec tools never enter the slot", () => {
	resetStatus();
	patchStatus({ codename: "Golden Possum" });
	noteVerbStart("1", "bash", { command: "ls" });
	assert.equal(getStatusSnapshot().verb, undefined);
	noteVerbStart("2", "claim_work_item", { action_item_id: "x" });
	assert.equal(getStatusSnapshot().verb, "claim_work_item");
	noteVerbStart("3", "devspec", { verb: "search_memories" });
	assert.equal(getStatusSnapshot().verb, "search_memories");
	noteVerbEnd("3");
	assert.equal(getStatusSnapshot().verb, "claim_work_item");
	noteVerbEnd("2");
	assert.equal(getStatusSnapshot().verb, undefined);
	resetStatus();
});

test("claimed work is shown and cleared for that item only", () => {
	resetStatus();
	patchStatus({ codename: "Golden Possum" });
	noteWork({ id: "item-1", title: "Do the thing" });
	assert.equal(formatStatusLine(getStatusSnapshot()), "⛁ Golden Possum · “Do the thing”");
	clearWork("item-other");
	assert.equal(getStatusSnapshot().workTitle, "Do the thing");
	clearWork("item-1");
	assert.equal(getStatusSnapshot().workTitle, undefined);
	resetStatus();
});

test("extractPlaybookRef reads claim_playbook_run and record payloads", () => {
	assert.deepEqual(
		extractPlaybookRef({
			claimed: true,
			run: { run_id: "run-1", playbook_id: "pb-1", playbook_name: "Pull plugin repos" },
			playbook: { id: "pb-1", name: "Pull plugin repos" },
		}),
		{ id: "pb-1", runId: "run-1", name: "Pull plugin repos" },
	);
	assert.deepEqual(
		extractPlaybookRef({
			details: {
				recorded: true,
				run: { run_id: "run-1", playbook_id: "pb-1", playbook_name: "Pull plugin repos" },
			},
		}),
		{ id: "pb-1", runId: "run-1", name: "Pull plugin repos" },
	);
});

test("claimed playbook sits in the footer and is distinct from an action item", () => {
	assert.equal(
		formatStatusLine({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionTitle: "Room",
			playbookName: "Pull plugin repos",
			workTitle: "Fix the build",
		}),
		"⛁ Golden Possum · “Room” · playbook “Pull plugin repos” · “Fix the build”",
	);
});

test("claimed playbook is shown and cleared for that run only", () => {
	resetStatus();
	patchStatus({ codename: "Golden Possum" });
	notePlaybook({ id: "pb-1", runId: "run-1", name: "Pull plugin repos" });
	assert.equal(formatStatusLine(getStatusSnapshot()), "⛁ Golden Possum · playbook “Pull plugin repos”");
	clearPlaybook("run-other");
	assert.equal(getStatusSnapshot().playbookName, "Pull plugin repos");
	clearPlaybook("run-1");
	assert.equal(getStatusSnapshot().playbookName, undefined);
	resetStatus();
});

test("terminal title prefers session, then playbook, then untitled stand-in, then item, then codename", () => {
	assert.equal(formatTerminalTitle(undefined), DEFAULT_TERMINAL_TITLE);
	assert.equal(formatTerminalTitle({}), DEFAULT_TERMINAL_TITLE);
	assert.equal(
		formatTerminalTitle({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionTitle: "Pi TUI footer",
			playbookName: "Pull plugin repos",
			workTitle: "Fix the build",
		}),
		"Pi TUI footer",
	);
	assert.equal(
		formatTerminalTitle({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionTitle: "New session",
			playbookName: "Pull plugin repos",
			workTitle: "Fix the build",
			sessionPreview: "first owner message",
		}),
		"Pull plugin repos",
	);
	assert.equal(
		formatTerminalTitle({
			codename: "Golden Possum",
			sessionId: "sess-1",
			sessionPreview: "first owner message",
			workTitle: "Fix the build",
		}),
		"first owner message",
	);
	assert.equal(
		formatTerminalTitle({
			codename: "Golden Possum",
			workTitle: "Fix the build",
		}),
		"Fix the build",
	);
	assert.equal(formatTerminalTitle({ workTitle: "Fix the build" }), "Fix the build");
	assert.equal(formatTerminalTitle({ codename: "Golden Possum", sessionId: "sess-1" }), "Golden Possum");
	assert.equal(formatTerminalTitle({ codename: "Golden Possum" }), "Golden Possum");
	assert.equal(formatTerminalTitle({ playbookName: "Pull plugin repos" }), "Pull plugin repos");
});

test("a batch retitles on each claim and falls back when that item is recorded", () => {
	resetStatus();
	patchStatus({ codename: "Golden Possum" });
	noteWork({ id: "item-1", title: "Fix the flaky test" });
	assert.equal(formatTerminalTitle(getStatusSnapshot()), "Fix the flaky test");
	clearWork("item-1");
	assert.equal(formatTerminalTitle(getStatusSnapshot()), "Golden Possum");
	noteWork({ id: "item-2", title: "Ship the footer" });
	assert.equal(formatTerminalTitle(getStatusSnapshot()), "Ship the footer");
	resetStatus();
	assert.equal(formatTerminalTitle(getStatusSnapshot()), DEFAULT_TERMINAL_TITLE);
});
