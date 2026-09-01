/**
 * Strict top-level still_to_discuss projection on changed poll_connection packages.
 * This session only. Advisory read-awareness; never a maintain instruction.
 */

export const STILL_TO_DISCUSS_PROJECTION_VERSION = 1 as const;
export const STILL_TO_DISCUSS_MAX_ROWS = 16;
export const STILL_TO_DISCUSS_MAX_TITLE_CHARS = 200;
/** Server slices the body to 160 then appends … (item 54902803: 161 chars deafened Bounding Lynx). */
export const STILL_TO_DISCUSS_MAX_PREVIEW_CHARS = 161;
export const STILL_TO_DISCUSS_AUTHORITY_NOTE =
	"This session only. Advisory read-awareness. Do not add, strike, or reopen unless the human asked." as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StillToDiscussRowProjection {
	id: string;
	title: string;
	state: "open" | "discussed";
	preview: string;
}

export interface StillToDiscussProjectionV1 {
	version: typeof STILL_TO_DISCUSS_PROJECTION_VERSION;
	advisory: true;
	authority_note: typeof STILL_TO_DISCUSS_AUTHORITY_NOTE;
	truncated: boolean;
	rows: StillToDiscussRowProjection[];
}

type Row = Record<string, unknown>;

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function record(value: unknown, path: string): Row {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
	return value as Row;
}

function exactKeys(value: Row, keys: readonly string[], path: string): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail(path, `expected exactly ${expected.join(", ")}`);
	}
}

function boundedString(value: unknown, path: string, max: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) {
		fail(path, `expected ${allowEmpty ? "string" : "non-empty string"} <= ${max} characters`);
	}
	return value;
}

function uuid(value: unknown, path: string): string {
	const parsed = boundedString(value, path, 64);
	if (!UUID_RE.test(parsed)) fail(path, "expected UUID");
	return parsed;
}

export function parseStillToDiscussProjection(value: unknown, path = "still_to_discuss"): StillToDiscussProjectionV1 {
	const row = record(value, path);
	exactKeys(row, ["version", "advisory", "authority_note", "truncated", "rows"], path);
	if (row.version !== STILL_TO_DISCUSS_PROJECTION_VERSION) fail(`${path}.version`, "expected 1");
	if (row.advisory !== true) fail(`${path}.advisory`, "expected true");
	if (row.authority_note !== STILL_TO_DISCUSS_AUTHORITY_NOTE) fail(`${path}.authority_note`, "unexpected note");
	if (typeof row.truncated !== "boolean") fail(`${path}.truncated`, "expected boolean");
	if (!Array.isArray(row.rows) || row.rows.length > STILL_TO_DISCUSS_MAX_ROWS) {
		fail(`${path}.rows`, `expected array of at most ${STILL_TO_DISCUSS_MAX_ROWS}`);
	}
	const rows = row.rows.map((item, index) => {
		const nested = `${path}.rows[${index}]`;
		const card = record(item, nested);
		exactKeys(card, ["id", "title", "state", "preview"], nested);
		let state: "open" | "discussed";
		if (card.state === "discussed") state = "discussed";
		else if (card.state === "open") state = "open";
		else fail(`${nested}.state`, "expected open or discussed");
		return {
			id: uuid(card.id, `${nested}.id`),
			title: boundedString(card.title, `${nested}.title`, STILL_TO_DISCUSS_MAX_TITLE_CHARS),
			state,
			preview: boundedString(card.preview, `${nested}.preview`, STILL_TO_DISCUSS_MAX_PREVIEW_CHARS, true),
		};
	});
	return {
		version: STILL_TO_DISCUSS_PROJECTION_VERSION,
		advisory: true,
		authority_note: STILL_TO_DISCUSS_AUTHORITY_NOTE,
		truncated: row.truncated,
		rows,
	};
}

export function serializeStillToDiscussProjection(projection: StillToDiscussProjectionV1 | null | undefined): string {
	if (!projection || projection.rows.length === 0) return "";
	const lines = ["== STILL TO DISCUSS ==", projection.authority_note];
	for (const row of projection.rows) {
		lines.push(`- ${row.state}: ${row.title} (${row.id})`);
		if (row.preview) lines.push(`  ${row.preview}`);
	}
	if (projection.truncated) {
		lines.push("List is bounded; older rows on this session are omitted.");
	}
	return lines.join("\n");
}
