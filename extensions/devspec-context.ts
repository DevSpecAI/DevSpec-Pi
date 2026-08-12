/**
 * DevSpec Pi — context injection (Phase 3).
 *
 * Appends the DevSpec workflow block to the system prompt on every turn via
 * before_agent_start, but only when a DevSpec token resolves (logged-out
 * sessions stay pristine). Local file read only — no network per turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveToken } from "./core/auth-store.ts";
import { buildDevspecInstructions } from "./core/instructions.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, _ctx) => {
		const resolved = await resolveToken();
		if (!resolved) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildDevspecInstructions()}` };
	});
}
