import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
	fileURLToPath(new URL("../extensions/devspec-work.ts", import.meta.url)),
	"utf8",
);

test("/devspec.work is explicit attended selection and has no independent queue drain", () => {
	assert.doesNotMatch(source, /get_next_work_item/);
	assert.doesNotMatch(source, /fetchNextFromQueue/);
	assert.match(source, /Choose one action item for attended work/);
	assert.match(source, /Select one explicit DevSpec action item for attended work/);
	assert.match(source, /executionMode: "attended"/);
	assert.match(source, /implementationContext\.source === "local_safety_fallback"/);
	assert.match(source, /no attended work was started/i);
});
