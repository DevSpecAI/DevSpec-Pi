/**
 * The vendored launcher is a pinned snapshot, not a fork.
 *
 * Up to seven plugin repos carry a copy of the DevSpec launcher, with deliberately
 * no sync tooling between them. That is only safe because every copy is written by
 * the launcher's release step and pinned by digest — so this test recomputes the
 * digests and fails the moment someone edits the copy here instead of at source
 * (ADR 8ced3e43, D2; item 27b53001).
 *
 * If this fails: do not fix the file. Fix it in DevSpecAI/DevSpec-Launcher and
 * re-run `node scripts/vendor.mjs <this-repo>/launcher` there.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER_DIR = fileURLToPath(new URL("../launcher", import.meta.url));
const MANIFEST_NAME = "LAUNCHER-MANIFEST.json";

type Manifest = { version: string; files: Record<string, string> };

function manifest(): Manifest {
	return JSON.parse(readFileSync(join(LAUNCHER_DIR, MANIFEST_NAME), "utf8")) as Manifest;
}

function digest(name: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(join(LAUNCHER_DIR, name))).digest("hex")}`;
}

describe("vendored DevSpec launcher", () => {
	it("carries a version", () => {
		assert.match(manifest().version, /^\d+\.\d+\.\d+$/);
	});

	it("matches its manifest digest for every file", () => {
		const { files } = manifest();
		const drifted = Object.keys(files).filter((name) => digest(name) !== files[name]);
		assert.deepEqual(drifted, [], `hand-edited in this repo: ${drifted.join(", ")}`);
	});

	it("has no file on disk that the manifest does not list", () => {
		const { files } = manifest();
		const extra = readdirSync(LAUNCHER_DIR)
			.filter((name) => name !== MANIFEST_NAME)
			.filter((name) => !(name in files));
		assert.deepEqual(extra, [], `untracked files in the vendored copy: ${extra.join(", ")}`);
	});

	it("ships the entry points the first-run install needs", () => {
		const { files } = manifest();
		for (const required of ["ensure.mjs", "open-handler.mjs", "open-handler-core.mjs"]) {
			assert.ok(required in files, `missing ${required}`);
		}
	});

	it("brings no npm dependency in with it", () => {
		const { files } = manifest();
		for (const name of Object.keys(files).filter((f) => f.endsWith(".mjs"))) {
			const src = readFileSync(join(LAUNCHER_DIR, name), "utf8");
			const foreign = [...src.matchAll(/^import\s[^'"]*from\s+["']([^"']+)["']/gm)]
				.map((m) => m[1])
				.filter((spec) => !spec.startsWith("node:") && !spec.startsWith("."));
			assert.deepEqual(foreign, [], `${name} imports ${foreign.join(", ")}`);
		}
	});
});
