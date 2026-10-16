/** R7: local observations, not a second project issue ledger. */
import { permittedDisagreement, reviewData, row, snapshotHash } from "./review-context.ts";
import { writeOutcomeFromResult } from "./trail-events.ts";

export interface ConflictFlag {
	key: string;
	kind: "memory_conflict";
	label: string;
	scope?: string;
	/** Complete pair identity and exact observed evidence, never counterpart alone. */
	subject?: string;
	counterpart?: string;
	signal?: string;
	revision?: string;
}
const GLOBAL_KEY = "__devspecPiReviewObservationsV2";
function store(): Map<string, ConflictFlag> {
	const g = globalThis as unknown as Record<string, Map<string, ConflictFlag> | undefined>;
	return g[GLOBAL_KEY] ??= new Map();
}
export function listFlags(scope?: string): ConflictFlag[] {
	return [...store().values()].filter((f) => scope === undefined || f.scope === scope);
}
export function addFlags(flags: ConflictFlag[]): ConflictFlag[] {
	const changed: ConflictFlag[] = [];
	for (const f of flags) {
		if (snapshotHash(store().get(f.key)) !== snapshotHash(f)) {
			store().set(f.key, f);
			changed.push(f);
		}
	}
	return changed;
}
export function clearFlag(key: string): void { store().delete(key); }
export function clearAllFlags(): void { store().clear(); }

const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

export function extractFlags(toolName: string, details: unknown, scope = "legacy", args: Record<string, unknown> = {}): ConflictFlag[] {
	const d = row(details);
	if (!d) return [];
	const flags: ConflictFlag[] = [];
	for (const value of Array.isArray(d.unresolved_disagreements) ? d.unresolved_disagreements : []) {
		const c = row(value);
		if (!c || !text(c.key)) continue;
		const safe = permittedDisagreement(c);
		flags.push({ key: snapshotHash([scope, "issue", c.key]), scope, kind: "memory_conflict",
			subject: text(row(c.subject)?.id), counterpart: text(row(c.counterpart)?.id), signal: text(c.claimType),
			revision: snapshotHash(safe), label: reviewData({ key: c.key, status: c.status,
				context: "Incomplete historical observation; use get_review_queue with this key for current permitted claims. A record that cannot be read is not expanded here." }) });
	}
	// Search/read list wrappers carry the same canonical disagreements as exact reads.
	for (const key of ["memories", "results", "items", "resources", "artifacts"] as const) {
		if (Array.isArray(d[key])) for (const value of d[key]) flags.push(...extractFlags(toolName, value, scope, args));
	}
	return flags;
}

const FLAG_RULINGS = new Set(["resolve_memory_flag", "resolve_resource_flag"]);

/** Only exact successful rulings discharge their own observation. */
export function observeReviewResult(tool: string, details: unknown, args: Record<string, unknown>, scope: string, observed: readonly ConflictFlag[] = []): void {
	const d = row(details);
	if (!d) return;
	if (writeOutcomeFromResult(d) === "committed") {
		const unchanged = () => listFlags(scope).filter((f) => observed.some((old) => old.key === f.key && old.revision === f.revision));
		// A memory or document flag ruling names one record and one flag; only the
		// observation of exactly that flag on exactly that record is discharged.
		const subject = text(args.id);
		const marks = row(d.marks_cleared);
		const cleared = marks && Object.values(marks).some((value) => typeof value === "number" && value > 0);
		if (FLAG_RULINGS.has(tool) && subject && cleared) {
			for (const f of unchanged()) {
				if (f.kind === "memory_conflict" && f.subject === subject && !f.counterpart && (!f.signal || f.signal === args.signal_type)) clearFlag(f.key);
			}
		}
	}
	addFlags(extractFlags(tool, d, scope, args));
}

export function formatConflictNudge(flags: ConflictFlag[]): string | null {
	if (!flags.length) return null;
	const issues = flags.filter((f) => f.kind === "memory_conflict");
	const lines = ["### DevSpec — observed Review context",
		`${issues.length} unresolved issue observation(s). These are observations in this scope, not project totals.`,
		"Use live records and the served authority contract. Finishing a session does not settle issues."];
	let shown = 0;
	for (const flag of issues) {
		if (lines.join("\n").length + flag.label.length > 6_000) continue;
		lines.push(flag.label); shown++;
	}
	if (shown < flags.length) lines.push(`Incomplete context: ${flags.length - shown} observation(s) omitted. Use get_review_queue for current permitted issues or re-read the originating record; no omitted issue is settled.`);
	return lines.join("\n");
}
