/**
 * Owner-authority CONTROL execution (item c2cc8679 / d0d37274).
 *
 * Lifecycle only. Never authors conversational content.
 */

export const CONTROL_VERBS = ["abort", "set_model", "set_thinking", "compact", "reload"] as const;
export type ControlVerb = (typeof CONTROL_VERBS)[number];

export interface ControlCommand {
	id: string;
	verb: ControlVerb;
	issuedAt: string;
	issuedByUserId: string;
	args?: { model?: string; thinking?: string };
}

export function parseControlCommand(raw: unknown): ControlCommand | null {
	if (!raw || typeof raw !== "object") return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.id !== "string" || !rec.id.trim()) return null;
	if (typeof rec.verb !== "string" || !(CONTROL_VERBS as readonly string[]).includes(rec.verb)) return null;
	if (typeof rec.issuedAt !== "string") return null;
	if (typeof rec.issuedByUserId !== "string") return null;
	const argsRaw = rec.args && typeof rec.args === "object" ? (rec.args as Record<string, unknown>) : undefined;
	return {
		id: rec.id.trim(),
		verb: rec.verb as ControlVerb,
		issuedAt: rec.issuedAt,
		issuedByUserId: rec.issuedByUserId,
		args: argsRaw
			? {
					model: typeof argsRaw.model === "string" ? argsRaw.model : undefined,
					thinking: typeof argsRaw.thinking === "string" ? argsRaw.thinking : undefined,
				}
			: undefined,
	};
}

export interface ControlHost {
	isIdle(): boolean;
	abort(): void;
	compact(): Promise<void> | void;
	reload(): Promise<void> | void;
	setThinkingLevel(level: string): void;
	setModel(modelId: string): Promise<boolean> | boolean;
	notify(message: string): void;
}

/** Execute one CONTROL verb. Returns a short result for the ack / notify. */
export async function executeControlCommand(cmd: ControlCommand, host: ControlHost): Promise<string> {
	switch (cmd.verb) {
		case "abort":
			if (!host.isIdle()) host.abort();
			return "aborted";
		case "compact":
			await host.compact();
			return "compacted";
		case "set_thinking": {
			const level = cmd.args?.thinking;
			if (!level) return "set_thinking missing level";
			host.setThinkingLevel(level);
			return `thinking=${level}`;
		}
		case "set_model": {
			const model = cmd.args?.model;
			if (!model) return "set_model missing model";
			const ok = await host.setModel(model);
			return ok ? `model=${model}` : `model not available: ${model}`;
		}
		case "reload":
			await host.reload();
			return "reloaded";
	}
}

/**
 * Run Pi ctx.compact and wait for onComplete / onError.
 * Fire-and-forget compact is how “requested” lied after a no-op.
 */
export function compactWithContext(
	ctx: {
		compact?: (opts?: {
			onComplete?: (result: unknown) => void;
			onError?: (error: Error) => void;
		}) => void;
	} | null | undefined,
	timeoutMs = 60_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!ctx || typeof ctx.compact !== "function") {
			reject(new Error("compact is not available on this context"));
			return;
		}
		const timer = setTimeout(() => {
			reject(new Error(`compact timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const done = (fn: () => void) => {
			clearTimeout(timer);
			fn();
		};
		ctx.compact({
			onComplete: () => done(() => resolve()),
			onError: (error) => done(() => reject(error)),
		});
	});
}
