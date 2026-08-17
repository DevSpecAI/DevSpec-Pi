/**
 * DevSpec Pi — turn trail builder (pure, unit-tested).
 *
 * Renders the cumulative, terminal-style work trail for a turn from pi's
 * streaming events. Posted by the extension as phase:'trail' — fully
 * mechanical, zero tokens. The server grows ONE live bubble per turn and
 * preserves it as the collapsed "Show work" under the final answer.
 */

import {
	classifyDomainTool,
	domainIdentity,
	type DomainTrailEvent,
	type SubagentTrailChild,
	type SubagentTrailEvent,
	type TrailEvent,
	type ToolTrailEvent,
} from "./trail-events.ts";
import { projectTrailArgs, projectTrailResult, safeTrailLabel } from "./trail-projection.ts";
import type { SubagentFleetSnapshot } from "./subagent-fleet.ts";

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
	| { kind: "thinking"; text: string; seq: number; occurredAt: string }
	| { kind: "text"; text: string; seq: number }
	| { kind: "tool"; line: ToolLine; seq: number };

interface ToolLine {
	toolCallId: string;
	name: string;
	argsSummary?: string;
	identity: { id?: string; title?: string };
	open: boolean;
	ok?: boolean;
	resultSummary?: string;
	subagentChildren?: SubagentTrailChild[];
	subagentSummary?: string;
	startedAt: number;
	startedAtIso: string;
	completedAtIso?: string;
	durationMs?: number;
}

/** Privacy-safe one-line metadata selected for a known tool's arguments. */
export function summarizeArgs(name: string, args: unknown): string | undefined {
	return projectTrailArgs(name, args);
}

/** Privacy-safe outcome metadata selected for a known tool's result. */
export function summarizeResult(name: string, result: unknown): string | undefined {
	return projectTrailResult(name, result);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toolDetails(value: unknown): Record<string, unknown> | null {
	const record = asRecord(value);
	return asRecord(record?.details) ?? record;
}

function statusForChild(value: unknown): SubagentTrailChild["status"] {
	if (value === "running" || value === "completed" || value === "failed" || value === "pending" || value === "detached" || value === "stopped" || value === "paused") return value;
	if (value === "complete") return "completed";
	return "pending";
}

function isoFromMs(value: unknown): string | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? new Date(value).toISOString()
		: undefined;
}

function safeChildField(value: unknown, maxChars = 80): string | undefined {
	const label = safeTrailLabel(value, maxChars);
	return label && /^[A-Za-z0-9 ._:/@+-]+$/.test(label) ? label : undefined;
}

function safeThinkingLevel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "inherit"]).has(value)
		? value
		: undefined;
}

function subagentChildren(value: unknown): SubagentTrailChild[] {
	const details = toolDetails(value);
	if (!details) return [];
	const progress = Array.isArray(details.progress) ? details.progress : [];
	if (progress.length > 0) {
		return progress.slice(0, 24).flatMap((raw, index) => {
			const item = asRecord(raw);
			if (!item) return [];
			const agent = safeChildField(item.agent) ?? `Agent ${index + 1}`;
			const model = safeChildField(item.model, 120);
			const thinking = safeThinkingLevel(item.thinking);
			return [{
				key: typeof item.index === "number" ? String(item.index) : String(index),
				agent,
				status: statusForChild(item.status),
				...(model ? { model } : {}),
				...(thinking ? { thinking } : {}),
				...(isoFromMs(item.lastActivityAt) ? { lastActivityAt: isoFromMs(item.lastActivityAt) } : {}),
				...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
			} satisfies SubagentTrailChild];
		});
	}
	const completions = Array.isArray(details.completions) ? details.completions : [];
	if (completions.length > 0) {
		let childIndex = 0;
		return completions.slice(0, 24).flatMap((rawCompletion) => {
			const completion = asRecord(rawCompletion);
			if (!completion) return [];
			const results = Array.isArray(completion.results) ? completion.results : [];
			const candidates = results.length > 0 ? results : [completion];
			return candidates.flatMap((rawChild) => {
				const child = asRecord(rawChild);
				const agent = safeChildField(child?.agent);
				if (!child || !agent) return [];
				const rawState = child.success === false
					? "failed"
					: child.success === true
						? "completed"
						: completion.state;
				const status = statusForChild(rawState) === "pending" ? "completed" : statusForChild(rawState);
				const model = safeChildField(child.model, 120);
				return [{
					// Do not reuse completion.runId: terminal identity remains local to
					// pi-subagents. Order is enough inside this one terminal snapshot.
					key: `completed-${childIndex++}`,
					agent,
					status,
					...(model ? { model } : {}),
				} satisfies SubagentTrailChild];
			});
		});
	}
	const graph = asRecord(details.workflowGraph);
	const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
	return nodes.slice(0, 24).flatMap((raw, index) => {
		const item = asRecord(raw);
		if (!item) return [];
		const agent = safeChildField(item.agent) ?? safeChildField(item.label) ?? `Agent ${index + 1}`;
		const model = safeChildField(item.model, 120);
		const thinking = safeThinkingLevel(item.thinking);
		return [{
			key: String(index),
			agent,
			status: statusForChild(item.status),
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
		} satisfies SubagentTrailChild];
	});
}

