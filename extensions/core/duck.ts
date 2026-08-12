/**
 * DevSpec Pi — the DevSpec mark, drawn for a terminal.
 *
 * The mark is a rubber duck (rubber-duck debugging). It is stored as a pixel
 * map, one character per pixel, and rendered with half-block glyphs so a single
 * terminal row carries TWO pixel rows: `▀` paints the top half, `▄` the bottom,
 * `█` both. Terminal cells are roughly twice as tall as they are wide, so this
 * makes the pixels come out square and the art keeps its proportions.
 *
 * To redraw the duck, edit PIXELS — it is the picture, at 1:1. Trailing blanks
 * are optional; every row is padded to WIDTH at render time so callers can rely
 * on each line occupying exactly WIDTH columns (the brand header sets the
 * wordmark beside the duck and needs that guarantee).
 *
 * Only `▀ ▄ █` and space are used. Glyphs like `●` are East-Asian *Ambiguous*
 * width and render double-wide on terminals configured for CJK, which shears
 * the row it sits in — do not reintroduce one.
 *
 * Colours are 24-bit ANSI emitted directly: pi's theme only exposes named
 * palette slots, and "duck yellow" is not a palette slot.
 */

/** Ink for each pixel character, as 24-bit ANSI "r;g;b" components. */
const INK: Record<string, string> = {
	Y: "255;209;60", // body yellow
	S: "231;172;32", // wing shade
	O: "247;147;26", // beak orange
	D: "40;30;20", //   eye
};

const BLANK = " ";
const RESET = "\x1b[0m";

/** The mark, one character per pixel. Two rows per rendered line. */
const PIXELS: readonly string[] = [
	"",
	"    YYYYYY",
	"   YYYYYYYY",
	"  YYYYDYYYY",
	"OOOOYYYYYYY",
	" OOOYYYYYYY",
	"   YYYYYYYY       YYY",
	"    YYYYYY  YYYYYYYYYY",
	"    YYYYYYYYYYYYYYYYYY",
	"     YYYYYYYYYYYYYYYY",
	"      YYYYYYYYYYSSSYY",
	"     YYYYSSSSSSSSSSYY",
	"     YYYYYSSSSSSSSYY",
	"      YYYYSSSSSSSYY",
	"       YYYYYYYYYYY",
	"         YYYYYY",
];

/** Columns each rendered line occupies. */
export const WIDTH = PIXELS.reduce((w, row) => Math.max(w, row.length), 0);

/** Rendered lines the mark occupies (two pixel rows per line). */
export const HEIGHT = Math.ceil(PIXELS.length / 2);

function pixelAt(row: string, column: number): string {
	return row[column] ?? BLANK;
}

/**
 * Render one line from a pair of pixel rows.
 *
 * Escape codes are only emitted when the colour actually changes, and the
 * background is cleared explicitly when leaving a two-tone cell — otherwise it
 * would bleed across the rest of the line.
 */
function renderPair(top: string, bottom: string): string {
	let out = "";
	let fg = "";
	let bg = "";

	for (let column = 0; column < WIDTH; column++) {
		const t = pixelAt(top, column);
		const b = pixelAt(bottom, column);

		let glyph = BLANK;
		let wantFg = "";
		let wantBg = "";

		if (t !== BLANK && b !== BLANK) {
			if (t === b) {
				glyph = "█";
				wantFg = INK[t] ?? "";
			} else {
				glyph = "▀";
				wantFg = INK[t] ?? "";
				wantBg = INK[b] ?? "";
			}
		} else if (t !== BLANK) {
			glyph = "▀";
			wantFg = INK[t] ?? "";
		} else if (b !== BLANK) {
			glyph = "▄";
			wantFg = INK[b] ?? "";
		}

		if (wantFg !== fg) {
			out += wantFg ? `\x1b[38;2;${wantFg}m` : "\x1b[39m";
			fg = wantFg;
		}
		if (wantBg !== bg) {
			out += wantBg ? `\x1b[48;2;${wantBg}m` : "\x1b[49m";
			bg = wantBg;
		}
		out += glyph;
	}

	return out + RESET;
}

/** The mark as HEIGHT lines, each exactly WIDTH columns wide. */
export function renderDuck(): string[] {
	const lines: string[] = [];
	for (let row = 0; row < PIXELS.length; row += 2) {
		lines.push(renderPair(PIXELS[row] ?? "", PIXELS[row + 1] ?? ""));
	}
	return lines;
}

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
