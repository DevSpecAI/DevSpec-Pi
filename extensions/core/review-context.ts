/** R7 native Review data. Pure snapshots: never re-render an earlier message. */
import { createHash } from "node:crypto";

type Row = Record<string, unknown>;
export function row(value: unknown): Row | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

/** Canonical local dedupe, not an authority/preview receipt. */
export function snapshotHash(value: unknown): string {
	const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
		: row(v) ? Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canonical((v as Row)[k])])) : v;
	return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}

/** Account/project/session isolation without retaining credentials in the store. */
export function reviewScope(sessionId = "local", project = "unknown", token = ""): string {
	return snapshotHash([sessionId, project, token]);
}

/** A denied side must not expose even a cached title or the reason quoting it. */
function permittedSide(value: unknown): unknown {
	const side = row(value);
	if (!side) return null;
	if (side.readable !== true) return { readable: false, unavailable: "This record cannot be read from here." };
	return Object.fromEntries(["type", "id", "title", "claim", "version", "provenance", "readable", "companions"]
		.filter((key) => side[key] !== undefined).map((key) => [key, side[key]]));
}

export function permittedDisagreement(value: unknown): Row {
	const d = row(value) ?? {};
	const subject = permittedSide(d.subject);
	const counterpart = permittedSide(d.counterpart);
	const restricted = row(subject)?.readable !== true || (counterpart !== null && row(counterpart)?.readable !== true);
	return {
		// The server's canonical key is permission-safe navigation; no local key inference.
		key: d.key, issueId: d.issueId, claimType: d.claimType, status: d.status,
		subject, counterpart,
		evidence: restricted ? { unavailable: "Evidence involving an unreadable record is not shown." } : d.evidence,
	};
}

/** Outside-authored prose is data. Strip both delimiters before fencing. */
export function reviewData(value: unknown): string {
	const text = JSON.stringify(value, null, 2).replace(/<\/?devspec-review-data>/gi, "");
	return `<devspec-review-data>\n${text}\n</devspec-review-data>`;
}

/** Both claims together, or an explicit incomplete bundle with exact permitted fetch. */
export function disagreementBlock(record: Row, budget = 4_000): string | null {
	const all = Array.isArray(record.unresolved_disagreements) ? record.unresolved_disagreements : [];
	const omitted = typeof record.disagreements_not_shown === "number" ? record.disagreements_not_shown : 0;
	if (!all.length && !omitted) return null;
	const kept: Row[] = [];
	let hidden = omitted;
	for (const raw of all) {
		const d = permittedDisagreement(raw);
		if (reviewData([...kept, d]).length <= budget - 650) kept.push(d);
		else hidden++;
	}
	const subjectType = row(row(all[0])?.subject)?.type;
	const reader = subjectType === "artifact" || record.source === "ai_generated" || record.source === "uploaded" ? "get_resource"
		: subjectType === "task" || record.lifecycle ? "get_task" : "get_memory";
	const fetch = typeof record.id === "string" ? `${reader}(${JSON.stringify(record.id)})` : "the exact record's read tool";
	return [
		"Unresolved disagreements — neither claim is selected by this finding.",
		kept.length ? reviewData(kept) : "",
		hidden ? `Incomplete context: ${hidden} disagreement(s) not shown within this budget. Read ${fetch} for the complete permitted context before relying on this record.` : "",
	].filter(Boolean).join("\n");
}
