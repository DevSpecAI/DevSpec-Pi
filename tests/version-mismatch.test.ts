import assert from "node:assert/strict";
import { test } from "node:test";
import { unwrapOrThrow } from "../extensions/devspec-tools.ts";
import { catalogEntry } from "../extensions/core/model-surface.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { unreadableRemoteMessageNotice } from "../extensions/core/version-mismatch.ts";
import { canonicalPoll, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";

// Item 39c05c1f: customers update the extension when they choose, so a newer
// DevSpec meets an older Pi. When a call fails because the two describe a tool
// differently, the model is told so and can tell the person to update; when the
// call itself was wrong, it is not.

function refused(refusal: Record<string, unknown>) {
	return { content: [{ type: "text", text: JSON.stringify(refusal, null, 2) }], structuredContent: refusal, isError: true };
}

function errorText(name: string, refusal: Record<string, unknown>): string {
	try {
		unwrapOrThrow(name, refused(refusal));
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	assert.fail("a refusal must throw");
}

const UPDATE = /version difference between DevSpec and this extension[\s\S]*pi update --extensions/;

function schemaProperty(tool: string, field: string): Record<string, unknown> {
	const schema = catalogEntry(tool)?.inputSchema as { properties: Record<string, Record<string, unknown>> } | undefined;
	const property = schema?.properties[field];
	assert.ok(property, `${tool}.${field} is in Pi's catalogue`);
	return property;
}

test("a tool DevSpec no longer has says so and says to update", () => {
	const text = errorText("search_memories", { error: "Unknown tool: search_memories", code: "unknown_tool", tool: "search_memories" });
	assert.match(text, /no longer has the `search_memories` tool/);
	assert.match(text, UPDATE);
});

test("a field DevSpec now requires and Pi does not ask for is a version difference", () => {
	const text = errorText("search_memories", { error: "scope is required", code: "argument_missing", kind: "missing", tool: "search_memories", field: "scope" });
	assert.match(text, /now requires `scope` for `search_memories`/);
	assert.match(text, UPDATE);
});

test("a field Pi already requires is an ordinary mistake", () => {
	const required = (catalogEntry("get_memory")?.inputSchema as { required?: string[] }).required ?? [];
	assert.ok(required.includes("id"), "get_memory requires id in Pi's catalogue");
	const text = errorText("get_memory", { error: "id is required", code: "argument_missing", kind: "missing", tool: "get_memory", field: "id" });
	assert.match(text, /id is required/);
	assert.doesNotMatch(text, /pi update/);
});

test("allowed values: different from Pi's is a version difference, the same is not", () => {
	const offered = schemaProperty("search_memories", "type").enum as string[];
	const changed = errorText("search_memories", {
		error: "type must be one of …", code: "argument_not_allowed", kind: "not_allowed", tool: "search_memories", field: "type",
		allowed: [...offered, "lesson"], value: "lesson",
	});
	assert.match(changed, /accepts different values for `type`/);
	assert.match(changed, UPDATE);
	const same = errorText("search_memories", {
		error: "type must be one of …", code: "argument_not_allowed", kind: "not_allowed", tool: "search_memories", field: "type",
		allowed: [...offered].reverse(), value: "lessons",
	});
	assert.doesNotMatch(same, /pi update/);
});

test("limits: different from Pi's is a version difference, the same is not", () => {
	const property = schemaProperty("search_memories", "limit");
	const keyword = typeof property.maximum === "number" ? "maximum" : "minimum";
	const mine = typeof property[keyword] === "number" ? property[keyword] as number : 100;
	const changed = errorText("search_memories", {
		error: "limit is too large", code: "argument_limit_exceeded", kind: "limit", tool: "search_memories", field: "limit",
		keyword, limit: mine + 7, length: mine + 8, unit: "value",
	});
	assert.match(changed, /limits `limit` in `search_memories` differently/);
	assert.match(changed, UPDATE);
	if (typeof property[keyword] === "number") {
		const same = errorText("search_memories", {
			error: "limit is too large", code: "argument_limit_exceeded", kind: "limit", tool: "search_memories", field: "limit",
			keyword, limit: mine, length: mine + 1, unit: "value",
		});
		assert.doesNotMatch(same, /pi update/);
	}
});

test("refusals only the server can judge, and refusals about another tool, carry no update hint", () => {
	assert.doesNotMatch(errorText("search_memories", {
		error: "query must name something", code: "argument_invalid", kind: "invalid", tool: "search_memories", field: "query", reason: "empty",
	}), /pi update/);
	assert.doesNotMatch(errorText("search_memories", {
		error: "scope is required", code: "argument_missing", kind: "missing", tool: "get_memory", field: "scope",
	}), /pi update/);
	assert.doesNotMatch(errorText("search_memories", { error: "DevSpec is unavailable" }), /pi update/);
});

// A remote message Pi cannot read used to cost a debug line and a silent retry,
// so a command sent from a room never arrived and nobody was told why.

test("a remote message from a newer DevSpec is reported once, locally with the reason and in the room without it", () => {
	const future = canonicalPoll();
	(future.ingress as { contract_version: string }).contract_version = "9.0.0";
	const pkg = parsePollPayload(future, TEST_CONNECTION);
	assert.equal(pkg.canonicalState, "invalid");

	const first = unreadableRemoteMessageNotice(pkg.canonicalError, undefined);
	assert.ok(first);
	assert.match(first.local, /contract version/);
	assert.match(first.local, /pi update --extensions/);
	assert.match(first.local, /will act on the message once it can read it/);
	assert.match(first.room, /haven't acted on it/);
	assert.match(first.room, /pi update --extensions/);
	assert.doesNotMatch(first.room, /ingress|contract_version|9\.0\.0/, "the room is told what to do, not Pi's parser output");

	// The pump retries the same message: no second report for the same reason.
	assert.equal(unreadableRemoteMessageNotice(pkg.canonicalError, first.key), null);
	// A different reason is new information.
	const other = unreadableRemoteMessageNotice("ingress.schema_version: unknown schema version", first.key);
	assert.ok(other);
	assert.notEqual(other.key, first.key);
	// A rejection with no reason is still reported, once.
	const bare = unreadableRemoteMessageNotice(undefined, undefined);
	assert.ok(bare);
	assert.equal(unreadableRemoteMessageNotice(undefined, bare.key), null);
});
