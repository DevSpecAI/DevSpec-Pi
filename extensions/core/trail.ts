/**
 * DevSpec Pi — turn trail builder (pure, unit-tested).
 *
 * Renders the cumulative, terminal-style work trail for a turn from pi's
 * streaming events. Posted by the extension as phase:'trail' — fully
 * mechanical, zero tokens. The server grows ONE live bubble per turn and
 * preserves it as the collapsed "Show work" under the final answer.
 */

/**
 * Render cap for one trail snapshot. The server folds sliding-window snapshots
 * on a 24-char tail anchor (item 95db8479), so a head-trimmed window merges
 * cleanly — UNLESS a single inter-post burst exceeds the whole window (the
 * anchor scrolls out and one overlap region appends). 12k makes that burst
 * rare while keeping each post cheap to carry.
 */
const MAX_TRAIL_CHARS = 12_000;

/** Cap for the FINAL render that rides the answer post (item 9b7455df). The
 *  server REPLACES the folded accumulation with it, so capping at the live
 *  12k would discard earlier rounds the fold had preserved — the trail is
 *  run-scoped now (cc9e8c43) and a long run accumulates many rounds. */
export const FINAL_TRAIL_CHARS = 48_000;

type TrailEntry =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "tool"; line: ToolLine };

interface ToolLine {
	name: string;
	argsSummary?: string;
	open: boolean;
	ok?: boolean;
	resultSummary?: string;
}

/** One-line summary of tool args for the trail (best-effort, readable). */
export function summarizeArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	if (Object.keys(a).length === 0) return undefined;
	for (const key of ["command", "path", "file_path", "query", "id", "action_item_id", "message", "url", "name"]) {
		const v = a[key];
		if (typeof v === "string" && v.trim()) {
			const oneLine = v.replace(/\s+/g, " ").trim();
			return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
		}
	}
	try {
		const json = JSON.stringify(a);
		return json.length > 90 ? `${json.slice(0, 90)}…` : json;
	} catch {
		return undefined;
	}
}

/** One-line summary of a tool result for the trail. */
export function summarizeResult(result: unknown): string | undefined {
	const r = result as { content?: Array<{ type?: string; text?: string }> } | null;
	const text = (r?.content ?? [])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return undefined;
	return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

/** Extract text + thinking from an assistant message (content blocks). */
export function extractAssistantParts(message: unknown): { text: string; thinking: string } {
	const m = message as { content?: unknown } | null;
	const blocks = Array.isArray(m?.content) ? (m.content as Array<Record<string, unknown>>) : [];
	let text = "";
	let thinking = "";
	for (const b of blocks) {
		if (b?.type === "text" && typeof b.text === "string") text += b.text;
		if (b?.type === "thinking" && typeof b.thinking === "string") thinking += b.thinking;
	}
	return { text, thinking };
}

/** Extract plain text from any message (user prompts included). */
export function extractText(message: unknown): string {
	const m = message as { content?: unknown } | null;
	if (typeof m?.content === "string") return m.content;
	const blocks = Array.isArray(m?.content) ? (m.content as Array<Record<string, unknown>>) : [];
	return blocks
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

/**
 * Run-scoped, CHRONOLOGICAL trail (item cc9e8c43). pi fires turn_start per
 * LLM round, and each round is its own assistant message — so thinking/text
 * accumulate as ordered entries, one pair per round, interleaved with the
 * tool lines they produced. Within a round, message_update deltas are
 * cumulative snapshots: they replace the round's OPEN entry in place, which
 * keeps every render a strict prefix of the next (9b7455df).
 */
export class TrailBuilder {
	private entries: TrailEntry[] = [];
	/** Indices of the in-flight round's thinking/text entries (-1 = none yet). */
	private curThinking = -1;
	private curText = -1;

	/**
	 * A new assistant message begins (message_start) — or the current one is
	 * final (message_end, after its content is applied). Either way the next
	 * delta belongs to a NEW round: reset the open entries so they append
	 * instead of replacing the previous round's. Wiring BOTH events means one
	 * of them firing is sufficient; neither firing degrades to the old
	 * replace-in-place behaviour (last round only), never a crash.
	 */
	beginAssistantMessage(): void {
		this.curThinking = -1;
		this.curText = -1;
	}

	/** Cumulative snapshots from message_update/message_end — replace the
	 *  CURRENT round's entry, never append to it. */
	setThinking(thinking: string): void {
		const t = thinking.trim();
		if (!t) return;
		if (this.curThinking >= 0) {
			(this.entries[this.curThinking] as { kind: "thinking"; text: string }).text = t;
		} else {
			this.curThinking = this.entries.push({ kind: "thinking", text: t }) - 1;
		}
	}

	setText(text: string): void {
		const t = text.trim();
		if (!t) return;
		if (this.curText >= 0) {
			(this.entries[this.curText] as { kind: "text"; text: string }).text = t;
		} else {
			this.curText = this.entries.push({ kind: "text", text: t }) - 1;
		}
	}

	toolStart(name: string, args?: unknown): void {
		this.entries.push({ kind: "tool", line: { name, argsSummary: summarizeArgs(args), open: true } });
	}

	toolEnd(name: string, ok: boolean, result?: unknown): void {
		// Close the most recent open tool entry with this name (parallel-safe enough).
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e.kind !== "tool") continue;
			if (e.line.open && e.line.name === name) {
				e.line.open = false;
				e.line.ok = ok;
				e.line.resultSummary = summarizeResult(result);
				return;
			}
		}
	}

	isEmpty(): boolean {
		return this.entries.length === 0;
	}

	render(maxChars: number = MAX_TRAIL_CHARS): string {
		const parts: string[] = [];
		for (const e of this.entries) {
			if (e.kind === "thinking") {
				// Prefix-stable by construction (item 9b7455df): no emphasis markers —
				// a closing '*' retracts on every thinking delta, which breaks the
				// cumulative-prefix merge server-side and duplicated the whole block.
				// The cap keeps the FIRST 800 chars with the ellipsis trailing, so a
				// growing trace is always a strict prefix of its next snapshot.
				const flat = e.text.replace(/\n/g, " ");
				const t = flat.length > 800 ? `${flat.slice(0, 800)}…` : flat;
				parts.push(`> 💭 ${t}`);
			} else if (e.kind === "text") {
				parts.push(e.text);
			} else {
				const t = e.line;
				const status = t.open ? "…" : t.ok ? "✔" : "✖";
				const args = t.argsSummary ? ` — \`${t.argsSummary}\`` : "";
				const res = !t.open && t.resultSummary ? ` → ${t.resultSummary}` : "";
				parts.push(`${status} \`${t.name}\`${args}${res}`);
			}
		}
		let out = parts.join("\n\n");
		if (out.length > maxChars) {
			out = `…\n\n${out.slice(-maxChars)}`;
		}
		return out;
	}
}
