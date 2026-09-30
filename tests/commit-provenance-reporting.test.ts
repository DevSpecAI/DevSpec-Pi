import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	enqueueCommitReport,
	flushCommitReports,
	reportCapturedCommit,
	resetCommitReportQueueForTests,
	commitTokenHash,
	captureCommitTransport,
	captureCommitRepository,
	type FrozenCommitAttribution,
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

const ENDPOINT = "https://devspec.test/api/mcp";
function attribution(observationId?: string, overrides: Partial<FrozenCommitAttribution> = {}): FrozenCommitAttribution {
	return {
		connectionId: CONNECTION, projectId: PROJECT, connectionCapability: "fixture-capability",
		transport: { tokenHash: commitTokenHash("token"), endpoint: ENDPOINT },
		repository: { remote: null, pin: PROJECT },
		...(observationId ? { observationId } : {}), ...overrides,
	};
}

function deps(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ token: string; name: string; args: Record<string, unknown>; options?: unknown }> = [];
	const value = {
		resolveToken: async () => ({ token: "token" }),
		resolveEndpoint: async () => ENDPOINT,
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
		options: { lane: "work", timeoutMs: 10_000, retry: "never", endpoint: ENDPOINT, connectionCapability: "fixture-capability" },
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
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(OBSERVATION, {
		repository: { remote: "git@github.com:DevSpecAI/DevSpec-Pi.git", pin: null },
	}), value), "sent");
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
	assert.equal(await reportCapturedCommit(commit(), "/tmp/unrelated", attribution(undefined, {
		repository: { remote: "git@github.com:unrelated/repo.git", pin: null },
	}), value), "permanent_rejection");
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

test("queued retry never adopts a changed token or repository", async (t) => {
	resetCommitReportQueueForTests();
	t.after(resetCommitReportQueueForTests);
	const first = deps({
		resolveToken: async () => ({ token: "original-account" }),
		resolveGitRemote: async () => "git@github.com:fixture/original.git",
		call: async () => { throw new Error("fetch failed"); },
	});
	enqueueCommitReport(commit(), "/repo", attribution(OBSERVATION, {
		transport: { tokenHash: commitTokenHash("original-account"), endpoint: ENDPOINT },
		repository: { remote: "git@github.com:fixture/original.git", pin: PROJECT },
	}));
	await flushCommitReports(Date.now(), first.value);
	const changed = deps({
		resolveToken: async () => ({ token: "different-account" }),
		resolveGitRemote: async () => "git@github.com:fixture/different.git",
	});
	await flushCommitReports(Date.now() + 2000, changed.value);
	assert.equal(changed.calls.length, 0, "a retry must retain or decline the original binding, never restamp it");
});

test("capture keeps tokens out of source facts and validates repository scope", async () => {
	const { value } = deps();
	const transport = await captureCommitTransport(value);
	assert.deepEqual(transport, { tokenHash: commitTokenHash("token"), endpoint: ENDPOINT });
	assert.equal(JSON.stringify(transport).includes('"token"'), false);
	assert.deepEqual(await captureCommitRepository("/repo", PROJECT, value), { remote: null, pin: PROJECT });
	assert.equal(await captureCommitRepository("/repo", PROJECT, deps({ resolveProjectPin: async () => "foreign-project" }).value), null);
});

for (const [label, overrides] of [
	["token", { resolveToken: async () => ({ token: "new-account" }) }],
	["endpoint", { resolveEndpoint: async () => "https://different.invalid/api/mcp" }],
	["remote", { resolveGitRemote: async () => "git@github.com:fixture/new.git" }],
	["pin", { resolveProjectPin: async () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }],
] as const) {
	test(`changed ${label} cannot supply a queued report's identity`, async (t) => {
		resetCommitReportQueueForTests(); t.after(resetCommitReportQueueForTests);
		let attempts = 0;
		const offline = deps({ call: async () => { attempts++; throw new Error("fetch failed"); } });
		enqueueCommitReport(commit(), "/repo", attribution(OBSERVATION));
		await flushCommitReports(Date.now(), offline.value);
		assert.equal(attempts, 1, "first attempt must actually use the frozen original binding");
		const next = deps(overrides);
		await flushCommitReports(Date.now() + 2000, next.value);
		assert.equal(next.calls.length, 0);
	});
}

test("refusals and unknown replies never claim successful provenance delivery", async () => {
	const refused = deps({ call: async () => mcp({ recorded: false, conflict: true, original_connection_id: "other" }) });
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), refused.value), "permanent_rejection");
	const unknown = deps({ call: async () => mcp({ status: "unavailable" }) });
	assert.equal(await reportCapturedCommit(commit(), "/repo", attribution(), unknown.value), "transient_failure");
});

test("legacy unfrozen reports are dropped, never upgraded with today's context", async () => {
	const { value, calls } = deps();
	assert.equal(await reportCapturedCommit(commit(), "/repo", { connectionId: CONNECTION, projectId: PROJECT }, value), "permanent_rejection");
	assert.equal(calls.length, 0);
});

test("enqueued nested bindings cannot be mutated by their caller", async (t) => {
	resetCommitReportQueueForTests(); t.after(resetCommitReportQueueForTests);
	const original = attribution(OBSERVATION);
	enqueueCommitReport(commit(), "/repo", original);
	original.transport!.endpoint = "https://mutated.invalid/api/mcp";
	original.repository!.pin = "foreign";
	const { value, calls } = deps();
	await flushCommitReports(Date.now(), value);
	assert.equal(calls.length, 1);
	assert.equal((calls[0].options as { endpoint: string }).endpoint, ENDPOINT);
});

test("the observer injects through tool_call without replacing Bash, legacy-reporting, or user Bash", () => {
	const source = readFileSync(new URL("../extensions/devspec-commit-ledger.ts", import.meta.url), "utf8");
	assert.match(source, /pi\.on\("tool_call"/);
	assert.match(source, /event\.input\.command = `\$\{prepared\.prefix\}\$\{event\.input\.command\}`/);
	assert.doesNotMatch(source, /registerTool\([\s\S]*name:\s*["']bash["']/);
	assert.doesNotMatch(source, /pi\.on\("user_bash"/);
	assert.doesNotMatch(source, /enqueueCommitReport\(captured, ctx\.cwd/);
});
