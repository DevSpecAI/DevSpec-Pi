import assert from "node:assert/strict";
import { test } from "node:test";
import { commandReloadContext, rememberExtensionRunner } from "../extensions/core/command-runner.ts";

test("commandReloadContext is null until a runner binds", () => {
	assert.equal(commandReloadContext(), null);
});

test("rememberExtensionRunner is idempotent", () => {
	rememberExtensionRunner();
	rememberExtensionRunner();
	assert.equal(commandReloadContext(), null);
});
