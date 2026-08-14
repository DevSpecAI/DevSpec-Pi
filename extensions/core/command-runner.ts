/**
 * In-process access to Pi's command-context reload (item e82a690a).
 *
 * ctx.reload() exists only on ExtensionCommandContext. The pump/event ctx
 * is ExtensionContext and does not have it. sendUserMessage("/devspec.reload")
 * is not a substitute: it calls prompt({ expandPromptTemplates: false }) and
 * skips _tryExecuteExtensionCommand, so the slash becomes a user prompt.
 *
 * ExtensionRunner.createCommandContext() is the official factory the TUI
 * uses. We remember the live runner via the public bindCommandContext hook
 * (called on session_start and after every reload) and then call
 * createCommandContext().reload() — the same handleReloadCommand path.
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const GLOBAL_KEY = "__devspecPiExtensionRunner";

type RunnerLike = {
	createCommandContext?: () => { reload?: () => Promise<void> };
};

function store(): { current: RunnerLike | null } {
	const g = globalThis as unknown as Record<string, { current: RunnerLike | null } | undefined>;
	if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { current: null };
	return g[GLOBAL_KEY] as { current: RunnerLike | null };
}

let patched = false;

/** Install once per process. Safe to call from every extension file. */
export function rememberExtensionRunner(): void {
	if (patched) return;
	const proto = ExtensionRunner.prototype as unknown as {
		bindCommandContext?: (actions?: unknown) => void;
	};
	const original = proto.bindCommandContext;
	if (typeof original !== "function") return;
	patched = true;
	proto.bindCommandContext = function (this: RunnerLike, actions?: unknown) {
		store().current = this;
		return original.call(this, actions);
	};
}

export function commandReloadContext(): { reload?: () => Promise<void> } | null {
	const runner = store().current;
	if (!runner || typeof runner.createCommandContext !== "function") return null;
	try {
		return runner.createCommandContext();
	} catch {
		return null;
	}
}
