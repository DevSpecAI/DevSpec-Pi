import assert from "node:assert/strict";
import { test } from "node:test";
import { HEIGHT, renderDuck, visibleWidth, WIDTH } from "../extensions/core/duck.ts";
import { renderHeader, TAGLINE } from "../extensions/devspec-brand.ts";

test("every rendered line of the mark is exactly WIDTH columns", () => {
	const lines = renderDuck();
	assert.equal(lines.length, HEIGHT);
	for (const [i, line] of lines.entries()) {
		assert.equal(visibleWidth(line), WIDTH, `line ${i} is not ${WIDTH} columns`);
	}
});

test("the mark uses only half-block glyphs — no ambiguous-width characters", () => {
	// `●` and friends are East-Asian Ambiguous width: double-wide on terminals
	// configured for CJK, which shears the row. Only these four are safe.
	const allowed = new Set([" ", "▀", "▄", "█"]);
	for (const line of renderDuck()) {
		for (const ch of line.replace(/\x1b\[[0-9;]*m/g, "")) {
			assert.ok(allowed.has(ch), `unexpected glyph ${JSON.stringify(ch)}`);
		}
	}
});

test("no line leaves a background colour set at its end", () => {
	// A dangling background bleeds across the rest of the terminal row.
	for (const line of renderDuck()) {
		assert.ok(line.endsWith("\x1b[0m"), "line does not end with a reset");
	}
});

test("wide terminals get the side-by-side lockup", () => {
	const lines = renderHeader(120);
	assert.equal(lines.length, HEIGHT + 1); // mark + trailing blank, text sits beside
	const withText = lines.filter((l) => l.includes("DevSpec"));
	assert.equal(withText.length, 1);
	assert.ok(withText[0]!.includes(TAGLINE));
});

test("mid-width terminals stack the wordmark under the mark", () => {
	const lines = renderHeader(WIDTH + 4);
	assert.equal(lines.length, HEIGHT + 3); // mark + wordmark + subtitle + blank
	assert.ok(lines.some((l) => l.includes("DevSpec")));
});

test("terminals too narrow for the mark drop it rather than wrap it", () => {
	const lines = renderHeader(WIDTH - 1);
	assert.equal(lines.length, 3); // wordmark + subtitle + blank
	assert.ok(lines[0]!.includes("DevSpec"));
	// The tagline does not fit either, so it is dropped.
	assert.ok(!lines[0]!.includes(TAGLINE));
});

test("no header line ever exceeds the terminal width", () => {
	for (const width of [12, 21, 22, 30, 60, 72, 73, 120, 200]) {
		for (const line of renderHeader(width)) {
			assert.ok(
				visibleWidth(line) <= width,
				`width ${width}: line of ${visibleWidth(line)} columns overflows`,
			);
		}
	}
});
