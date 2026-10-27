import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonSchemaToTypebox } from "../extensions/core/json-schema.ts";

test("wraps a JSON Schema object without rewriting properties", () => {
	const schema = {
		type: "object",
		properties: {
			task_id: { type: "string", description: "id" },
			verdicts: { type: "array", items: { type: "object" } },
		},
		required: ["task_id", "verdicts"],
	};
	const wrapped = jsonSchemaToTypebox(schema) as unknown as Record<string, unknown>;
	assert.equal(wrapped.type, "object");
	const props = wrapped.properties as Record<string, unknown>;
	assert.ok(props.task_id);
	assert.ok(props.verdicts);
	assert.deepEqual(wrapped.required, ["task_id", "verdicts"]);
});

test("empty / missing schema becomes an empty object", () => {
	const empty = jsonSchemaToTypebox(undefined) as unknown as Record<string, unknown>;
	assert.equal(empty.type, "object");
});
