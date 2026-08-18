import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	claimAuthorityScope,
	clearClaimAuthorities,
	hasClaimAuthority,
	listClaimAuthorities,
	observeSuccessfulWorkResult,
	resetClaimAuthoritiesForTests,
	type ClaimAuthorityScope,
} from "../extensions/core/claim-authority.ts";
import {
	buildImplementationKickoff,
	IMPLEMENTATION_CONTRACT_RESOURCE_URI,
} from "../extensions/core/implementation-contract.ts";
import { recordActiveDelivery, resetActiveDeliveries } from "../extensions/core/active-deliveries.ts";
import mutationGateExtension, {
	bashCommandStaysInRepo,
	isReadOnlyShellCommand,
	mutationGateDecision,
	targetIsInsideRepo,
} from "../extensions/devspec-mutation-gate.ts";
import { consumeResultMechanics } from "../extensions/devspec-tools.ts";

const ITEM_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ITEM_B = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ITEM_C = "cccccccc-dddd-eeee-ffff-000000000000";

function result(details: unknown, text = "server result") {
	return { content: [{ type: "text", text }], details };
}

function successfulClaim(id: string) {
	return result({ claim_success: true, action_item: { id, title: `Item ${id}` } });
}

function runtime(sessionId: string, cwd: string) {
	return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

function repo(t: { after(fn: () => void): void }): string {
	const cwd = mkdtempSync(join(tmpdir(), "devspec-pi-gate-"));
	execFileSync("git", ["init", "-q"], { cwd });
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

function scope(sessionId: string, cwd: string): ClaimAuthorityScope {
	const value = claimAuthorityScope(sessionId, cwd);
	assert.ok(value);
	return value;
}

function reset(): void {
	resetClaimAuthoritiesForTests();
	resetActiveDeliveries();
}

test("delivery, footer data, request id fallback, and prose never authorize mutation", (t) => {
	reset();
	const cwd = repo(t);
	const authority = scope("session-a", cwd);
	const context = {
		contractVersion: "3.0.0",
		resourceUri: IMPLEMENTATION_CONTRACT_RESOURCE_URI,
		source: "resource" as const,
		rules: [],
	};
	recordActiveDelivery(buildImplementationKickoff({ actionItemIds: [ITEM_A], context }), context);
	assert.equal(hasClaimAuthority(authority), false);
	assert.equal(observeSuccessfulWorkResult("get_action_item", {}, result({ item: { id: ITEM_A } }, "claimed"), authority), false);
	assert.equal(observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, "claimed successfully", authority), false);
	assert.equal(observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, result({ claim_success: true }), authority), false);
	assert.equal(mutationGateDecision("write", { path: "x" }, runtime("session-a", cwd))?.block, true);
});

test("arming requires affirmative claim_success, no negative marker, and the matching full response id", (t) => {
	reset();
	const cwd = repo(t);
	const authority = scope("session-a", cwd);
	for (const details of [
		{ claimed: true, action_item_id: ITEM_A },
		{ claim_success: false, action_item_id: ITEM_A },
		{ claim_success: true, claimed: false, action_item_id: ITEM_A },
		{ claim_success: true, error: "conflict", action_item_id: ITEM_A },
		{ claim_success: true, blocked: true, action_item_id: ITEM_A },
		{ claim_success: true, action_item_id: ITEM_A.slice(0, 8) },
		{ claim_success: true, action_item_id: ITEM_B },
	]) {
		assert.equal(observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, result(details), authority), false);
	}
	assert.equal(observeSuccessfulWorkResult(
		"claim_work_item",
		{ action_item_id: ITEM_A.slice(0, 8) },
		result({ claim_success: true, action_item_id: ITEM_A.slice(0, 8) }),
		authority,
	), false, "matching prefixes are not full item identities");
	assert.equal(hasClaimAuthority(authority), false);
	consumeResultMechanics("claim_work_item", successfulClaim(ITEM_A), { action_item_id: ITEM_A }, authority);
	assert.equal(hasClaimAuthority(authority, ITEM_A), true);
	assert.deepEqual(listClaimAuthorities(authority).map(({ actionItemId, repoRoot, sessionId }) => ({ actionItemId, repoRoot, sessionId })), [{
		actionItemId: ITEM_A,
		repoRoot: authority.repoRoot,
		sessionId: "session-a",
	}]);
});

