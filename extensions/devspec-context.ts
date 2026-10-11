/**
 * DevSpec Pi — context injection (Phase 3).
 *
 * Appends the DevSpec workflow block to the system prompt on every turn via
 * before_agent_start, but only when a DevSpec token resolves (logged-out
 * sessions stay pristine). Local file read only — no network per turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { getBond } from "./core/bond-state.ts";
import { buildDevspecInstructions } from "./core/instructions.ts";
import { noteInjectedContext, noteStaticContextBudget } from "./core/context-budget.ts";
import { REPOSITORY_CONTEXT_MESSAGE, repositorySnapshotNeeded } from "./core/repository-context.ts";
import { INSTRUCTION_CONTEXT_MESSAGE, instructionContextMessage } from "./core/connection-context.ts";

/** Extra block while this session is bonded as remote capacity. Exported for unit tests (byte-stability pins). */
export function buildBondedInstructions(): string | null {
	const bond = getBond();
	if (!bond) return null;
	// Identity is named, never discovered (item 9dcbd157): the room's title +
	// id and the owner's name ride the bonded block, refreshed only on attach
	// transitions (and the slow title-retry), so the prompt stays byte-stable
	// between them — the prefix-cache rule is safe.
	const where = bond.sessionId
		? `, attached to session ${bond.sessionTitle ? `“${bond.sessionTitle}” ` : ""}(id ${bond.sessionId})`
		: ", sessionless";
	const lines = [
		`You are bonded to DevSpec as remote capacity (${bond.codename ?? bond.connectionId})${where}.`,
		// Single addressee rule (item 5987cc24): the sender of each command is who
		// gets addressed by name — never a bond/session "owner" title, which
		// collides whenever a shared session's participants differ from the
		// connection owner. Static text, so the prefix-cache rule still holds.
		`Address the sender of each command by name (the requester named on the turn); "the owner" is a structural role, not a way to talk about a person.`,
		"Messages prefixed [DevSpec remote — message from ...] are server-authorized remote commands delivered via the bond. Owner authority and delegated project scope differ; mutable runtime policy is served at devspec://product/remote-ingress-contract, and any delegated scope instruction is delivered with its exact command turn.",
		"Your conversational text is delivered to the DevSpec session mechanically — never call tools to post it yourself. For non-trivial work, begin with one concise user-facing sentence confirming what you understood and what you will do next before using tools; add another progress message only at a meaningful boundary (for example, delegating, starting a long check, or becoming blocked). Do not narrate individual tools. Finish with the canonical answer.",
		"If you need the requester before you can finish, ask with manage_directed_question and stop. The server ends Working unless you pass keep_turn because you still have work.",
	];
	// Mutable rule text is a persisted tail snapshot, not a rewritten system prefix.
	// Sender response style remains on its own per-command lane.
	lines.push("Project and owner rules arrive in DevSpec instruction-context snapshots; use the latest snapshot under the served implementation contract's precedence.");
	return lines.join("\n");
}

function serializedChars(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

function contentChars(values: unknown): number {
	if (!Array.isArray(values)) return 0;
	return values.reduce((sum, value) => sum + serializedChars(value), 0);
}

export default function (pi: ExtensionAPI) {
	// Independent of room attachment: sessionless agents need the same project facts.
	// Pi persists returned custom messages, so resume/reload reuses an identical snapshot.
	pi.on("before_agent_start", async (_event, ctx) => {
		const content = getBond()?.repositoryContext;
		if (!content || !repositorySnapshotNeeded(ctx.sessionManager.getBranch(), content)) return;
		return { message: { customType: REPOSITORY_CONTEXT_MESSAGE, content, display: false } };
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		const bond = getBond();
		if (!bond) return;
		const content = instructionContextMessage(bond);
		if (!repositorySnapshotNeeded(ctx.sessionManager.getBranch(), content, INSTRUCTION_CONTEXT_MESSAGE)) return;
		return { message: { customType: INSTRUCTION_CONTEXT_MESSAGE, content, display: false } };
	});
	// The room digest is a one-shot orientation message: injected once per
	// session instance, the first turn after the pump's cold-start sync.
	let digestInjected = false;
	// The attach-time bond context (item 9dcbd157) is one-shot PER ATTACH —
	// re-attaching to a different room must inject its block again, so track
	// the injected block, not a boolean.
	let injectedAttachContext: string | null = null;

	// One-shot means once per branch, not once per process: after the conversation
	// moves to a branch without them (the owner's Clear, item 6beb89c6, or /tree),
	// the next turn adds them again.
	pi.on("session_tree", (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const holds = (customType: string) => branch.some((entry) =>
			entry.type === "custom_message" && (entry as { customType?: string }).customType === customType);
		if (!holds("devspec-attach-context")) injectedAttachContext = null;
		if (!holds("devspec-room-orientation")) digestInjected = false;
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const resolved = await resolveToken();
		if (!resolved) return undefined;
		let prompt = `${event.systemPrompt}\n\n${buildDevspecInstructions()}`;
		const bonded = buildBondedInstructions();
		if (bonded) prompt += `\n\n### DevSpec remote (bonded)\n${bonded}`;

		const activeNames = new Set(pi.getActiveTools());
		const activeTools = pi.getAllTools().filter((tool) => activeNames.has(tool.name));
		const options = event.systemPromptOptions as { contextFiles?: unknown[]; skills?: unknown[] } | undefined;
		noteStaticContextBudget({
			systemPromptChars: prompt.length,
			activeToolCount: activeTools.length,
			activeToolDefinitionChars: serializedChars(activeTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: tool.promptGuidelines,
			}))),
			contextFileCount: options?.contextFiles?.length ?? 0,
			contextFileChars: contentChars(options?.contextFiles),
			skillCount: options?.skills?.length ?? 0,
			skillChars: contentChars(options?.skills),
		});

		const bond = getBond();
		if (bond?.attachContext && bond.attachContext !== injectedAttachContext) {
			injectedAttachContext = bond.attachContext;
			noteInjectedContext("attach", bond.attachContext.length);
			return {
				systemPrompt: prompt,
				message: {
					customType: "devspec-attach-context",
					content: bond.attachContext,
					display: false,
				},
			};
		}
		if (bond?.roomDigest && !digestInjected) {
			digestInjected = true;
			noteInjectedContext("roomDigest", bond.roomDigest.length);
			return {
				systemPrompt: prompt,
				message: {
					customType: "devspec-room-orientation",
					content: bond.roomDigest,
					display: false,
				},
			};
		}
		return { systemPrompt: prompt };
	});
}
