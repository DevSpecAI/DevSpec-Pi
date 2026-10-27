/**
 * In-process access to Pi's command context (items e82a690a, 6beb89c6).
 *
 * ctx.reload() and ctx.navigateTree() exist only on ExtensionCommandContext.
 * The pump/event ctx is ExtensionContext and does not have them. sendUserMessage("/devspec.reload")
 * is not a substitute: it calls prompt({ expandPromptTemplates: false }) and
 * skips _tryExecuteExtensionCommand, so the slash becomes a user prompt.
 *
 * ExtensionRunner.createCommandContext() is the official factory the TUI
 * uses. We remember the live runner via the public bindCommandContext hook
 * (called on session_start and after every reload) and then call
 * createCommandContext().reload() — the same handleReloadCommand path — or
 * createCommandContext().navigateTree(), the same path as /tree.
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const GLOBAL_KEY = "__devspecPiExtensionRunner";

/** The part of Pi's command context the owner's controls use. */
export type CommandContextLike = {
	reload?: () => Promise<void>;
	navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
	waitForIdle?: () => Promise<void>;
};

type RunnerLike = {
	createCommandContext?: () => CommandContextLike;
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

export function extensionCommandContext(): CommandContextLike | null {
	const runner = store().current;
	if (!runner || typeof runner.createCommandContext !== "function") return null;
	try {
		return runner.createCommandContext();
	} catch {
		return null;
	}
}
