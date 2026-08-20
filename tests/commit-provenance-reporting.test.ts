import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reportCapturedCommit } from "../extensions/devspec-commit-ledger.ts";
import type { LedgerCommit } from "../extensions/core/commit-ledger.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PIN = "11111111-2222-3333-4444-555555555555";
const CONNECTION = "99999999-8888-7777-6666-555555555555";

function commit(overrides: Partial<LedgerCommit> = {}): LedgerCommit {
	return { sha: SHA, shortSha: SHA.slice(0, 7), branch: "main", at: Date.now(), ...overrides };
}

function mcp(details: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(details) }] };
}

function deps(overrides: Record<string, unknown> = {}) {
	const calls: Array<{ token: string; name: string; args: Record<string, unknown>; options?: unknown }> = [];
	const value = {
		getBond: () => ({ connectionId: CONNECTION }),
		resolveToken: async () => ({ token: "token" }),
		resolveGitRemote: async () => "git@github.com:DevSpecAI/DevSpec-Pi.git",
		resolveProjectPin: async () => PIN,
		call: async (token: string, name: string, args: Record<string, unknown>, options?: unknown) => {
			calls.push({ token, name, args, options });
			return mcp({ recorded: true });
		},
		...overrides,
	};
	return { value: value as any, calls };
}

test("a captured commit reports the full SHA and exact active connection", async () => {
	const { value, calls } = deps();
	assert.equal(await reportCapturedCommit(commit(), "/repo", value), true);
	assert.deepEqual(calls, [{
		token: "token",
		name: "report_commit_provenance",
		args: { connection_id: CONNECTION, commit_sha: SHA, branch: "main" },
		options: { lane: "work", timeoutMs: 10_000 },
	}]);
});

test("commit-message linkage never controls reporting and retries are server-idempotent", async () => {
	const { value, calls } = deps();
	assert.equal(await reportCapturedCommit(commit({ commitMessage: "plain unreferenced subject" }), "/repo", value), true);
	assert.equal(await reportCapturedCommit(commit({ commitMessage: "linked [devspec:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]" }), "/repo", value), true);
	assert.equal(calls.filter((call) => call.name === "report_commit_provenance").length, 2);
	for (const call of calls) assert.equal(call.args.commit_sha, SHA);
});

test("a uniquely matched Git remote is positive jurisdiction without a pin", async () => {
	const { value, calls } = deps({
		resolveProjectPin: async () => null,
		call: async (token: string, name: string, args: Record<string, unknown>, options?: unknown) => {
			calls.push({ token, name, args, options });
			if (name === "list_projects") return mcp({ remote_match: { resolved_project_id: PIN, candidate_project_ids: [PIN] } });
			return mcp({ recorded: true });
		},
	});
	assert.equal(await reportCapturedCommit(commit(), "/repo", value), true);
	assert.deepEqual(calls.map((call) => call.name), ["list_projects", "report_commit_provenance"]);
	assert.deepEqual(calls[0]?.args, { git_remote: "git@github.com:DevSpecAI/DevSpec-Pi.git" });
});

test("an unrelated repository is never attributed to the bonded project", async () => {
	const { value, calls } = deps({
		resolveProjectPin: async () => null,
		call: async (token: string, name: string, args: Record<string, unknown>, options?: unknown) => {
			calls.push({ token, name, args, options });
			return mcp({ remote_match: { resolved_project_id: null, candidate_project_ids: [] } });
		},
	});
	assert.equal(await reportCapturedCommit(commit(), "/tmp/unrelated", value), false);
	assert.deepEqual(calls.map((call) => call.name), ["list_projects"]);
});

test("missing identity, auth, or a full SHA fails open without a server call", async () => {
	for (const override of [
		{ getBond: () => null },
		{ resolveToken: async () => null },
	]) {
		const { value, calls } = deps(override);
		assert.equal(await reportCapturedCommit(commit(), "/repo", value), false);
		assert.equal(calls.length, 0);
	}
	const { value, calls } = deps();
	assert.equal(await reportCapturedCommit(commit({ sha: "aaaaaaa" }), "/repo", value), false);
	assert.equal(calls.length, 0);
});

test("transport, scoping, and reporting failures are swallowed after the commit", async () => {
	for (const stage of ["pin", "remote", "call"] as const) {
		const { value } = deps({
			resolveProjectPin: async () => {
				if (stage === "pin") throw new Error("pin failed");
				return PIN;
			},
			resolveGitRemote: async () => {
				if (stage === "remote") throw new Error("remote failed");
				return null;
			},
			call: async () => {
				if (stage === "call") throw new Error("offline");
				return mcp({ recorded: true });
			},
		});
		const result = await reportCapturedCommit(commit(), "/repo", value);
		assert.equal(result, stage === "remote", `unexpected ${stage} fail-open result`);
	}
});

test("the tool-end hook starts reporting without awaiting or mutating the Bash result", () => {
	const source = readFileSync(new URL("../extensions/devspec-commit-ledger.ts", import.meta.url), "utf8");
	assert.match(source, /void reportCapturedCommit\(captured, ctx\.cwd\)/);
	assert.doesNotMatch(source, /await reportCapturedCommit\(captured, ctx\.cwd\)/);
});
