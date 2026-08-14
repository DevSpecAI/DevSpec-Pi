/**
 * Pi invalidates the extension runner after reload / session replacement.
 * Accessors on the old ctx (hasUI, ui, cwd, …) throw assertActive.
 * UI toasts and the footer are best-effort — never let that throw kill the process.
 */

const STALE_CTX_MARK = "stale after session replacement or reload";

export function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes(STALE_CTX_MARK);
}

/** Read hasUI without throwing when the runner has already been invalidated. */
export function safeHasUI(ctx: { hasUI?: boolean } | null | undefined): boolean {
	if (!ctx) return false;
	try {
		return Boolean(ctx.hasUI);
	} catch (err) {
		if (isStaleCtxError(err)) return false;
		throw err;
	}
}

/** Run a UI side-effect; swallow only the Pi stale-ctx class. */
export function withLiveUi(ctx: { hasUI?: boolean } | null | undefined, fn: () => void): void {
	if (!safeHasUI(ctx)) return;
	try {
		fn();
	} catch (err) {
		if (isStaleCtxError(err)) return;
		throw err;
	}
}
