/**
 * DevSpec Pi — resume/duplicate recovery for deferred tool activation
 * (DevSpec item dc8f52d4).
 *
 * Per-process activation state and the transcript's permanent addedToolNames
 * announcements diverge across a resume: session_start rebuilds the hot set,
 * but every announcement stays in history. Pi's Kimi deferred-tools serializer
 * (openai-completions, deferredToolsMode "kimi") re-injects a full tool
 * definition after EVERY toolResult group in history that announced tools, so
 * a tool announced twice in one transcript reaches the provider wire twice —
 * the request hard-fails ("duplicate tool names are not allowed") and every
 * later turn re-renders the same history, bricking the session. Two defences:
 *
 *  1. scanTranscriptToolState — on session_start, restore exactly the rare
 *     tools the current branch already announced (minus recorded recoveries),
 *     so the loader reports them "already active" instead of re-announcing.
 *     Fresh sessions have announced nothing, so the happy path is untouched.
 *     Restoring also keeps Kimi-mode mid-history injections byte-identical
 *     across a resume instead of silently re-rendering them.
 *  2. planDuplicateRecovery — if a duplicate-tools provider error still occurs
 *     (e.g. a transcript poisoned before this fix), the named tools are
 *     deactivated for the session. Kimi-mode injections resolve against the
 *     CURRENT tool set, so deactivation clears every copy on the next turn.
 *
 * The serializer-side fix (dedupe injected names per request, subtract called
 * tools) belongs upstream in Pi — see the follow-up item linked from
 * dc8f52d4. This module is the extension-side compensation.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Session-persisted custom entry type recording recovery denials. */
export const RECOVERY_ENTRY_TYPE = "devspec-tool-recovery";

/** Fireworks/OpenAI-compatible rejection observed in the wild (item dc8f52d4). */
export const DUPLICATE_TOOL_NAMES_PATTERN =
	/duplicate tool names are not allowed:\s*\[([^\]]*)\]/i;

/** Parse `['a', 'b']` / `["a"]` name lists out of a provider error message. */
export function parseDuplicateToolNames(message: string): string[] {
	const match = DUPLICATE_TOOL_NAMES_PATTERN.exec(message);
	if (!match) return [];
	const names: string[] = [];
	for (const part of match[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
		names.push(part[1] ?? part[2]);
	}
	return names;
}

export interface TranscriptToolState {
	/** Rare tools the branch has announced and not been denied — re-activate these. */
	restore: string[];
	/** Tools a previous recovery deactivated in this session. */
	denied: string[];
}

/**
 * Walk one branch of the transcript. Announcements come from toolResult
 * messages' addedToolNames (stamped by Pi core's tool wrapper); denials come
 * from custom entries written by the recovery path. Both are filtered through
 * `isRare` so only loader-managed verbs are ever restored.
 */
export function scanTranscriptToolState(
	entries: readonly SessionEntry[],
	isRare: (name: string) => boolean,
): TranscriptToolState {
	const announced: string[] = [];
	const announcedSeen = new Set<string>();
	const denied: string[] = [];
	const deniedSeen = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role !== "toolResult") continue;
			for (const name of message.addedToolNames ?? []) {
				if (typeof name !== "string" || !isRare(name) || announcedSeen.has(name)) continue;
				announcedSeen.add(name);
				announced.push(name);
			}
		} else if (entry.type === "custom" && entry.customType === RECOVERY_ENTRY_TYPE) {
			const list = (entry.data as { denied?: unknown } | undefined)?.denied;
			if (!Array.isArray(list)) continue;
			for (const name of list) {
				if (typeof name !== "string" || deniedSeen.has(name)) continue;
				deniedSeen.add(name);
				denied.push(name);
			}
		}
	}
	return { restore: announced.filter((name) => !deniedSeen.has(name)), denied };
}

/** Append previously announced tools missing from the active set; order-stable. */
export function withRestoredTools(active: readonly string[], restore: readonly string[]): string[] {
	if (restore.length === 0) return [...active];
	const seen = new Set(active);
	return [...active, ...restore.filter((name) => !seen.has(name))];
}

export interface DuplicateRecoveryPlan {
	names: string[];
	errorMessage: string;
}

/**
 * Decide which tools to deactivate after a duplicate-tools provider error.
 * Only catalog tools that are currently active and not already denied are
 * actionable; a re-fired error whose names are all handled returns null so
 * the recovery path can never loop.
 */
export function planDuplicateRecovery(
	messages: readonly unknown[],
	opts: {
		isCatalogTool: (name: string) => boolean;
		isActive: (name: string) => boolean;
		isDenied: (name: string) => boolean;
	},
): DuplicateRecoveryPlan | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const errorMessage = (messages[index] as { errorMessage?: unknown } | null | undefined)
			?.errorMessage;
		if (typeof errorMessage !== "string" || !DUPLICATE_TOOL_NAMES_PATTERN.test(errorMessage)) {
			continue;
		}
		const names = parseDuplicateToolNames(errorMessage).filter(
			(name) => opts.isCatalogTool(name) && opts.isActive(name) && !opts.isDenied(name),
		);
		return names.length > 0 ? { names, errorMessage } : null;
	}
	return null;
}
