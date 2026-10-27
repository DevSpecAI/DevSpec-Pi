import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
	fileURLToPath(new URL("../extensions/devspec-work.ts", import.meta.url)),
	"utf8",
);

test("/devspec.work is one explicit selection and has no independent queue drain", () => {
	assert.doesNotMatch(source, /get_next_work_item/);
	assert.doesNotMatch(source, /fetchNextFromQueue/);
	assert.match(source, /Choose one task to work on/);
	assert.match(source, /Select one explicit DevSpec task to work on/);
	assert.doesNotMatch(source, /implementationContext\.source === "local_safety_fallback"/);
	// No execution mode is passed to the loader, because there is none to pass.
	assert.doesNotMatch(source, /executionMode/);
});
