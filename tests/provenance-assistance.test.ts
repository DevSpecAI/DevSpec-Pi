import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import provenanceExtension, {
	resetNudgeJurisdictionCacheForTests,
	resolveNudgeProject,
	unclaimedEditNudge,
} from "../extensions/devspec-provenance-assistance.ts";
import { resolveProjectPin } from "../extensions/core/project-scope.ts";
import {
	hasObservedClaim,
	observeSuccessfulWorkResult,
	resetWorkStateForTests,
} from "../extensions/core/work-state.ts";

const PROJECT = "11111111-2222-4333-8444-555555555555";
const PROJECT_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const ITEM = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function runtime(sessionId = "session-a", cwd = process.cwd()) {
	return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

const settleAsync = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Positive-delivery assertions poll to a deadline: resolveGitRemote alone costs
// ~28ms (one git spawn), so a fixed 25ms window flakes on any loaded machine.
const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await settleAsync(10);
	}
	return predicate();
};

function successfulClaim(id = ITEM, projectId = PROJECT) {
	return { details: { claim_success: true, task: { id, project_id: projectId } } };
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
	assert.match(first.content, /search_tasks/);
	// create_task requires a substantive description and intent: never advise a thin item (5a9eaa57).
	assert.match(first.content, /substantive description and the reason for the work/);
	assert.doesNotMatch(first.content, /thin|last-mile/);
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
		{ task_id: ITEM },
		successfulClaim(),
		"session-a",
		PROJECT,
	), true);
	assert.equal(hasObservedClaim("session-a"), true);
	assert.equal(await unclaimedEditNudge("write", runtime(), async () => PROJECT), null);
});

test("a claim in one project does not suppress another project's one-shot nudge", async () => {
	resetWorkStateForTests();
	observeSuccessfulWorkResult("claim_work_item", { task_id: ITEM }, successfulClaim(), "session-a", PROJECT);
	assert.equal(hasObservedClaim("session-a", PROJECT), true);
	assert.equal(hasObservedClaim("session-a", PROJECT_B), false);
	const other = await unclaimedEditNudge("edit", runtime(), async () => PROJECT_B);
	assert.ok(other);
	assert.equal(other.details.projectId, PROJECT_B);
});

test("an unbonded claim stores the server-resolved project from its result", () => {
	resetWorkStateForTests();
	observeSuccessfulWorkResult("claim_work_item", { task_id: ITEM }, successfulClaim(ITEM, PROJECT), "headless-session");
	assert.equal(hasObservedClaim("headless-session", PROJECT), true);
	assert.equal(hasObservedClaim("headless-session", PROJECT_B), false);
});

test("post-record follow-through remains writable and may receive only the advisory nudge", async () => {
	resetWorkStateForTests();
	observeSuccessfulWorkResult("claim_work_item", { task_id: ITEM }, successfulClaim(), "session-a", PROJECT);
	assert.equal(hasObservedClaim("session-a"), true);
	observeSuccessfulWorkResult(
		"record_implementation",
		{ task_id: ITEM },
		{ details: { id: ITEM, lifecycle: "implemented" } },
		"session-a",
		PROJECT,
	);
	assert.equal(hasObservedClaim("session-a"), false);
	const followThrough = await unclaimedEditNudge("edit", runtime(), async () => PROJECT);
	assert.ok(followThrough);
	assert.match(followThrough.content, /Continue this edit/);
	assert.match(followThrough.content, /claim the covering item/);
});

test("verified remotes resolve with remote-over-pin precedence and bounded cache isolation", async (t) => {
	resetNudgeJurisdictionCacheForTests();
	t.after(resetNudgeJurisdictionCacheForTests);
	let calls = 0;
	const deps = {
		resolveToken: async () => ({ token: "token-a" }),
		resolveEndpoint: async () => "https://staging.example/api/mcp",
		resolveGitRemote: async () => "git@github.com:acme/app.git",
		resolveProjectPin: async () => PROJECT,
		call: async () => {
			calls += 1;
			return { content: [{ type: "text", text: JSON.stringify({ remote_match: { resolved_project_id: PROJECT_B, candidate_project_ids: [] } }) }] };
		},
	};
	assert.equal(await resolveNudgeProject("/repo", deps as any, 1000), PROJECT_B, "verified remote beats stale pin");
	assert.equal(await resolveNudgeProject("/repo", deps as any, 1001), PROJECT_B);
	assert.equal(calls, 1, "same endpoint/token/remote/pin uses positive cache");

	const otherToken = { ...deps, resolveToken: async () => ({ token: "token-b" }) };
	assert.equal(await resolveNudgeProject("/repo", otherToken as any, 1002), PROJECT_B);
	assert.equal(calls, 2, "token fingerprint isolates cache entries");

	resetNudgeJurisdictionCacheForTests();
	calls = 0;
	const concurrent = await Promise.all([
		resolveNudgeProject("/parallel", deps as any, 2000),
		resolveNudgeProject("/parallel", deps as any, 2000),
		resolveNudgeProject("/parallel", deps as any, 2000),
	]);
	assert.deepEqual(concurrent, [PROJECT_B, PROJECT_B, PROJECT_B]);
	assert.equal(calls, 1, "concurrent cache misses coalesce to one request");
});

