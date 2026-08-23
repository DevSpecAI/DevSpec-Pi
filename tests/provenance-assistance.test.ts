import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import provenanceExtension, { unclaimedEditNudge } from "../extensions/devspec-provenance-assistance.ts";
import { resolveProjectPin } from "../extensions/core/project-scope.ts";
import {
	hasObservedClaim,
	observeSuccessfulWorkResult,
	resetWorkStateForTests,
} from "../extensions/core/work-state.ts";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const ITEM = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function runtime(sessionId = "session-a", cwd = process.cwd()) {
	return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

function successfulClaim(id = ITEM) {
	return { details: { claim_success: true, action_item: { id } } };
}

test("only reliable first-class edit events can emit the one advisory nudge", async () => {
	resetWorkStateForTests();
	const resolvePin = async () => PROJECT;
	for (const tool of ["bash", "shell", "subagent", "future_tool", "read"]) {
		assert.equal(await unclaimedEditNudge(tool, runtime(), resolvePin), null, tool);
	}
	const first = await unclaimedEditNudge("edit", runtime(), resolvePin);
	assert.ok(first);
	assert.equal(first.customType, "devspec-provenance-nudge");
	assert.equal(first.display, true, "custom message stays visible as well as model-visible");
	assert.match(first.content, /Continue this edit—editing is never blocked/);
	assert.match(first.content, /search_action_items/);
	assert.match(first.content, /thin last-mile item/);
	assert.match(first.content, /Pi cannot add the \[devspec:<full-uuid>\] commit reference for you/);
	assert.doesNotMatch(first.content, /refus|analy[sz]er|reconcil|safety net/i);
	assert.equal(first.details.projectId, PROJECT);
	for (const tool of ["write", "edit", "apply_patch", "notebook"]) {
		assert.equal(await unclaimedEditNudge(tool, runtime(), resolvePin), null, `${tool} must not re-nudge`);
	}
});

test("reload module graphs cannot re-arm a spent session/project nudge", async () => {
	resetWorkStateForTests();
	const resolvePin = async () => PROJECT;
	assert.ok(await unclaimedEditNudge("write", runtime(), resolvePin));
	const freshUrl = new URL("../extensions/devspec-provenance-assistance.ts", import.meta.url);
	freshUrl.searchParams.set("reload", `${Date.now()}-${Math.random()}`);
	const fresh = await import(freshUrl.href) as typeof import("../extensions/devspec-provenance-assistance.ts");
	assert.equal(await fresh.unclaimedEditNudge("edit", runtime(), resolvePin), null);
});

test("uncertain jurisdiction and existing claims suppress the nudge without blocking", async () => {
	resetWorkStateForTests();
	assert.equal(await unclaimedEditNudge("write", runtime(), async () => null), null);
	assert.equal(await unclaimedEditNudge("write", runtime(), async () => "not-a-project-id"), null);
	assert.equal(hasObservedClaim("session-a"), false);
	assert.equal(observeSuccessfulWorkResult(
		"claim_work_item",
		{ action_item_id: ITEM },
		successfulClaim(),
		"session-a",
	), true);
	assert.equal(hasObservedClaim("session-a"), true);
	assert.equal(await unclaimedEditNudge("write", runtime(), async () => PROJECT), null);
});

test("post-record follow-through remains writable and may receive only the advisory nudge", async () => {
	resetWorkStateForTests();
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM }, successfulClaim(), "session-a");
	assert.equal(hasObservedClaim("session-a"), true);
	observeSuccessfulWorkResult(
		"record_implementation",
		{ action_item_id: ITEM },
		{ details: { id: ITEM, lifecycle: "implemented" } },
		"session-a",
	);
	assert.equal(hasObservedClaim("session-a"), false);
	const followThrough = await unclaimedEditNudge("edit", runtime(), async () => PROJECT);
	assert.ok(followThrough);
	assert.match(followThrough.content, /Continue this edit/);
	assert.match(followThrough.content, /claim the covering item/);
});

