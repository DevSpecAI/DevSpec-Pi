import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	canonicalRepoRoot,
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
	isReadOnlyShellCommand,
	mutationGateDecision,
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

function repoWithLinkedWorktree(t: { after(fn: () => void): void }): { main: string; linked: string } {
	const root = mkdtempSync(join(tmpdir(), "devspec-pi-worktree-scope-"));
	const main = join(root, "main");
	const linked = join(root, "linked");
	execFileSync("git", ["init", "-q", main]);
	execFileSync("git", ["-C", main, "-c", "user.name=DevSpec Test", "-c", "user.email=test@devspec.local", "commit", "--allow-empty", "-q", "-m", "init"]);
	execFileSync("git", ["-C", main, "worktree", "add", "--detach", "-q", linked]);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { main, linked };
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

test("claim authority follows one session between a repository and its linked worktrees", (t) => {
	reset();
	const { main, linked } = repoWithLinkedWorktree(t);
	const mainScope = scope("session-a", main);
	const linkedScope = scope("session-a", linked);
	assert.equal(linkedScope.repoRoot, mainScope.repoRoot, "linked worktrees must share one repository identity");

	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), mainScope);
	assert.equal(mutationGateDecision("write", { path: "from-linked.ts" }, runtime("session-a", linked)), undefined);
	assert.equal(mutationGateDecision("write", { path: "other-session.ts" }, runtime("session-b", linked))?.block, true);

	reset();
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), linkedScope);
	assert.equal(mutationGateDecision("write", { path: "from-main.ts" }, runtime("session-a", main)), undefined);
});

test("non-Git directories retain a canonical cwd claim scope", (t) => {
	reset();
	const cwd = mkdtempSync(join(tmpdir(), "devspec-pi-non-git-scope-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const authority = scope("session-a", cwd);
	assert.equal(authority.repoRoot, cwd);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), authority);
	assert.equal(mutationGateDecision("write", { path: join(cwd, "note.txt") }, runtime("session-a", cwd)), undefined);
});

