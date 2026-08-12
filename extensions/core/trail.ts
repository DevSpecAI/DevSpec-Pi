/**
 * DevSpec Pi — turn trail builder (pure, unit-tested).
 *
 * Renders the cumulative, terminal-style work trail for a turn from pi's
 * streaming events. Posted by the extension as phase:'trail' — fully
 * mechanical, zero tokens. The server grows ONE live bubble per turn and
 * preserves it as the collapsed "Show work" under the final answer.
 */

const MAX_TRAIL_CHARS = 6000;

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

export class TrailBuilder {
	private thinking = "";
	private text = "";
	private tools: ToolLine[] = [];

	/** Cumulative snapshots from message_update — replace, don't append. */
	setThinking(thinking: string): void {
		this.thinking = thinking.trim();
	}

	setText(text: string): void {
		this.text = text.trim();
	}

	toolStart(name: string, args?: unknown): void {
		this.tools.push({ name, argsSummary: summarizeArgs(args), open: true });
	}

	toolEnd(name: string, ok: boolean, result?: unknown): void {
		// Close the most recent open line with this name (parallel-safe enough).
		for (let i = this.tools.length - 1; i >= 0; i--) {
			const t = this.tools[i];
			if (t.open && t.name === name) {
				t.open = false;
				t.ok = ok;
				t.resultSummary = summarizeResult(result);
				return;
			}
		}
	}

	isEmpty(): boolean {
		return !this.thinking && !this.text && this.tools.length === 0;
	}

	render(): string {
		const parts: string[] = [];
		if (this.thinking) {
			const t = this.thinking.length > 800 ? `…${this.thinking.slice(-800)}` : this.thinking;
			parts.push(`> 💭 *${t.replace(/\n/g, " ")}*`);
		}
		if (this.text) parts.push(this.text);
		for (const t of this.tools) {
			const status = t.open ? "…" : t.ok ? "✔" : "✖";
			const args = t.argsSummary ? ` — \`${t.argsSummary}\`` : "";
			const res = !t.open && t.resultSummary ? ` → ${t.resultSummary}` : "";
			parts.push(`${status} \`${t.name}\`${args}${res}`);
		}
		let out = parts.join("\n\n");
		if (out.length > MAX_TRAIL_CHARS) {
			out = `…\n\n${out.slice(-MAX_TRAIL_CHARS)}`;
		}
		return out;
	}
}
