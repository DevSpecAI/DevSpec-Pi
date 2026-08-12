/**
 * DevSpec Pi — MCP result unwrapping.
 *
 * The DevSpec MCP server returns tool results as MCP content blocks (text
 * carrying JSON, plus optional structuredContent). These helpers turn that
 * into something a pi tool can return directly. Pure functions — unit-tested.
 */

export interface UnwrappedResult {
	/** Concatenated text content — what the model reads. */
	text: string;
	/** Parsed JSON payload when the text was JSON (or structuredContent). */
	details: unknown;
	/** MCP-level error flag. */
	isError: boolean;
}

interface McpContentBlock {
	type?: string;
	text?: string;
}

interface McpCallToolResult {
	content?: McpContentBlock[];
	structuredContent?: unknown;
	isError?: boolean;
}

export function unwrapMcpResult(res: unknown): UnwrappedResult {
	const r = (res ?? {}) as McpCallToolResult;
	const parts = Array.isArray(r.content) ? r.content : [];
	const text = parts
		.filter((p) => p && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n\n");

	let details: unknown = r.structuredContent ?? null;
	if (details == null && text) {
		const trimmed = text.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				details = JSON.parse(trimmed);
			} catch {
				details = null;
			}
		}
	}

	return { text, details, isError: r.isError === true };
}

/** Shape pi tools return on success. */
export function toolTextResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/**
 * Shape pi tools return on failure. We deliberately return error TEXT rather
 * than throwing: the model reads it and can act (e.g. tell the user to log
 * in), which is what a remote-control/host context needs.
 */
export function toolErrorResult(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message } };
}