test("authority is isolated by Pi session and canonical repository", (t) => {
	reset();
	const repoA = repo(t);
	const repoB = repo(t);
	const a = scope("session-a", repoA);
	const siblingSession = scope("session-b", repoA);
	const siblingRepo = scope("session-a", repoB);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), a);
	assert.equal(hasClaimAuthority(a), true);
	assert.equal(hasClaimAuthority(siblingSession), false);
	assert.equal(hasClaimAuthority(siblingRepo), false);
	assert.equal(mutationGateDecision("write", { path: "inside.ts" }, runtime("session-b", repoA))?.block, true);
	assert.equal(mutationGateDecision("write", { path: "inside.ts" }, runtime("session-a", repoB))?.block, true);
});

test("terminal cleanup requires a matching item and realistic explicit success", (t) => {
	reset();
	const cwd = repo(t);
	const authority = scope("session-a", cwd);
	for (const id of [ITEM_A, ITEM_B]) {
		observeSuccessfulWorkResult("claim_work_item", { action_item_id: id }, successfulClaim(id), authority);
	}
	for (const details of [
		{ ok: true, action_item_id: ITEM_A },
		{ lifecycle: "implemented", action_item_id: ITEM_B },
		{ lifecycle: "implemented", action_item_id: ITEM_A.slice(0, 8) },
		{ lifecycle: "implemented", action_item_id: ITEM_A, error: "reload failed" },
	]) {
		observeSuccessfulWorkResult("record_implementation", { action_item_id: ITEM_A }, result(details), authority);
	}
	assert.equal(hasClaimAuthority(authority, ITEM_A), true);
	observeSuccessfulWorkResult("record_implementation", { action_item_id: ITEM_A }, result({ id: ITEM_A, lifecycle: "implemented" }), authority);
	assert.equal(hasClaimAuthority(authority, ITEM_A), false);
	assert.equal(hasClaimAuthority(authority, ITEM_B), true);
	observeSuccessfulWorkResult(
		"record_implementation",
		{ action_item_id: ITEM_B },
		result({ implementation_recorded: true, item: { action_item: { id: ITEM_B, lifecycle: "implemented" } } }),
		authority,
	);
	assert.equal(hasClaimAuthority(authority, ITEM_B), false, "real terminal item.action_item.id clears matching authority");
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_B }, successfulClaim(ITEM_B), authority);
	observeSuccessfulWorkResult("release_work_item", { action_item_id: ITEM_B }, result({ success: true, action_item_id: ITEM_B }), authority);
	assert.equal(hasClaimAuthority(authority, ITEM_B), true, "generic success without release evidence is insufficient");
	observeSuccessfulWorkResult("release_work_item", { action_item_id: ITEM_B }, result({ success: true, action_item_id: ITEM_B, released_at: "2026-01-01T00:00:00Z", was_claimed: true }), authority);
	assert.equal(hasClaimAuthority(authority), false);

	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_C }, successfulClaim(ITEM_C), authority);
	observeSuccessfulWorkResult("fail_work_item", { action_item_id: ITEM_C }, result({ id: ITEM_C, agent_activity: "failed" }), authority);
	assert.equal(hasClaimAuthority(authority), false);
});