test("registered tool handler injects one model-visible steer without blocking", async () => {
	resetWorkStateForTests();
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const sent: Array<{ message: any; options: any }> = [];
	const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
	const pi = {
		on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
		sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
		registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) { commands.set(name, command); },
	} as unknown as ExtensionAPI;
	provenanceExtension(pi);
	assert.ok(commands.has("devspec.pin"));

	const cwd = mkdtempSync(join(tmpdir(), "devspec-pi-nudge-"));
	try {
		const ctx = runtime("session-a", cwd);
		assert.equal(await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "touch x" } }, ctx), undefined);
		assert.equal(await handlers.get("tool_call")?.({ toolName: "write", input: { path: "x" } }, ctx), undefined);
		assert.equal(sent.length, 0, "an unpinned folder has no positive local jurisdiction");

		await commands.get("devspec.pin")?.handler(PROJECT, { cwd, ui: { notify() {} } });
		assert.equal(await handlers.get("tool_call")?.({ toolName: "edit", input: { path: "x" } }, ctx), undefined);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.customType, "devspec-provenance-nudge");
		assert.equal(sent[0]?.message.display, true);
		assert.deepEqual(sent[0]?.options, { deliverAs: "steer", triggerTurn: false });
		assert.match(sent[0]?.message.content, /claim the covering item/);

		assert.equal(await handlers.get("tool_call")?.({ toolName: "write", input: { path: "y" } }, ctx), undefined);
		assert.equal(sent.length, 1, "the same session/project is nudged only once");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/devspec.pin is the explicit local write; generic extension startup writes nothing", async () => {
	resetWorkStateForTests();
	const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
	const pi = {
		on() {},
		sendMessage() {},
		registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) { commands.set(name, command); },
	} as unknown as ExtensionAPI;
	provenanceExtension(pi);
	const cwd = mkdtempSync(join(tmpdir(), "devspec-pi-pin-command-"));
	const notices: string[] = [];
	try {
		assert.equal(await resolveProjectPin(cwd, join(cwd, "no-home")), null);
		assert.equal(existsSync(join(cwd, ".devspec", "project.json")), false);
		const command = commands.get("devspec.pin");
		assert.ok(command);
		await command.handler(PROJECT, {
			cwd,
			ui: { notify(message: string) { notices.push(message); } },
		});
		assert.equal(await resolveProjectPin(cwd, join(cwd, "no-home")), PROJECT);
		assert.match(notices.join("\n"), /association written/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("obsolete mutation parser and trusted-child authority files are removed", () => {
	assert.equal(existsSync(new URL("../extensions/devspec-mutation-gate.ts", import.meta.url)), false);
	assert.equal(existsSync(new URL("../extensions/core/claim-authority.ts", import.meta.url)), false);
	const tools = readFileSync(new URL("../extensions/devspec-tools.ts", import.meta.url), "utf8");
	assert.doesNotMatch(tools, /claimAuthority|mutation authority|trusted subprocess/i);
});

test("checked-in capability table names every required fail-open surface", () => {
	const table = readFileSync(new URL("../docs/commit-provenance-capabilities.md", import.meta.url), "utf8");
	for (const phrase of [
		"First-class file edits", "Arbitrary Bash/shell", "Direct Git commit", "Git rewrite/ref operations", "Git push/outgoing history",
		"Project association", "DevSpec unavailable", "Post-implementation tools", "Subagents/unattended work",
	]) assert.match(table, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
	assert.match(table, /instructions plus DevSpec's universal commit ingestion\/analyzer/i);
	assert.match(table, /private session Git argv shim/i);
	assert.match(table, /`plugin_observed` measurement/i);
	assert.match(table, /does \*\*not\*\* claim universal process coverage/i);
	assert.match(table, /merge.*cherry-pick.*revert.*rebase.*am.*update-ref.*commit-tree/s);
});
