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

/** Extra block while this session is bonded as remote capacity. */
function buildBondedInstructions(): string | null {
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
		...(bond.ownerName
			? [`The person you work for is ${bond.ownerName} — address them by name; "the owner" is a structural role, not a way to talk about them.`]
			: []),
		"Messages prefixed [DevSpec remote — message from ...] are owner instructions delivered via the bond.",
		"Answer them with post_session_message (connection_id defaults to your bond) — you are the sole content authority: pass complete_turn:true on the FINAL answer, use phase:'trail' for mid-turn progress, and never post status chrome as messages.",
	];
	const tiers = bond.instructions ?? {};
	if (tiers.project_custom_instructions) lines.push(`Project principles: ${tiers.project_custom_instructions}`);
	if (tiers.project_agent_rules) lines.push(`Project agent rules (mandatory): ${tiers.project_agent_rules}`);
	if (tiers.owner_custom_instructions) lines.push(`Owner style: ${tiers.owner_custom_instructions}`);
	if (tiers.owner_agent_rules) lines.push(`Owner machine rules: ${tiers.owner_agent_rules}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	// The room digest is a one-shot orientation message: injected once per
	// session instance, the first turn after the pump's cold-start sync.
	let digestInjected = false;
	// The attach-time bond context (item 9dcbd157) is one-shot PER ATTACH —
	// re-attaching to a different room must inject its block again, so track
	// the injected block, not a boolean.
	let injectedAttachContext: string | null = null;

	pi.on("before_agent_start", async (event, _ctx) => {
		const resolved = await resolveToken();
		if (!resolved) return undefined;
		let prompt = `${event.systemPrompt}\n\n${buildDevspecInstructions()}`;
		const bonded = buildBondedInstructions();
		if (bonded) prompt += `\n\n### DevSpec remote (bonded)\n${bonded}`;

		const bond = getBond();
		if (bond?.attachContext && bond.attachContext !== injectedAttachContext) {
			injectedAttachContext = bond.attachContext;
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