test("a claim survives initializing Git in a previously non-Git project", (t) => {
	reset();
	const cwd = mkdtempSync(join(tmpdir(), "devspec-pi-greenfield-scope-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const beforeInit = scope("session-a", cwd);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), beforeInit);

	execFileSync("git", ["init", "-q"], { cwd });
	const afterInit = scope("session-a", cwd);
	assert.equal(afterInit.repoRoot, beforeInit.repoRoot, "git init must not change the project identity");
	assert.equal(mutationGateDecision("write", { path: join(cwd, "first.ts") }, runtime("session-a", cwd)), undefined);
});

test("common Git directory remains the identity fallback when worktree enumeration fails", (t) => {
	const cwd = repo(t);
	const commonDirectory = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])
		.toString()
		.trim();
	const identity = canonicalRepoRoot(cwd, (args) => {
		if (args[0] === "worktree") throw new Error("simulated unsupported worktree listing");
		return commonDirectory;
	});
	assert.equal(identity, commonDirectory);
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

test("scoped cleanup clears only that session+repo runtime", (t) => {
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

test("preclaim permits read-only work and returns recoverable denials for known mutation", (t) => {
	reset();
	const cwd = repo(t);
	const ctx = runtime("session-a", cwd);
	for (const toolName of ["read", "grep", "find", "ls", "get_action_item", "claim_work_item", "record_memory", "devspec_help_search", "deploy", "future_custom_tool", "subagent"]) {
		assert.equal(mutationGateDecision(toolName, { path: join(tmpdir(), "outside-read") }, ctx), undefined, toolName);
	}
	for (const command of [
		"pwd -P",
		"git status --short --branch",
		"rg needle .",
		"find . -type f",
		"cd ../sibling && git status --short",
		"git branch -a | rg 'work/' || true",
		"printf '%s\\n' 'status'; git log --oneline -8",
	]) {
		assert.equal(isReadOnlyShellCommand(command), true, command);
		assert.equal(mutationGateDecision("bash", { command }, ctx), undefined, command);
	}
	for (const command of [
		"npm test",
		"touch new-file",
		"git reset --hard HEAD",
		"git status; touch hidden-mutation",
		"find . -delete",
		"printf \"$(touch hidden-substitution)\"",
		"git config --global --edit",
		"git reflog delete HEAD@{0}",
		"printf x > file",
	]) {
		assert.equal(isReadOnlyShellCommand(command), false, command);
		const denial = mutationGateDecision("bash", { command }, ctx);
		assert.equal(denial?.block, true, command);
		assert.equal(denial?.terminate, undefined, `${command} must not terminate the model turn`);
		assert.match(denial?.reason ?? "", /Claim the covering item and retry/u);
	}
	for (const toolName of ["write", "edit", "apply_patch", "notebook", "shell"]) {
		const denial = mutationGateDecision(toolName, {}, ctx);
		assert.equal(denial?.block, true, toolName);
		assert.equal(denial?.terminate, undefined, `${toolName} must not terminate the model turn`);
	}
});

test("preclaim permits narrow inspection-support commands but not product mutations", (t) => {
	reset();
	const cwd = repo(t);
	execFileSync("git", ["remote", "add", "origin", "https://example.invalid/project.git"], { cwd });
	const ctx = runtime("session-a", cwd);
	for (const command of [
		"git fetch",
		"git fetch --prune origin",
		"git fetch --tags --quiet origin",
		"git ls-remote origin",
		"git rev-list --left-right --count HEAD...origin/main",
		"npm ls @devspec/pi-plugin pi-subagents --depth=0",
		"npm --prefix /tmp/pi-agent/npm list --depth=0",
		"npm view pi-subagents version",
		"gh api repos/DevSpecAliPrice/pi-subagents",
		"gh api --method GET repos/DevSpecAliPrice/pi-subagents --jq .fork",
		"sha256sum package.json",
		"sort input.txt",
		"uniq input.txt",
		"git status --short 2>/dev/null",
		"git fetch --prune origin 2>/dev/null",
		"npm ls --depth=0 >/dev/null",
	]) {
		assert.equal(isReadOnlyShellCommand(command, cwd), true, command);
		assert.equal(mutationGateDecision("bash", { command }, ctx), undefined, command);
	}

	for (const command of [
		"git fetch origin main",
		"git fetch origin main:main",
		"git fetch sibling",
		"git fetch --recurse-submodules origin main",
		"git fetch https://example.com/repo.git",
		"git fetch --update-head-ok origin",
		"npm install left-pad",
		"npm run build",
		"gh api --method POST repos/example/project/issues",
		"gh api repos/example/project/issues -f title=mutation",
		"gh api repos/example/project/issues -ftitle=mutation",
		"gh api repos/example/project/issues -Ftitle=mutation",
		"git -c 'diff.external=touch gate-bypass' diff",
		"git --config-env=diff.external=EVIL diff",
		"git config -- devspec.review-test -blocked",
		"git grep --open-files-in-pager='touch gate-bypass' needle",
		"git grep -O'touch gate-bypass' needle",
		"git ls-remote --upload-pack='touch gate-bypass' origin",
		"GIT_TRACE=./trace git status",
		"npm_config_cache=./.npm-cache npm view pi-subagents version",
		"F=-ftitle=mutation; gh api repos/example/project/issues $F",
		"OPTS='--method POST'; gh api repos/example/project/issues $OPTS",
		"OPTS='--cache ./.npm-cache'; npm view pi-subagents version $OPTS",
		"OPTS='--prefer-online --cache ./.npm-cache'; npm view pi-subagents version $OPTS",
		"npm view pi-subagents version --cache ./.npm-cache",
		"npm view pi-subagents version --cache=./.npm-cache",
		"sort input.txt -ogenerated.txt",
		"sort input.txt -o=generated.txt",
		"sort --out=generated.txt input.txt",
		"sort -rogenerated.txt input.txt",
		"sort --compress-program='touch gate-bypass' input.txt",
		"sort -T. input.txt",
		"uniq input.txt generated.txt",
		"uniq - generated.txt",
		"uniq -- -input.txt generated.txt",
		"sha256sum package.json > digest.txt",
		"git status 3>gate-bypass",
		"node -p 'process.version'",
	]) {
		assert.equal(isReadOnlyShellCommand(command, cwd), false, command);
		assert.equal(mutationGateDecision("bash", { command }, ctx)?.block, true, command);
	}
});

test("only a fully recognized pi-subagents child is trusted to mutate without its own claim", (t) => {
	reset();
	const cwd = repo(t);
	const ctx = runtime("child-session", cwd);
	const decide = mutationGateDecision;
	const parentSession = "11111111-2222-3333-4444-555555555555";
	const trusted = { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: parentSession };

	assert.equal(decide("write", { path: "child.ts" }, ctx, trusted), undefined);
	assert.equal(decide("bash", { command: "touch child.ts" }, ctx, trusted), undefined);

	for (const environment of [
		{},
		{ PI_SUBAGENT_CHILD: "1" },
		{ PI_SUBAGENT_PARENT_SESSION: parentSession },
		{ PI_SUBAGENT_CHILD: "true", PI_SUBAGENT_PARENT_SESSION: parentSession },
		{ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: "" },
		{ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: ` ${parentSession}` },
		{ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: `${parentSession}\n` },
		{ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: "not-a-pi-session" },
		{ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: "a".repeat(300) },
	]) {
		assert.equal(decide("write", { path: "child.ts" }, ctx, environment)?.block, true, JSON.stringify(environment));
	}
	assert.equal(decide("read", { path: "child.ts" }, ctx, trusted), undefined);
	assert.equal(decide("future_custom_tool", {}, ctx, trusted), undefined);
});

test("a claim opens known mutation while unclassified extension tools keep their own contracts", (t) => {
	reset();
	const cwd = repo(t);
	const authority = scope("session-a", cwd);
	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), authority);
	const ctx = runtime("session-a", cwd);
	for (const toolName of ["write", "edit", "apply_patch", "notebook"]) {
		assert.equal(mutationGateDecision(toolName, { path: "inside.ts" }, ctx), undefined, toolName);
	}
	for (const toolName of ["read", "grep", "find", "ls", "get_action_item", "record_memory", "deploy", "future_custom_tool", "subagent"]) {
		assert.equal(mutationGateDecision(toolName, {}, ctx), undefined, toolName);
	}
	assert.equal(mutationGateDecision("bash", { command: "npm test" }, ctx), undefined);
	assert.equal(mutationGateDecision("shell", { command: "touch changed" }, ctx), undefined);
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

test("the reported compound cross-repository Git inspection is read-only before claim", (t) => {
	reset();
	const cwd = repo(t);
	const outside = repo(t);
	const inspection = [
		`WT=${outside}`,
		"printf '%s\\n' '--- status ---'",
		"git -C \"$WT\" status --short --branch",
		"printf '%s\\n' '--- diff stat ---'",
		"git -C \"$WT\" diff --stat",
		"printf '%s\\n' '--- changed files ---'",
		"git -C \"$WT\" diff --name-status",
		"printf '%s\\n' '--- untracked ---'",
		"git -C \"$WT\" ls-files --others --exclude-standard",
		"printf '%s\\n' '--- recent branch log ---'",
		"git -C \"$WT\" log --oneline --decorate -8",
	].join("\n");
	assert.equal(isReadOnlyShellCommand(inspection), true);
	assert.equal(mutationGateDecision("bash", { command: inspection }, runtime("session-a", cwd)), undefined);
});

test("a project-level claim permits direct and shell mutation across repository boundaries", (t) => {
	reset();
	const cwd = repo(t);
	const outside = repo(t);
	const authority = scope("session-a", cwd);
	const ctx = runtime("session-a", cwd);
	assert.equal(mutationGateDecision("write", { path: join(outside, "before.ts") }, ctx)?.block, true);
	assert.equal(mutationGateDecision("bash", { command: `touch ${join(outside, "before.ts")}` }, ctx)?.block, true);

	observeSuccessfulWorkResult("claim_work_item", { action_item_id: ITEM_A }, successfulClaim(ITEM_A), authority);
	assert.equal(mutationGateDecision("write", { path: join(outside, "after.ts") }, ctx), undefined);
	assert.equal(mutationGateDecision("edit", { path: join(outside, "after.ts") }, ctx), undefined);
	assert.equal(mutationGateDecision("notebook", { notebook_path: join(outside, "after.ipynb") }, ctx), undefined);
	assert.equal(mutationGateDecision("bash", { command: `git -C ${outside} checkout -b work/cross-repo` }, ctx), undefined);
});

test("registered headless handlers clear every repository authority for their session", (t) => {
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
	assert.equal(hasClaimAuthority(sameSessionOtherRepo), false, "session start must revoke stale authority from every repository");
	assert.equal((handlers.get("tool_call")?.({ toolName: "write", input: { path: "x" } }, runtime("session-a", cwd)) as { block?: boolean })?.block, true);
	handlers.get("session_shutdown")?.({}, runtime("session-b", cwd));
	assert.equal(hasClaimAuthority(second), false);
});