test("ambiguous, offline and malformed remote results fail open while explicit pins remain", async (t) => {
	resetNudgeJurisdictionCacheForTests();
	t.after(resetNudgeJurisdictionCacheForTests);
	const base = {
		resolveToken: async () => ({ token: "token" }),
		resolveEndpoint: async () => "https://staging.example/api/mcp",
		resolveGitRemote: async () => "git@github.com:acme/app.git",
		resolveProjectPin: async () => null,
		call: async () => ({ content: [{ type: "text", text: JSON.stringify({ remote_match: { resolved_project_id: null, candidate_project_ids: [PROJECT, PROJECT_B] } }) }] }),
	};
	assert.equal(await resolveNudgeProject("/ambiguous", base as any), null);
	assert.equal(await resolveNudgeProject("/candidate-pin", { ...base, resolveProjectPin: async () => PROJECT } as any), PROJECT);
	assert.equal(await resolveNudgeProject("/offline", { ...base, call: async () => { throw new Error("offline"); } } as any), null);
	assert.equal(await resolveNudgeProject("/malformed", { ...base, call: async () => ({ content: [{ type: "text", text: "not-json" }] }) } as any), null);
	assert.equal(await resolveNudgeProject("/pin-only", { ...base, resolveGitRemote: async () => null, resolveProjectPin: async () => PROJECT } as any), PROJECT);
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
		// Absence can only be bounded-waited: the window must comfortably exceed
		// the full jurisdiction resolution (~30ms) on a loaded machine.
		await settleAsync(250);
		assert.equal(sent.length, 0, "an unpinned folder has no positive local jurisdiction");

		await commands.get("devspec.pin")?.handler(PROJECT, { cwd, ui: { notify() {} } });
		assert.equal(handlers.get("tool_call")?.({ toolName: "edit", input: { path: "x" } }, ctx), undefined, "tool_call returns synchronously");
		assert.equal(await waitFor(() => sent.length === 1), true, "the pinned nudge arrives");
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

test("failed detached delivery rolls back the one-shot marker", async () => {
	resetWorkStateForTests();
	const handlers = new Map<string, (...args: any[]) => unknown>();
	let fail = true;
	let delivered = 0;
	const pi = {
		on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); },
		sendMessage() {
			if (fail) throw new Error("delivery failed");
			delivered += 1;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	provenanceExtension(pi);
	const cwd = mkdtempSync(join(tmpdir(), "devspec-pi-delivery-"));
	mkdirSync(join(cwd, ".devspec"));
	writeFileSync(join(cwd, ".devspec", "project.json"), JSON.stringify({ project_id: PROJECT }));
	const ctx = runtime("delivery-session", cwd);
	assert.equal(handlers.get("tool_call")?.({ toolName: "edit", input: {} }, ctx), undefined);
	await settleAsync();
	assert.equal(delivered, 0);
	fail = false;
	assert.equal(handlers.get("tool_call")?.({ toolName: "edit", input: {} }, ctx), undefined);
	await settleAsync();
	assert.equal(delivered, 1, "failed send did not consume the session/project marker");
	rmSync(cwd, { recursive: true, force: true });
});

test("reload during detached resolution cannot deliver stale or consume the marker", async () => {
	resetWorkStateForTests();
	const cwd = mkdtempSync(join(tmpdir(), "devspec-pi-reload-delivery-"));
	mkdirSync(join(cwd, ".devspec"));
	writeFileSync(join(cwd, ".devspec", "project.json"), JSON.stringify({ project_id: PROJECT }));
	const ctx = runtime("reload-session", cwd);
	let delivered = 0;
	const oldHandlers = new Map<string, (...args: any[]) => unknown>();
	provenanceExtension({
		on(event: string, handler: (...args: any[]) => unknown) { oldHandlers.set(event, handler); },
		sendMessage() { delivered += 1; },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	oldHandlers.get("tool_call")?.({ toolName: "edit", input: {} }, ctx);
	oldHandlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
	// Absence is bounded-waited: the window must exceed the ~30ms jurisdiction
	// resolution so a stale delivery would have had time to (wrongly) arrive.
	await settleAsync(250);
	assert.equal(delivered, 0);

	const newHandlers = new Map<string, (...args: any[]) => unknown>();
	provenanceExtension({
		on(event: string, handler: (...args: any[]) => unknown) { newHandlers.set(event, handler); },
		sendMessage() { delivered += 1; },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	newHandlers.get("tool_call")?.({ toolName: "edit", input: {} }, ctx);
	assert.equal(await waitFor(() => delivered === 1), true, "the post-reload nudge arrives");
	rmSync(cwd, { recursive: true, force: true });
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
