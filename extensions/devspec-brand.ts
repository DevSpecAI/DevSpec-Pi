/**
 * DevSpec Pi — brand header.
 *
 * Shows the DevSpec duck when pi launches (TUI only; headless modes never
 * render a header). Toggle with /devspec.logo — persisted in
 * <pi-agent-dir>/devspec/brand.json.
 *
 * The duck itself lives in core/duck.ts. This module only lays it out: the
 * wordmark sits beside the mark when there is room for a lockup, drops below it
 * when there isn't, and the mark is dropped entirely on a terminal too narrow
 * to hold it — art that wraps looks worse than no art.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devspecDir } from "./core/config.ts";
import { HEIGHT, renderDuck, WIDTH } from "./core/duck.ts";

const TEAL = "\x1b[38;2;45;212;191m"; // brightened #0F766E brand teal for terminal
const DIM = "\x1b[38;2;130;130;130m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Columns between the mark and the wordmark in the side-by-side lockup. */
const GAP = "  ";

const TAGLINE = "where conversations become shipped code";

/**
 * Pick the first rendering whose plain text fits `available` columns, or "" if
 * none does. Each candidate is [rendered-with-colour, plain-for-measuring].
 */
function fit(candidates: readonly (readonly [string, string])[], available: number): string {
	for (const [rendered, plain] of candidates) {
		if (plain.length <= available) return rendered;
	}
	return "";
}

/**
 * Wordmark + subtitle, each trimmed to what fits in `available` columns. Detail
 * is shed longest-first — the tagline goes before the name, the pi version
 * before the help hint — and a line that cannot fit at all comes back empty for
 * the caller to drop.
 */
function textLines(available: number): [string, string] {
	const wordmark = fit(
		[
			[`${TEAL}${BOLD}DevSpec${RESET}${DIM} · ${TAGLINE}${RESET}`, `DevSpec · ${TAGLINE}`],
			[`${TEAL}${BOLD}DevSpec${RESET}`, "DevSpec"],
		],
		available,
	);
	const subtitle = fit(
		[
			[`${DIM}on pi v${VERSION} · /devspec.help${RESET}`, `on pi v${VERSION} · /devspec.help`],
			[`${DIM}/devspec.help${RESET}`, "/devspec.help"],
		],
		available,
	);
	return [wordmark, subtitle];
}

/** Vertically centre the two text lines against the mark. */
const TEXT_ROW = Math.max(0, Math.floor((HEIGHT - 2) / 2));

export function renderHeader(width: number): string[] {
	if (width < WIDTH) {
		return [...textLines(width).filter(Boolean), ""];
	}

	const lines = renderDuck();
	const beside = Math.max(0, width - WIDTH - GAP.length);
	const [wordmark, subtitle] = textLines(beside);

	// Lockup: wordmark beside the mark, but only if the name itself fits there.
	if (wordmark) {
		lines[TEXT_ROW] = `${lines[TEXT_ROW]}${GAP}${wordmark}`;
		if (subtitle) lines[TEXT_ROW + 1] = `${lines[TEXT_ROW + 1]}${GAP}${subtitle}`;
		return [...lines, ""];
	}

	return [...lines, ...textLines(width).filter(Boolean), ""];
}

function brandFilePath(): string {
	return join(devspecDir(), "brand.json");
}

async function loadBrandPref(): Promise<boolean> {
	try {
		const raw = JSON.parse(await readFile(brandFilePath(), "utf8"));
		return raw.showHeader !== false; // default: show
	} catch {
		return true;
	}
}

async function saveBrandPref(showHeader: boolean): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(devspecDir(), { recursive: true });
	await writeFile(brandFilePath(), JSON.stringify({ showHeader }) + "\n");
}

function applyHeader(ctx: ExtensionContext, show: boolean): void {
	if (ctx.mode !== "tui") return;
	if (!show) {
		ctx.ui.setHeader(undefined);
		return;
	}
	ctx.ui.setHeader((_tui, _theme) => ({
		render(width: number): string[] {
			return renderHeader(width);
		},
		invalidate() {},
	}));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyHeader(ctx, await loadBrandPref());
	});

	pi.registerCommand("devspec.logo", {
		description: "Toggle the DevSpec duck header on startup.",
		handler: async (_args, ctx) => {
			const next = !(await loadBrandPref());
			await saveBrandPref(next);
			applyHeader(ctx, next);
			ctx.ui.notify(`DevSpec header ${next ? "on" : "off"}.`, "info");
		},
	});
}
