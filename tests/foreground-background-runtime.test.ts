import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
const start = source.indexOf("async function settleTurn(");
const end = source.indexOf("function splitTurnAtBoundary(", start);
assert.ok(start >= 0 && end > start);

for (const pending of [[], ["owned-running-task"], ["completed-unconsumed-notification"]]) {
	test(`settleTurn releases its exact foreground independently of ${pending.join() || "empty background"}`, async () => {
		const captured = { commandTurnId: "original-command", trailPostFence: { drain: async () => {} },
			tracker: { lastAssistantText: "Answer", userKind: "remote", pendingBackgroundTasks: () => pending } };
		const posts: { turn: unknown; complete: boolean }[] = [];
		const scope = { turn: captured, pendingBackgroundTaskIds: new Set(pending), clearInterval,
			debug: () => {}, postSegmentAnswer: async (turn: unknown, _stats: unknown, _why: string, complete: boolean) => {
				posts.push({ turn, complete }); return true;
			} };
		const settle = runInNewContext(stripTypeScriptTypes(`${source.slice(start, end)}; settleTurn`), scope);
		await settle(null, true);
		assert.equal(posts.length, 1);
		assert.equal(posts[0].turn, captured, "must close the captured command, never borrow a new one");
		assert.equal(posts[0].complete, true, "background presence cannot retain exclusive foreground ownership");
		assert.equal(scope.turn, null);
		assert.equal(scope.pendingBackgroundTaskIds.size, pending.length, "foreground settlement does not settle background work");
	});
}
