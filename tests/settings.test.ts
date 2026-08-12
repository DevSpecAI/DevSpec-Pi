import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "devspec-pi-settings-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

const { loadSettings, saveSettings } = await import("../extensions/core/settings.ts");

test("defaults: autoBond on (zero-command is the default state)", async () => {
	const s = await loadSettings();
	assert.equal(s.autoBond, true);
});

test("saveSettings persists and merges", async () => {
	await saveSettings({ autoBond: false });
	assert.equal((await loadSettings()).autoBond, false);
	await saveSettings({ autoBond: true });
	assert.equal((await loadSettings()).autoBond, true);
});
