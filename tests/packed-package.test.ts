import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("npm package contains fail-open provenance runtime and no obsolete gate, tests, scripts, or .pi state", (t) => {
	const destination = mkdtempSync(join(tmpdir(), "devspec-pi-pack-"));
	t.after(() => rmSync(destination, { recursive: true, force: true }));
	const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})) as Array<{ filename: string; files: Array<{ path: string }> }>;
	assert.equal(packed.length, 1);
	const fileList = packed[0]!.files.map((file) => file.path);
	const files = new Set(fileList);
	for (const required of [
		"package.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		"extensions/devspec-provenance-assistance.ts",
		"extensions/core/work-state.ts",
		"extensions/core/git-observer.ts",
		"runtime/git-observer-shim.mjs",
		// The shim imports its stamping rules from beside itself (df71ab6c).
		"runtime/commit-stamp.mjs",
		// ...and what every DevSpec stand-in agrees on (80bceb2c).
		"runtime/git-stand-in.mjs",
		"extensions/core/commit-stamp.ts",
		"extensions/generated/mcp-catalog.ts",
	]) assert.equal(files.has(required), true, `${required} missing from packed npm package`);
	assert.equal(files.has("extensions/devspec-mutation-gate.ts"), false);
	assert.equal(files.has("extensions/core/claim-authority.ts"), false);

	const forbidden = fileList.filter(
		(path) =>
			path.startsWith("tests/") ||
			path.startsWith("scripts/") ||
			path.startsWith(".pi/") ||
			path.startsWith(".github/") ||
			path === "tsconfig.json",
	);
	assert.deepEqual(forbidden, [], `Unexpected non-runtime files in packed tarball: ${forbidden.join(", ")}`);
});
