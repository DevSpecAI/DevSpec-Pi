import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEVSPEC_DEBUG_LOG_PATH, formatDebugRecord } from "../extensions/core/debug.ts";

function typescriptFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return typescriptFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

test("debug diagnostics use a platform-native path and a closed metadata vocabulary", () => {
	assert.equal(DEVSPEC_DEBUG_LOG_PATH, join(tmpdir(), "devspec-remote-debug.log"));
	assert.equal(formatDebugRecord("recall", { queryChars: 80, newHits: 2 }), "recall queryChars=80 newHits=2");
	assert.equal(formatDebugRecord("recall", { queryChars: 80, prompt: "secret", dynamic_name: "secret" }), "recall queryChars=80");
	assert.equal(formatDebugRecord("secret prompt text", { queryChars: 80 }), null);
	assert.equal(formatDebugRecord("recall", { queryChars: Number.POSITIVE_INFINITY }), "recall");
	for (const path of typescriptFiles(join(process.cwd(), "extensions"))) {
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(source, /debugRemote\s*\(\s*`/, `${path} must use a fixed event label and numeric/boolean fields`);
		assert.doesNotMatch(source, /\/tmp\/devspec-remote-debug\.log/, `${path} must use os.tmpdir()`);
	}
});
