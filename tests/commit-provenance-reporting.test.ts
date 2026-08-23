import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	enqueueCommitReport,
	flushCommitReports,
	reportCapturedCommit,
	resetCommitReportQueueForTests,
} from "../extensions/devspec-commit-ledger.ts";
import type { LedgerCommit } from "../extensions/core/commit-ledger.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT = "11111111-2222-4333-8444-555555555555";
const CONNECTION = "99999999-8888-4777-8666-555555555555";
const OBSERVATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function commit(overrides: Partial<LedgerCommit> = {}): LedgerCommit {
	return { sha: SHA, shortSha: SHA.slice(0, 7), branch: "main", at: Date.now(), ...overrides };
}

function mcp(details: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(details) }] };
}

function attribution(observationId?: string) {
	return { connectionId: CONNECTION, projectId: PROJECT, ...(observationId ? { observationId } : {}) };
}

function deps(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ token: string; name: string; args: Record<string, unknown>; options?: unknown }> = [];
	const value = {
		resolveToken: async () => ({ token: "token" }),
		resolveGitRemote: async () => null,
		resolveProjectPin: async () => PROJECT,
		call: async (token: string, name: string, args: Record<string, unknown>, options?: unknown) => {
			calls.push({ token, name, args, options });
			return mcp({ recorded: true });
		},
		...overrides,
	};
	return { value: value as any, calls };
}

test("a captured commit reports the full SHA and exact frozen connection", async () => {
	const { value, calls } = deps();
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), value), "sent");
	assert.deepEqual(calls, [{
		token: "token",
		name: "report_commit_provenance",
		args: { connection_id: CONNECTION, commit_sha: SHA, branch: "main", pinned_project_id: PROJECT },
		options: { lane: "work", timeoutMs: 10_000 },
	}]);
});

test("commit-message linkage never controls reporting and retries are server-idempotent", async () => {
	const { value, calls } = deps();
	assert.equal(await reportCapturedCommit(commit({ commitMessage: "plain unreferenced subject" }), "/repo", attribution(), value), "sent");
	assert.equal(await reportCapturedCommit(commit({ commitMessage: "linked [devspec:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]" }), "/repo", attribution(), value), "sent");
	assert.equal(calls.filter((call) => call.name === "report_commit_provenance").length, 2);
});

test("a remote-backed report uses one server-verified request", async () => {
	const { value, calls } = deps({
		resolveGitRemote: async () => "git@github.com:DevSpecAI/DevSpec-Pi.git",
		resolveProjectPin: async () => null,
	});
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(OBSERVATION), value), "sent");
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.args, {
		connection_id: CONNECTION,
		commit_sha: SHA,
		branch: "main",
		observation_id: OBSERVATION,
		git_remote: "git@github.com:DevSpecAI/DevSpec-Pi.git",
	});
});

test("server jurisdiction rejection is permanent and cannot poison later reports", async () => {
	const { value, calls } = deps({
		resolveGitRemote: async () => "git@github.com:unrelated/repo.git",
		resolveProjectPin: async () => null,
		call: async (token: string, name: string, args: Record<string, unknown>, options?: unknown) => {
			calls.push({ token, name, args, options });
			throw new Error("git_remote is not a tracked repository on the observing connection project");
		},
	});
	assert.equal(await reportCapturedCommit(commit(), "/tmp/unrelated", attribution(), value), "permanent_rejection");
	assert.equal(calls.length, 1);
});

test("credential-bearing remotes are rejected locally and never transmitted", async () => {
	const { value, calls } = deps({
		resolveGitRemote: async () => "https://secret-token@github.com/acme/repo.git",
		resolveProjectPin: async () => null,
	});
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), value), "permanent_rejection");
	assert.equal(calls.length, 0);
});

test("missing auth is transient while malformed identity/SHA is permanent", async () => {
	const noAuth = deps({ resolveToken: async () => null });
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), noAuth.value), "transient_failure");
	const invalid = deps();
	assert.equal(await reportCapturedCommit(commit({ sha: "aaaaaaa" }), "/repo", attribution(), invalid.value), "permanent_rejection");
});

test("transport failures retry, while missing/mismatched local scope drops permanently", async () => {
	const transient = deps({ call: async () => { throw new Error("fetch failed"); } });
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), transient.value), "transient_failure");
	const noScope = deps({ resolveProjectPin: async () => null, resolveGitRemote: async () => null });
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), noScope.value), "permanent_rejection");
	const wrongPin = deps({ resolveProjectPin: async () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), wrongPin.value), "permanent_rejection");
});

test("the bounded outbox deduplicates, retries transient failure, and drops permanent heads", async (t) => {
	resetCommitReportQueueForTests();
	t.after(resetCommitReportQueueForTests);
	const offline = deps({ call: async () => { throw new Error("fetch failed"); } });
	enqueueCommitReport(commit(), "/repo", attribution(OBSERVATION));
	enqueueCommitReport(commit(), "/repo", attribution(OBSERVATION));
	await flushCommitReports(Date.now(), offline.value);

	const premature = deps();
	await flushCommitReports(Date.now(), premature.value);
	assert.equal(premature.calls.length, 0, "lifecycle bursts do not consume retry attempts before nextAttemptAt");

	const recovered = deps();
	await flushCommitReports(Date.now() + 2000, recovered.value);
	assert.equal(recovered.calls.filter((call) => call.name === "report_commit_provenance").length, 1);

	enqueueCommitReport(commit({ sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), "/unrelated", attribution());
	enqueueCommitReport(commit({ sha: "cccccccccccccccccccccccccccccccccccccccc" }), "/repo", attribution());
	const mixed = deps({
		resolveProjectPin: async (cwd: string) => cwd === "/repo" ? PROJECT : null,
	});
	await flushCommitReports(Date.now(), mixed.value);
	assert.equal(mixed.calls.filter((call) => call.name === "report_commit_provenance").length, 1);
	assert.equal(mixed.calls[0]?.args.commit_sha, "cccccccccccccccccccccccccccccccccccccccc");
});

test("the observer injects through tool_call without replacing Bash, legacy-reporting, or user Bash", () => {
	const source = readFileSync(new URL("../extensions/devspec-commit-ledger.ts", import.meta.url), "utf8");
	assert.match(source, /pi\.on\("tool_call"/);
	assert.match(source, /event\.input\.command = `\$\{prepared\.prefix\}\$\{event\.input\.command\}`/);
	assert.doesNotMatch(source, /registerTool\([\s\S]*name:\s*["']bash["']/);
	assert.doesNotMatch(source, /pi\.on\("user_bash"/);
	assert.doesNotMatch(source, /enqueueCommitReport\(captured, ctx\.cwd/);
});
