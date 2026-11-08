/**
 * Pi's check-job validator against the server's own check-job definitions
 * (DevSpec item 1d89fe56). Runs when a paired DevSpecV2 checkout is present
 * (DEVSPEC_V2_ROOT, or a sibling devspecv2); skipped otherwise, as in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_JOB_VERSION, isCheckJobEnvelope } from "../extensions/core/dispatch.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const explicit = process.env.DEVSPEC_V2_ROOT?.trim();
const relative = "packages/core/src/coherence/check-jobs.ts";
const root = explicit ? resolve(explicit) : [resolve(here, "../../devspecv2"), resolve(here, "../../../devspecv2")].find(r => existsSync(resolve(r, relative)));

test("Pi accepts exactly the server's version-2 check-job envelope, for every record the server can name", async t => {
	if (!root || !existsSync(resolve(root, relative))) {
		if (explicit) assert.fail("DEVSPEC_V2_ROOT does not contain the check-job definitions");
		t.skip("paired server checkout unavailable; set DEVSPEC_V2_ROOT"); return;
	}
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const jiti = createJiti(resolve(root, "pi-check-job-contract-probe.mjs"), { fsCache: false, moduleCache: false, alias: { "@devspec/core": resolve(root, "packages/core/src"), "@": resolve(root, "apps/web") } });
	const server = await jiti.import(resolve(root, relative)) as {
		CHECK_JOB_VERSION: number;
		CHECK_JOB_VERSIONS: readonly number[];
		CHECK_JOB_WAKE_KEYS: Record<number, readonly string[]>;
		CHECK_JOB_RECORD_TYPES_BY_VERSION: Record<number, readonly string[]>;
	};
	assert.equal(CHECK_JOB_VERSION, server.CHECK_JOB_VERSION, "Pi negotiates the server's current version");
	const value: Record<string, unknown> = {
		id: "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11", kind: "check_job", check_job_id: "3f0c1e9a-6b1d-4d55-9a0e-2a7c4b8d1e11",
		check_kind: "staleness", record: { type: "task", id: "9b2d6c1e-1111-4222-8333-444455556666", title: "T" },
		entries: 2, high_risk: 0, yours: false, offered_at: "2026-11-07T20:00:00.000Z", delivery_connection_id: "conn-1",
	};
	const shaped = (version: number) => Object.fromEntries(server.CHECK_JOB_WAKE_KEYS[version]!.map((key) => [key, value[key]]));
	assert.equal(isCheckJobEnvelope(shaped(CHECK_JOB_VERSION)), true, "the server's version-2 keys");
	for (const older of server.CHECK_JOB_VERSIONS.filter((version) => version < CHECK_JOB_VERSION)) {
		assert.equal(isCheckJobEnvelope(shaped(older)), false, `a version-${older} envelope is not what Pi negotiated`);
	}
	const everyRecord = server.CHECK_JOB_VERSIONS.filter((version) => version <= CHECK_JOB_VERSION).flatMap((version) => server.CHECK_JOB_RECORD_TYPES_BY_VERSION[version]!);
	for (const type of everyRecord) {
		const job = { ...shaped(CHECK_JOB_VERSION), record: { type, id: "9b2d6c1e-1111-4222-8333-444455556666", title: "T" } };
		assert.equal(isCheckJobEnvelope(job), true, type);
	}
});
