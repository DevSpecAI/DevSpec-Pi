import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sandbox = await mkdtemp(join(tmpdir(), "devspec-pi-settings-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

const { loadSettings, saveSettings } = await import("../extensions/core/settings.ts");

test("defaults: autoBond on, preemptOwner on", async () => {
	const s = await loadSettings();
	assert.equal(s.autoBond, true);
	assert.equal(s.preemptOwner, true);
});

test("saveSettings persists and merges", async () => {
	await saveSettings({ autoBond: false });
	assert.equal((await loadSettings()).autoBond, false);
	assert.equal((await loadSettings()).preemptOwner, true);
	await saveSettings({ autoBond: true, preemptOwner: false });
	assert.equal((await loadSettings()).autoBond, true);
	assert.equal((await loadSettings()).preemptOwner, false);
});
