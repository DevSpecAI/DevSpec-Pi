/**
 * DevSpec Pi — explicit attended work delivery (pure, unit-tested).
 *
 * The command resolves the selected item and mechanically loads the product
 * contract. This formatter carries only work/mode/contract identity, the
 * effective contract, and the selected item payload. It does not maintain a
 * second implementation workflow in prose.
 */

import {
	buildImplementationKickoff,
	formatImplementationContext,
	formatImplementationKickoffHeader,
	type EffectiveImplementationContext,
} from "./implementation-contract.ts";

export interface WorkTarget {
	id: string;
	title?: string;
	/** Full get_action_item payload. */
	payload: unknown;
}

export function buildWorkPrompt(
	item: WorkTarget,
	context: EffectiveImplementationContext,
): string {
	const kickoff = buildImplementationKickoff({
		actionItemIds: [item.id],
		context,
	});
	return [
		formatImplementationKickoffHeader(kickoff),
		"",
		`Work DevSpec action item ${item.id}${item.title ? ` — “${item.title}”` : ""}. This is an explicit attended selection.`,
		"",
		formatImplementationContext(context),
		"",
		"Selected item context:",
		"```json",
		JSON.stringify(item.payload, null, 2),
		"```",
	].join("\n");
}
