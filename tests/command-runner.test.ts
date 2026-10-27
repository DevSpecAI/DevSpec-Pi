import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionCommandContext, rememberExtensionRunner } from "../extensions/core/command-runner.ts";

test("extensionCommandContext is null until a runner binds", () => {
	assert.equal(extensionCommandContext(), null);
});

test("rememberExtensionRunner is idempotent", () => {
	rememberExtensionRunner();
	rememberExtensionRunner();
	assert.equal(extensionCommandContext(), null);
});
