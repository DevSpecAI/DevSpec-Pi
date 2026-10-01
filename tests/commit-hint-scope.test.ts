import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { recordObservedCommit, validateCommitSha } from "../extensions/core/commit-ledger.ts";
import { applyCommitLedgerVerdict } from "../extensions/devspec-tools.ts";
const A = "e0fb039131fef828bff00b54f7d382e9768a64ba";
beforeEach(() => { (globalThis as unknown as Record<string, unknown>).__devspecPiCommitLedger = { commits: [] }; });

test("a report-only next item cannot inherit the preceding item's sole recent commit", () => {
  recordObservedCommit({ sha: A, shortSha: A.slice(0, 7), branch: "staging", at: Date.now(), commitMessage: "prior work [devspec:3d1f5f9d]" });
  const verdict = validateCommitSha(undefined, () => A);
  assert.equal(verdict.ok, true);
  if (!verdict.ok) return;
  const args = applyCommitLedgerVerdict({ action_item_id: "b87ef5f0-b87d-41a7-83af-1bcc3705cd83", completion_note: "Read-only assessment; no implementing commit." }, verdict);
  assert.equal(Object.hasOwn(args, "commit_sha"), false);
  assert.equal(Object.hasOwn(args, "commit_message"), false);
});

test("a colliding short hint must reach project-wide resolution unchanged", () => {
  const prefix = "a123456";
  for (const tail of ["0", "1"]) {
    const sha = prefix + tail.repeat(33);
    recordObservedCommit({ sha, shortSha: prefix, branch: "work", at: Date.now() });
  }
  const verdict = validateCommitSha(prefix, () => prefix + "0".repeat(33));
  assert.equal(verdict.ok && verdict.sha, prefix);
});

test("one cwd's short-object hit cannot prove uniqueness across the project's repositories", () => {
  let resolves = 0;
  const verdict = validateCommitSha(A.slice(0, 9), () => { resolves++; return A; });
  assert.equal(verdict.ok && verdict.sha, A.slice(0, 9));
  assert.equal(resolves, 0);
});

test("a resolver cannot replace an explicit full object with a different object's proof", () => {
  const verdict = validateCommitSha(A, () => "f".repeat(40));
  assert.deepEqual(verdict, { ok: true, sha: A, autoFilled: false, unverified: true });
});

test("an explicit normalized full-object hit can carry its message without changing the supplied hint", () => {
  recordObservedCommit({ sha: A, shortSha: A.slice(0, 7), branch: "staging", at: Date.now(), commitMessage: "observed message" });
  const hint = ` ${A.toUpperCase()} `;
  const verdict = validateCommitSha(hint, () => null);
  assert.deepEqual(verdict, { ok: true, sha: hint, autoFilled: false, commitMessage: "observed message" });
});

test("supported normalized hex hints retain original bytes for server resolution", () => {
  for (let width = 7; width <= 40; width++) {
    const hint = `  ${A.slice(0, width).toUpperCase()}  `;
    const verdict = validateCommitSha(hint, () => null);
    assert.equal(verdict.ok, true, String(width));
    assert.equal(verdict.ok && verdict.sha, hint, String(width));
  }
});
