/**
 * DevSpec Pi — brand header.
 *
 * Shows the DevSpec duck when pi launches (TUI only; headless modes never
 * render a header). Toggle with /devspec.logo — persisted in
 * <pi-agent-dir>/devspec/brand.json.
 *
 * The duck is the DevSpec mark (rubber-duck debugging). Colors are 24-bit
 * ANSI emitted directly: theme.fg() only exposes named palette slots, and
 * "duck yellow" is not a palette slot.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devspecDir } from "./core/config.ts";

const YELLOW = "\x1b[38;2;255;209;60m";
const ORANGE = "\x1b[38;2;247;147;26m";
const DARK = "\x1b[38;2;40;30;20m";
const TEAL = "\x1b[38;2;45;212;191m"; // brightened #0F766E brand teal for terminal
const DIM = "\x1b[38;2;130;130;130m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function duckLines(): string[] {
	return [
		`${YELLOW}        ▄▄▄▄▄        ${RESET}`,
		`${YELLOW}      ▄███████▄      ${RESET}`,
		`${YELLOW}     ██${DARK}●${YELLOW}██████     ${RESET}`,
		`${ORANGE}▄▄${YELLOW} ███████████▄▄  ${RESET}`,
		`${ORANGE}██▄${YELLOW}▄█████████████▄ ${RESET}`,
		`${ORANGE} ▀▀${YELLOW}███████████████ ${RESET}`,
		`${YELLOW}      ▀█████████▀   ${RESET}`,
		`${YELLOW}        ▀▀▀▀▀▀      ${RESET}`,
	];
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
		render(_width: number): string[] {
			const wordmark = `${TEAL}${BOLD}DevSpec${RESET}${DIM} · where conversations become shipped code${RESET}`;
			const subtitle = `${DIM}on pi v${VERSION} · /devspec.help${RESET}`;
			return [...duckLines(), wordmark, subtitle, ""];
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