test("session lifecycle clears only that session+repo runtime", (t) => {
	reset();
	const repoA = repo(t);
	const repoB = repo(t);
	const first = scope("session-a", repoA);
	const siblingSession = scope("session-b", repoA);
	const siblingRepo = scope("session-a", repoB);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), first);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_B }, successfulClaim(ITEM_B), siblingSession);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_C }, successfulClaim(ITEM_C), siblingRepo);
	assert.equal(clearClaimAuthorities(first), 1);
	assert.equal(hasClaimAuthority(first), false);
	assert.equal(hasClaimAuthority(siblingSession), true);
	assert.equal(hasClaimAuthority(siblingRepo), true);
});

test("preclaim permits exact read tools, native DevSpec verbs, and pwd only", (t) => {
	reset();
	const cwd = repo(t);
	const ctx = runtime("session-a", cwd);
	for (const toolName of ["read", "grep", "find", "ls", "get_action_item", "claim_work_item", "record_memory", "devspec_help_search"]) {
		assert.equal(mutationGateDecision(toolName, {}, ctx), undefined, toolName);
	}
	assert.equal(isReadOnlyShellCommand("pwd"), true);
	for (const command of ["pwd -P", "git status", "rg needle .", "find . -type f", "env", "npm test"]) {
		assert.equal(isReadOnlyShellCommand(command), false, command);
		assert.equal(mutationGateDecision("bash", { command }, ctx)?.block, true, command);
	}
	for (const toolName of ["write", "edit", "apply_patch", "notebook", "shell", "deploy", "future_custom_tool"]) {
		assert.equal(mutationGateDecision(toolName, {}, ctx)?.block, true, toolName);
	}
	assert.equal(mutationGateDecision("bash", { command: "pwd" }, ctx), undefined);
});

test("a claim opens only exact audited mutators, never unknown or future tools", (t) => {
	reset();
	const cwd = repo(t);
	const authority = scope("session-a", cwd);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), authority);
	const ctx = runtime("session-a", cwd);
	for (const toolName of ["apply_patch", "deploy", "future_custom_tool", "write_v2", "bash_v2"]) {
		assert.equal(mutationGateDecision(toolName, { path: "inside.ts", command: "pwd" }, ctx)?.block, true, toolName);
	}
	for (const toolName of ["read", "grep", "find", "ls", "get_action_item", "record_memory"]) {
		assert.equal(mutationGateDecision(toolName, {}, ctx), undefined, toolName);
	}
});

test("fresh module graphs share claim observations globally but isolate runtimes", async (t) => {
	reset();
	const repoA = repo(t);
	const repoB = repo(t);
	const nonce = `${Date.now()}-${Math.random()}`;
	const observerUrl = new URL("../extensions/core/claim-authority.ts", import.meta.url);
	observerUrl.searchParams.set("observer", nonce);
	const gateUrl = new URL("../extensions/devspec-mutation-gate.ts", import.meta.url);
	gateUrl.searchParams.set("gate", nonce);
	const observer = await import(observerUrl.href) as typeof import("../extensions/core/claim-authority.ts");
	const freshGate = await import(gateUrl.href) as typeof import("../extensions/devspec-mutation-gate.ts");
	assert.notEqual(observer.observeSuccessfulWorkResult, observeSuccessfulWorkResult, "observer must be a fresh module instance");
	assert.notEqual(freshGate.mutationGateDecision, mutationGateDecision, "gate must be a fresh module instance");

	const authority = observer.claimAuthorityScope("runtime-a", repoA);
	assert.ok(authority);
	assert.equal(observer.observeSuccessfulWorkResult(
		"claim_work_item",
		{ action_item_id: ITEM_A },
		successfulClaim(ITEM_A),
		authority,
	), true);
	assert.equal(
		freshGate.mutationGateDecision("write", { path: "inside.ts" }, runtime("runtime-a", repoA)),
		undefined,
		"the gate's module graph must observe the Symbol.for-backed claim",
	);
	assert.equal(freshGate.mutationGateDecision("write", { path: "inside.ts" }, runtime("runtime-b", repoA))?.block, true);
	assert.equal(freshGate.mutationGateDecision("write", { path: "inside.ts" }, runtime("runtime-a", repoB))?.block, true);
});

