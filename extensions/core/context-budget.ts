/**
 * Privacy-safe context-budget attribution for DevSpec Pi.
 *
 * The store accepts numbers and generated/registered tool names only. Prompt,
 * instruction, context-file, skill, argument, and result bodies never enter it.
 * State lives on globalThis because Pi loads each extension file in an isolated
 * jiti module graph.
 */

export interface StaticContextBudget {
	systemPromptChars: number;
	activeToolCount: number;
	activeToolDefinitionChars: number;
	contextFileCount: number;
	contextFileChars: number;
	skillCount: number;
	skillChars: number;
}

export interface InjectedContextBudget {
	attachChars: number;
	roomDigestChars: number;
	recallChars: number;
	conflictNudgeChars: number;
	totalChars: number;
}

export interface ToolResultBudget {
	verb: string;
	calls: number;
	chars: number;
	maxChars: number;
}

export interface ContextBudgetReport {
	v: 1;
	static: StaticContextBudget;
	injected: InjectedContextBudget;
	toolResults: {
		calls: number;
		chars: number;
		maxChars: number;
		byVerb: ToolResultBudget[];
	};
}

export type InjectionKind = "attach" | "roomDigest" | "recall" | "conflictNudge";

interface MutableState {
	safeToolNames: Set<string>;
	static: StaticContextBudget;
	injected: Omit<InjectedContextBudget, "totalChars">;
	toolResults: Map<string, Omit<ToolResultBudget, "verb">>;
}

const ZERO_STATIC: StaticContextBudget = {
	systemPromptChars: 0,
	activeToolCount: 0,
	activeToolDefinitionChars: 0,
	contextFileCount: 0,
	contextFileChars: 0,
	skillCount: 0,
	skillChars: 0,
};

const ZERO_INJECTED: Omit<InjectedContextBudget, "totalChars"> = {
	attachChars: 0,
	roomDigestChars: 0,
	recallChars: 0,
	conflictNudgeChars: 0,
};

const STORE_KEY = Symbol.for("devspec.pi.context-budget.v1");

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.round(value)
		: 0;
}

function newState(): MutableState {
	return {
		safeToolNames: new Set<string>(),
		static: { ...ZERO_STATIC },
		injected: { ...ZERO_INJECTED },
		toolResults: new Map(),
	};
}

function state(): MutableState {
	const root = globalThis as typeof globalThis & { [STORE_KEY]?: MutableState };
	if (!root[STORE_KEY]) root[STORE_KEY] = newState();
	return root[STORE_KEY];
}

/** Replace the generated allowlist used for per-tool attribution. */
export function registerContextBudgetToolNames(names: readonly string[]): void {
	state().safeToolNames = new Set(names.filter((name) => /^[a-z][a-z0-9_]{0,79}$/.test(name)));
}

/** Latest static prompt/tool/resource footprint for the current agent run. */
export function noteStaticContextBudget(value: Partial<StaticContextBudget>): void {
	const current = state();
	current.static = {
		systemPromptChars: nonNegativeInteger(value.systemPromptChars),
		activeToolCount: nonNegativeInteger(value.activeToolCount),
		activeToolDefinitionChars: nonNegativeInteger(value.activeToolDefinitionChars),
		contextFileCount: nonNegativeInteger(value.contextFileCount),
		contextFileChars: nonNegativeInteger(value.contextFileChars),
		skillCount: nonNegativeInteger(value.skillCount),
		skillChars: nonNegativeInteger(value.skillChars),
	};
}

/** Add one tail-injected context block by numeric size only. */
export function noteInjectedContext(kind: InjectionKind, chars: number): void {
	const n = nonNegativeInteger(chars);
	if (!n) return;
	const injected = state().injected;
	if (kind === "attach") injected.attachChars += n;
	else if (kind === "roomDigest") injected.roomDigestChars += n;
	else if (kind === "recall") injected.recallChars += n;
	else injected.conflictNudgeChars += n;
}

/** Add one model-visible DevSpec tool result. Unknown names fail closed. */
export function noteModelToolResult(verb: string, chars: number): void {
	const current = state();
	if (!current.safeToolNames.has(verb)) return;
	const n = nonNegativeInteger(chars);
	const prior = current.toolResults.get(verb) ?? { calls: 0, chars: 0, maxChars: 0 };
	current.toolResults.set(verb, {
		calls: prior.calls + 1,
		chars: prior.chars + n,
		maxChars: Math.max(prior.maxChars, n),
	});
}

/**
 * Snapshot one settled run and clear only its dynamic injected/result counters.
 * Static footprint remains as the last-known value for idle heartbeat refreshes.
 */
export function takeContextBudgetReport(): ContextBudgetReport {
	const current = state();
	const byVerb = [...current.toolResults.entries()]
		.map(([verb, value]) => ({ verb, ...value }))
		.sort((a, b) => b.chars - a.chars || a.verb.localeCompare(b.verb))
		.slice(0, 20);
	const injectedBase = { ...current.injected };
	const injected: InjectedContextBudget = {
		...injectedBase,
		totalChars: Object.values(injectedBase).reduce((sum, value) => sum + value, 0),
	};
	const toolValues = [...current.toolResults.values()];
	const report: ContextBudgetReport = {
		v: 1,
		static: { ...current.static },
		injected,
		toolResults: {
			calls: toolValues.reduce((sum, value) => sum + value.calls, 0),
			chars: toolValues.reduce((sum, value) => sum + value.chars, 0),
			maxChars: toolValues.reduce((max, value) => Math.max(max, value.maxChars), 0),
			byVerb,
		},
	};
	current.injected = { ...ZERO_INJECTED };
	current.toolResults.clear();
	return report;
}

/** Test/reload helper; not used by the model surface. */
export function resetContextBudgetState(): void {
	const root = globalThis as typeof globalThis & { [STORE_KEY]?: MutableState };
	root[STORE_KEY] = newState();
}