/** Extract text, thinking, tool-call presence, and stopReason from an assistant message. */
export function extractAssistantParts(message: unknown): {
	text: string;
	thinking: string;
	hasToolCalls: boolean;
	stopReason: string | null;
} {
	const m = message as { content?: unknown; stopReason?: unknown } | null;
	const blocks = Array.isArray(m?.content) ? (m.content as Array<Record<string, unknown>>) : [];
	let text = "";
	let thinking = "";
	let hasToolCalls = false;
	for (const b of blocks) {
		if (b?.type === "text" && typeof b.text === "string") text += b.text;
		if (b?.type === "thinking" && typeof b.thinking === "string") thinking += b.thinking;
		if (b?.type === "toolCall") hasToolCalls = true;
	}
	const stopReason = typeof m?.stopReason === "string" ? m.stopReason : null;
	return { text, thinking, hasToolCalls, stopReason };
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
	private nextSeq = 1;

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
			(this.entries[this.curThinking] as { kind: "thinking"; text: string; seq: number }).text = t;
		} else {
			this.curThinking = this.entries.push({
				kind: "thinking",
				text: t,
				seq: this.nextSeq++,
				occurredAt: new Date().toISOString(),
			}) - 1;
		}
	}

	setText(text: string): void {
		const t = text.trim();
		if (!t) return;
		if (this.curText >= 0) {
			(this.entries[this.curText] as { kind: "text"; text: string; seq: number }).text = t;
		} else {
			this.curText = this.entries.push({ kind: "text", text: t, seq: this.nextSeq++ }) - 1;
		}
	}

	toolStart(toolCallId: string, name: string, args?: unknown): void {
		const startedAt = Date.now();
		this.entries.push({
			kind: "tool",
			seq: this.nextSeq++,
			line: {
				toolCallId,
				name,
				argsSummary: summarizeArgs(name, args),
				identity: domainIdentity(name, args),
				open: true,
				startedAt,
				startedAtIso: new Date(startedAt).toISOString(),
			},
		});
	}

	toolUpdate(toolCallId: string, partialResult: unknown): void {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e.kind === "tool" && e.line.toolCallId === toolCallId) {
				if (e.line.name === "subagent" || e.line.name === "subagent_wait") {
					const children = subagentChildren(partialResult);
					// subagent_wait currently streams human-readable status with an
					// empty details projection. Do not erase the independently sourced
					// public fleet snapshot on every textual progress update.
					if (children.length > 0) {
						e.line.subagentChildren = children;
						e.line.subagentSummary = undefined;
					}
				}
				return;
			}
		}
	}

	/** Overlay pi-subagents' public active-fleet projection onto an open wait. */
	applySubagentFleet(toolCallId: string, snapshot: SubagentFleetSnapshot): boolean {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e.kind !== "tool" || e.line.toolCallId !== toolCallId) continue;
			if (!e.line.open || e.line.name !== "subagent_wait") return false;
			e.line.subagentChildren = snapshot.children;
			e.line.subagentSummary = snapshot.summary;
			return true;
		}
		return false;
	}

	toolEnd(toolCallId: string, name: string, ok: boolean, result?: unknown): void {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const e = this.entries[i];
			if (e.kind !== "tool") continue;
			if (e.line.open && (e.line.toolCallId === toolCallId || e.line.name === name)) {
				const completedAt = Date.now();
				e.line.open = false;
				e.line.ok = ok;
				const resultIdentity = domainIdentity(name, undefined, result);
				e.line.identity = {
					id: resultIdentity.id ?? e.line.identity.id,
					title: resultIdentity.title ?? e.line.identity.title,
				};
				e.line.resultSummary = summarizeResult(name, result);
				if (name === "subagent" || name === "subagent_wait") {
					const children = subagentChildren(result);
					// A terminal tool result owns the terminal child projection. Clear
					// a prior active-only fleet snapshot when it provides no structured
					// children so a finished wait never leaves a child spinning.
					e.line.subagentChildren = children;
					e.line.subagentSummary = undefined;
				}
				e.line.durationMs = Math.max(0, completedAt - e.line.startedAt);
				e.line.completedAtIso = new Date(completedAt).toISOString();
				return;
			}
		}
	}

	isEmpty(): boolean {
		return this.entries.length === 0;
	}

	/** Typed events for the structured activity record. Assistant speech is deliberately excluded. */
	events(): TrailEvent[] {
		const out: TrailEvent[] = [];
		for (const e of this.entries) {
			if (e.kind === "thinking") {
				const flat = e.text.replace(/\n/g, " ");
				out.push({
					seq: e.seq,
					kind: "thinking",
					text: flat.length > 4_000 ? `${flat.slice(0, 4_000)}…` : flat,
					occurredAt: e.occurredAt,
				});
			} else if (e.kind === "text") {
				// Text is speech: progress/final messages belong only in the transcript.
				continue;
			} else {
				const status = e.line.open ? "running" : e.line.ok ? "ok" : "error";
				const timing = {
					occurredAt: e.line.startedAtIso,
					...(e.line.completedAtIso ? { completedAt: e.line.completedAtIso } : {}),
				};
				if (e.line.name === "subagent" || e.line.name === "subagent_wait") {
					const children = e.line.subagentChildren ?? [];
					const running = children.filter((child) => child.status === "running").length;
					const ev: SubagentTrailEvent = {
						seq: e.seq,
						kind: "subagent",
						name: e.line.name,
						status,
						children,
						...timing,
						...(e.line.subagentSummary
							? { summary: e.line.subagentSummary }
							: children.length > 0
								? { summary: running > 0 ? `${running} of ${children.length} agents active` : `${children.length} agents` }
								: {}),
						...(e.line.durationMs != null ? { durationMs: e.line.durationMs } : {}),
					};
					out.push(ev);
					continue;
				}
				const domain = classifyDomainTool(e.line.name);
				if (domain) {
					const ident = e.line.identity;
					const ev: DomainTrailEvent = {
						seq: e.seq,
						kind: "domain",
						correlationId: e.line.toolCallId,
						domain: domain.domain,
						action: domain.action,
						name: e.line.name,
						status,
						...timing,
					};
					if (ident.title) ev.title = ident.title;
					if (ident.id) ev.id = ident.id;
					if (!e.line.open && e.line.resultSummary) ev.result = e.line.resultSummary;
					if (e.line.durationMs != null) ev.durationMs = e.line.durationMs;
					out.push(ev);
				} else {
					const ev: ToolTrailEvent = {
						seq: e.seq,
						kind: "tool",
						correlationId: e.line.toolCallId,
						name: e.line.name,
						status,
						...timing,
					};
					if (e.line.argsSummary) ev.args = e.line.argsSummary;
					if (!e.line.open && e.line.resultSummary) ev.result = e.line.resultSummary;
					if (e.line.durationMs != null) ev.durationMs = e.line.durationMs;
					out.push(ev);
				}
			}
		}
		return out;
	}

	render(maxChars: number = MAX_TRAIL_CHARS, includeSpeech = true): string {
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
				if (includeSpeech) parts.push(e.text);
			} else {
				const t = e.line;
				const status = t.open ? "…" : t.ok ? "✔" : "✖";
				const safeIdentity = t.identity.title ?? t.identity.id;
				const summary = t.argsSummary ?? safeIdentity;
				const args = summary ? ` — \`${summary}\`` : "";
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