test("claimed direct file tools remain inside the canonical repo across traversal and symlinks", (t) => {
	reset();
	const cwd = repo(t);
	const outside = mkdtempSync(join(tmpdir(), "devspec-pi-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	mkdirSync(join(cwd, "src"));
	symlinkSync(outside, join(cwd, "escape"));
	const authority = scope("session-a", cwd);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), authority);
	const ctx = runtime("session-a", join(cwd, "src"));
	assert.equal(targetIsInsideRepo("inside.ts", join(cwd, "src"), authority.repoRoot), true);
	assert.equal(mutationGateDecision("write", { path: "inside.ts" }, ctx), undefined);
	assert.equal(mutationGateDecision("edit", { path: join(cwd, "src", "inside.ts") }, ctx), undefined);
	assert.equal(mutationGateDecision("notebook", { notebook_path: "notes.ipynb" }, ctx), undefined);
	for (const target of ["../../outside.ts", join(outside, "absolute.ts"), "../escape/new.ts"]) {
		assert.equal(targetIsInsideRepo(target, join(cwd, "src"), authority.repoRoot), false, target);
		assert.equal(mutationGateDecision("write", { path: target }, ctx)?.block, true, target);
	}
	assert.equal(mutationGateDecision("notebook", { notebook_path: "../escape/n.ipynb" }, ctx)?.block, true);
	assert.equal(mutationGateDecision("edit", {}, ctx)?.block, true);
});

test("claimed bash blocks obvious cross-repo cwd, git -C, traversal, and absolute targets", (t) => {
	reset();
	const cwd = repo(t);
	const outside = mkdtempSync(join(tmpdir(), "devspec-pi-shell-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	mkdirSync(join(cwd, "src"));
	symlinkSync(outside, join(cwd, "escape"));
	const authority = scope("session-a", cwd);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), authority);
	const ctx = runtime("session-a", cwd);
	for (const command of ["npm test", "cd src && npm test", "git -C src status", "touch src/new.ts"]) {
		assert.equal(bashCommandStaysInRepo(command, cwd, authority.repoRoot), true, command);
		assert.equal(mutationGateDecision("bash", { command }, ctx), undefined, command);
	}
	for (const command of [
		"cd .. && touch escaped",
		`cd ${outside} && touch escaped`,
		"git -C .. status",
		`git --work-tree=${outside} status`,
		`touch ${join(outside, "escaped")}`,
		"touch ../escaped",
		"touch src/../../../escaped",
		"touch escape/escaped",
		"cd $HOME",
	]) {
		assert.equal(bashCommandStaysInRepo(command, cwd, authority.repoRoot), false, command);
		assert.equal(mutationGateDecision("bash", { command }, ctx)?.block, true, command);
	}
});

test("registered headless handlers clear only their own session on start and shutdown", (t) => {
	reset();
	const cwd = repo(t);
	const otherRepo = repo(t);
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = { on(event: string, handler: (...args: any[]) => unknown) { handlers.set(event, handler); } } as unknown as ExtensionAPI;
	mutationGateExtension(pi);
	const first = scope("session-a", cwd);
	const second = scope("session-b", cwd);
	const sameSessionOtherRepo = scope("session-a", otherRepo);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), first);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_B }, successfulClaim(ITEM_B), second);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_C }, successfulClaim(ITEM_C), sameSessionOtherRepo);
	handlers.get("session_start")?.({}, runtime("session-a", cwd));
	assert.equal(hasClaimAuthority(first), false);
	assert.equal(hasClaimAuthority(second), true);
	assert.equal(hasClaimAuthority(sameSessionOtherRepo), true);
	assert.equal((handlers.get("tool_call")?.({ toolName: "write", input: { path: "x" } }, runtime("session-a", cwd)) as { block?: boolean })?.block, true);
	handlers.get("session_shutdown")?.({}, runtime("session-b", cwd));
	assert.equal(hasClaimAuthority(second), false);
});
