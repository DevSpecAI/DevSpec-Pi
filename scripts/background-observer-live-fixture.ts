/** Scripted provider plus a metadata-only command for a disposable staging check. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import scriptedProvider from "./background-observer-runtime-fixture.ts";
import { getBond } from "../extensions/core/bond-state.ts";

export default function (pi: ExtensionAPI) {
	scriptedProvider(pi);
	pi.registerCommand("observer-probe-status", {
		description: "Write metadata for this disposable runtime check",
		handler: async (_args, ctx) => {
			const bond = getBond();
			writeFileSync(join(process.env.BACKGROUND_PROBE_ROOT!, "runtime-status.json"), JSON.stringify({
				connectionId: bond?.connectionId, sessionId: bond?.sessionId, codename: bond?.codename,
				nativeSessionId: ctx.sessionManager.getSessionId(), idle: ctx.isIdle(), pendingMessages: ctx.hasPendingMessages(),
			}), { mode: 0o600 });
		},
	});
}
