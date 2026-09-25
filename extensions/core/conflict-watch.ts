/** R7: local observations, not a second project issue ledger. */
import { permittedDisagreement, reviewData, row, snapshotHash } from "./review-context.ts";
import { writeOutcomeFromResult } from "./trail-events.ts";

export interface ConflictFlag {
	key: string;
	kind: "item_conflict" | "related_candidates" | "write_gate" | "memory_conflict";
	label: string;
	scope?: string;
	/** Complete pair identity and exact observed evidence, never counterpart alone. */
	subject?: string;
	counterpart?: string;
	signal?: string;
	revision?: string;
	operation?: string;
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

/** Exclude attribution/confirmation, never semantic fields, from a write's identity. */
function operationKey(tool: string, args: Record<string, unknown>): string {
	const excluded = new Set(["confirm_new", "provenance_ref", "work_claim_ref", "connection_id", "session_id", "local_session_id", "provider", "git_remote", "project_id", "pinned_project_id"]);
	return snapshotHash([tool, Object.fromEntries(Object.entries(args).filter(([key]) => !excluded.has(key)))]);
}
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

export function extractFlags(toolName: string, details: unknown, scope = "legacy", args: Record<string, unknown> = {}): ConflictFlag[] {
	const d = row(details);
	if (!d) return [];
	const flags: ConflictFlag[] = [];
	const subject = text(d.id) ?? text(d.action_item_id) ?? text(args.action_item_id) ?? text(args.id);
	const operation = operationKey(toolName, args);
	for (const value of Array.isArray(d.unresolved_conflicts) ? d.unresolved_conflicts : []) {
		const c = row(value);
		if (!c) continue;
		const counterpart = text(c.conflicting_item_id) ?? text(c.item_id);
		if (!subject || !counterpart) continue; // Never merge unidentified pairs into "unknown".
		flags.push({ key: snapshotHash([scope, "item_conflict", ...[subject, counterpart].sort()]), scope,
			kind: "item_conflict", subject, counterpart, revision: snapshotHash(c),
			label: reviewData({ subject, counterpart, context: "Incomplete historical observation; use get_action_item to read both current permitted records." }) });
	}
	for (const value of Array.isArray(d.unresolved_disagreements) ? d.unresolved_disagreements : []) {
		const c = row(value);
		if (!c || !text(c.key)) continue;
		const safe = permittedDisagreement(c);
		flags.push({ key: snapshotHash([scope, "issue", c.key]), scope, kind: "memory_conflict",
			subject: text(row(c.subject)?.id), counterpart: text(row(c.counterpart)?.id), signal: text(c.claimType),
			revision: snapshotHash(safe), label: reviewData({ key: c.key, status: c.status,
				context: "Incomplete historical observation; use get_review_queue with this key for current permitted claims. A record that cannot be read is not expanded here." }) });
	}
	if (d.reconcile_required === true) {
		const match = row(d.closest_match);
		flags.push({ key: snapshotHash([scope, "write_gate", operation]), scope, kind: "write_gate", operation,
			revision: snapshotHash(match), label: reviewData({ write: toolName, status: "not written", closest_match: { id: match?.id, version: match?.version },
				next: "Re-read the matched record for current permitted context, then follow the served reconciliation contract." }) });
	}
	// Retrieval suggestions are not established conflicts, nor obligatory rulings.
	for (const key of ["related_candidates", "potential_conflicts"] as const) {
		if (key === "related_candidates" && toolName !== "create_action_item") continue;
		const candidates = d[key];
		if (!Array.isArray(candidates) || !candidates.length) continue;
		flags.push({ key: snapshotHash([scope, "suggestions", operation, subject, key]), scope, kind: "related_candidates", operation,
			revision: snapshotHash(candidates), label: reviewData({ tool: toolName, suggestions: candidates.length,
				meaning: "Retrieval candidates only; not a project-conflict count. Read relevant records before judging." }) });
	}
	// Search/read list wrappers carry the same canonical disagreements as exact reads.
	for (const key of ["memories", "results", "items", "resources", "artifacts"] as const) {
		if (Array.isArray(d[key])) for (const value of d[key]) flags.push(...extractFlags(toolName, value, scope, args));
	}
	return flags;
}

/** Only exact successful operations discharge their own checks/rulings. */
export function observeReviewResult(tool: string, details: unknown, args: Record<string, unknown>, scope: string, observed: readonly ConflictFlag[] = []): void {
	const d = row(details);
	if (!d) return;
	if (writeOutcomeFromResult(d) === "committed") {
		const operation = operationKey(tool, args);
		const unchanged = () => listFlags(scope).filter((f) => observed.some((old) => old.key === f.key && old.revision === f.revision));
		for (const f of unchanged()) {
			// A committed identical write is the existing server's comparison-completion
			// receipt. Unrelated writes, changed text and proposals cannot discharge it.
			if (f.kind === "write_gate" && f.operation === operation) clearFlag(f.key);
		}
		const subject = text(args.action_item_id) ?? text(args.id) ?? text(args.memory_id);
		const counterpart = text(args.counterpart_item_id) ?? text(args.conflicting_id) ?? text(args.decision_memory_id);
		const marks = row(d.marks_cleared);
		const cleared = marks && Object.values(marks).some((value) => typeof value === "number" && value > 0);
		const warnings = Array.isArray(d.warnings) && d.warnings.length > 0;
		if (tool.startsWith("resolve_") && args.verdict !== "discuss" && cleared && !warnings && d.closure !== "pending") {
			for (const f of unchanged()) {
				const exactPair = subject && ((f.subject === subject && f.counterpart === counterpart)
					|| (counterpart && f.subject === counterpart && f.counterpart === subject));
				if (exactPair && (!f.signal || f.signal === args.signal_type) && f.kind !== "write_gate" && f.kind !== "related_candidates") clearFlag(f.key);
			}
		}
	}
	addFlags(extractFlags(tool, d, scope, args));
}

export function formatConflictNudge(flags: ConflictFlag[]): string | null {
	if (!flags.length) return null;
	const issues = flags.filter((f) => f.kind === "item_conflict" || f.kind === "memory_conflict");
	const checks = flags.filter((f) => f.kind === "write_gate");
	const suggestions = flags.filter((f) => f.kind === "related_candidates");
	const lines = ["### DevSpec — observed Review context",
		`${issues.length} unresolved issue observation(s); ${checks.length} incomplete write check(s); ${suggestions.length} retrieval suggestion set(s). These are observations in this scope, not project totals.`,
		"Use live records and the served authority contract. Candidates are not conflicts; finishing a session does not settle issues."];
	let shown = 0;
	for (const flag of [...issues, ...checks, ...suggestions]) {
		if (lines.join("\n").length + flag.label.length > 6_000) continue;
		lines.push(flag.label); shown++;
	}
	if (shown < flags.length) lines.push(`Incomplete context: ${flags.length - shown} observation(s) omitted. Use get_review_queue for current permitted issues or re-read the originating record; no omitted issue is settled.`);
	return lines.join("\n");
}
