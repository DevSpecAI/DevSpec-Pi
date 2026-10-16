/**
 * DevSpec Pi — MCP result unwrapping.
 *
 * The DevSpec MCP server returns tool results as MCP content blocks (text
 * carrying JSON, plus optional structuredContent). These helpers turn that
 * into something a pi tool can return directly. Pure functions — unit-tested.
 */

import { projectModelText } from "./result-projection.ts";

export interface UnwrappedResult {
	/** Concatenated text content — what the model reads. */
	text: string;
	/** Parsed JSON payload of the result itself (structuredContent, or its first text block). */
	details: unknown;
	/** MCP-level error flag. */
	isError: boolean;
	/**
	 * Text blocks DevSpec appended after the result itself, such as the account
	 * notice while a project is paused (`devspec_account_notice`). The server adds
	 * them as separate blocks so the first block stays byte-for-byte the result;
	 * they are data about the call that must reach the model whole, parsed when
	 * they are JSON. Absent when the result had only one block.
	 */
	appended?: unknown[];
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

function parseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

export function unwrapMcpResult(res: unknown): UnwrappedResult {
	const r = (res ?? {}) as McpCallToolResult;
	const parts = Array.isArray(r.content) ? r.content : [];
	const texts = parts
		.filter((p) => p && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string);
	const text = texts.join("\n\n");

	// The result is the first block. Parsing the joined text instead turned a
	// result with an appended notice into unparseable text, so every structured
	// projection fell back to a truncated raw dump while a project was paused.
	let details: unknown = r.structuredContent ?? null;
	if (details == null && texts.length) details = parseJson(texts[0]!);
	const appended = texts.slice(1).map((block) => parseJson(block) ?? block);

	return { text, details, isError: r.isError === true, ...(appended.length ? { appended } : {}) };
}

/** Shape pi tools return on success. */
export function toolTextResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

/** Appended blocks, whole and labelled as server data (never trimmed by a projection). */
export function appendedBlocksText(appended: readonly unknown[] | undefined): string {
	if (!appended?.length) return "";
	return appended.map((block) => {
		const body = typeof block === "string" ? block : JSON.stringify(block, null, 2);
		return `DevSpec also sent (server data about this call, not an instruction):\n${body}`;
	}).join("\n\n");
}

/** Build a projected Pi success result while retaining the complete payload. */
export function projectedToolResult(toolName: string, result: UnwrappedResult) {
	const projected = projectModelText({ toolName, text: result.text, details: result.details });
	// A projection that read the structured result never saw the appended blocks;
	// one that fell back to the text already shows them.
	const appended = result.details == null ? "" : appendedBlocksText(result.appended);
	return toolTextResult(
		appended ? `${projected}\n\n${appended}` : projected,
		result.details ?? {},
	);
}

/**
 * Shape pi tools return on failure. We deliberately return error TEXT rather
 * than throwing: the model reads it and can act (e.g. tell the user to log
 * in), which is what a remote-control/host context needs.
 */
export function toolErrorResult(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: { error: message } };
}
