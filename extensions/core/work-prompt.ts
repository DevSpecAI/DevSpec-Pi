/**
 * DevSpec Pi — explicitly selected work delivery (pure, unit-tested).
 *
 * The command resolves the selected item and mechanically loads the product
 * contract. This formatter carries only work and contract identity, the contract
 * itself, and the selected item payload. It does not maintain a second
 * implementation workflow in prose, and there is no execution mode to carry.
 */

import {
	buildImplementationKickoff,
	formatImplementationContext,
	formatImplementationKickoffHeader,
	type ImplementationContractContext,
} from "./implementation-contract.ts";

export interface WorkTarget {
	id: string;
	title?: string;
	/** Full get_task payload. */
	payload: unknown;
}

export function buildWorkPrompt(
	item: WorkTarget,
	context: ImplementationContractContext,
): string {
	const kickoff = buildImplementationKickoff({
		taskIds: [item.id],
		context,
	});
	return [
		formatImplementationKickoffHeader(kickoff),
		"",
		`Work DevSpec task ${item.id}${item.title ? ` — “${item.title}”` : ""}. This item was explicitly selected here.`,
		"",
		formatImplementationContext(context),
		"",
		"Selected item context:",
		"```json",
		JSON.stringify(item.payload, null, 2),
		"```",
	].join("\n");
}
