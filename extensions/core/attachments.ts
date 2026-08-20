/**
 * Materialise owner-command attachments to a local file before the model
 * sees the turn (item 68d414ac).
 *
 * The poll turn carries metadata + resource_id (and, on leftover rows,
 * inline content/dataUrl). Bytes never go into the prompt: we fetch or
 * decode once, write a 0600 file, and hand the model a path. A failed
 * fetch names the filename and the reason — silently dropping a screenshot
 * is worse than refusing it.
 *
 * Signed URLs are a bearer credential: fetch now, do not store, do not log.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { unwrapMcpResult } from "./result.ts";
import { devspecDir } from "./config.ts";

export type AttachmentDelivery = "file" | "unavailable";

export interface RawAttachment {
	filename?: unknown;
	mimeType?: unknown;
	mime_type?: unknown;
	type?: unknown;
	sizeBytes?: unknown;
	size_bytes?: unknown;
	resource_id?: unknown;
	materialization?: unknown;
	content?: unknown;
	dataUrl?: unknown;
	payload?: unknown;
	reason?: unknown;
}

export interface MaterialisedAttachment {
	filename: string;
	mimeType: string;
	type: string;
	sizeBytes: number | null;
	delivery: AttachmentDelivery;
	path?: string;
	note: string;
}

export interface MaterialiseDeps {
	token: string;
	connectionId: string;
	dir?: string;
	fetchUrl?: (url: string) => Promise<Uint8Array>;
	writeFile?: (target: string, bytes: Uint8Array) => Promise<void>;
	getResource?: (token: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function isMaterialisedAttachment(a: unknown): a is MaterialisedAttachment {
	if (!a || typeof a !== "object") return false;
	const d = (a as { delivery?: unknown }).delivery;
	return d === "file" || d === "unavailable";
}

export function attachmentDirFor(connectionId: string): string {
	const safe = connectionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "connection";
	return join(devspecDir(), "attachments", safe);
}

export function safeAttachmentName(filename: unknown): string {
	const base = basename(typeof filename === "string" && filename.trim() ? filename : "attachment");
	const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
	return cleaned.slice(0, 120) || "attachment";
}

function metaOf(a: RawAttachment): {
	filename: string;
	mimeType: string;
	type: string;
	sizeBytes: number | null;
} {
	const mimeType = typeof a.mime_type === "string" ? a.mime_type : a.mimeType;
	const sizeBytes = typeof a.size_bytes === "number" ? a.size_bytes : a.sizeBytes;
	return {
		filename: safeAttachmentName(a.filename),
		mimeType: typeof mimeType === "string" && mimeType.trim() ? mimeType : "application/octet-stream",
		type: typeof a.type === "string" && a.type.trim() ? a.type : "document",
		sizeBytes: typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : null,
	};
}

function bytesFromLegacy(a: RawAttachment): Uint8Array | null {
	let b64 = typeof a.content === "string" && a.content.length > 0 ? a.content : null;
	if (!b64 && typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:")) {
		const comma = a.dataUrl.indexOf(",");
		if (comma >= 0) {
			const payload = a.dataUrl.slice(comma + 1).trim();
			if (payload) b64 = payload;
		}
	}
	if (!b64) return null;
	try {
		return Buffer.from(b64, "base64");
	} catch {
		return null;
	}
}

function downloadUrlFromResource(details: unknown): string | null {
	if (!details || typeof details !== "object") return null;
	const file = (details as { file?: unknown }).file;
	if (!file || typeof file !== "object") return null;
	const url = (file as { download_url?: unknown }).download_url;
	return typeof url === "string" && url.startsWith("https://") ? url : null;
}

export async function defaultWriteBytes(target: string, bytes: Uint8Array): Promise<void> {
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	await writeFile(target, bytes, { mode: 0o600 });
}

async function defaultFetchUrl(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`download failed (${res.status})`);
	return new Uint8Array(await res.arrayBuffer());
}

async function writeBytes(
	deps: MaterialiseDeps,
	messageId: string | undefined,
	index: number,
	filename: string,
	bytes: Uint8Array,
): Promise<string> {
	const dir = deps.dir ?? attachmentDirFor(deps.connectionId);
	const leaf = `${String(messageId ?? "msg").slice(0, 12)}-${index}-${filename}`;
	const target = join(dir, leaf);
	const write = deps.writeFile ?? defaultWriteBytes;
	await write(target, bytes);
	return target;
}

function unavailable(meta: ReturnType<typeof metaOf>, reason: string): MaterialisedAttachment {
	return {
		...meta,
		delivery: "unavailable",
		note: `${meta.filename} was attached and could not be opened (${reason}).`,
	};
}

function fileNote(type: string): string {
	return type === "image"
		? "Image saved locally — Read this path to see it. It is part of the command, not decoration."
		: "Saved locally — Read this path if the command refers to it.";
}

/**
 * Turn one poll-turn attachment into a local file (or an explicit failure).
 * Never returns base64, a data URL, or a signed URL.
 */
export async function materialiseAttachment(
	raw: unknown,
	deps: MaterialiseDeps,
	opts: { messageId?: string; index: number },
): Promise<MaterialisedAttachment | null> {
	if (!raw || typeof raw !== "object") return null;
	if (isMaterialisedAttachment(raw)) return raw;

	const a = raw as RawAttachment;
	const meta = metaOf(a);

	if (a.materialization === "unavailable" || a.payload === "unavailable") {
		const reason = typeof a.reason === "string" && a.reason.trim() ? a.reason : "unavailable";
		return unavailable(meta, reason);
	}

	const resourceId = typeof a.resource_id === "string" && a.resource_id.length > 0 ? a.resource_id : null;
	if (resourceId) {
		try {
			if (!deps.getResource) return unavailable(meta, "no fetch helper");
			const getResource = deps.getResource;
			const rawResult = await getResource(deps.token, {
				id: resourceId,
				connection_id: deps.connectionId,
			});
			const { details, isError, text } = unwrapMcpResult(rawResult);
			if (isError) return unavailable(meta, text.trim() || "get_resource failed");
			const url = downloadUrlFromResource(details);
			if (!url) return unavailable(meta, "no signed download");
			const fetchUrl = deps.fetchUrl ?? defaultFetchUrl;
			const bytes = await fetchUrl(url);
			const path = await writeBytes(deps, opts.messageId, opts.index, meta.filename, bytes);
			return { ...meta, delivery: "file", path, note: fileNote(meta.type) };
		} catch (err) {
			const reason = err instanceof Error ? err.message : "fetch failed";
			return unavailable(meta, reason);
		}
	}

	const leftover = bytesFromLegacy(a);
	if (leftover) {
		try {
			const path = await writeBytes(deps, opts.messageId, opts.index, meta.filename, leftover);
			return { ...meta, delivery: "file", path, note: fileNote(meta.type) };
		} catch (err) {
			const reason = err instanceof Error ? err.message : "write failed";
			return unavailable(meta, reason);
		}
	}

	return unavailable(meta, "missing_resource");
}

export async function materialiseAttachments(
	list: unknown,
	deps: MaterialiseDeps,
	messageId?: string,
): Promise<MaterialisedAttachment[]> {
	if (!Array.isArray(list) || list.length === 0) return [];
	const out: MaterialisedAttachment[] = [];
	for (let i = 0; i < list.length; i++) {
		const one = await materialiseAttachment(list[i], deps, { messageId, index: i });
		if (one) out.push(one);
	}
	return out;
}

/**
 * Canonical command attachments are atomic with their command. Hydration must
 * succeed before Pi is aborted, steered, or sent a user message; a failure is
 * transport state, never model-recovery prose.
 */
export function requireMaterialisedAttachments(
	attachments: readonly MaterialisedAttachment[],
	expectedCount = attachments.length,
): void {
	if (attachments.length !== expectedCount) throw new Error("attachment hydration was incomplete");
	const failed = attachments.find((attachment) => attachment.delivery !== "file" || !attachment.path);
	if (failed) throw new Error(`attachment hydration failed: ${failed.filename}`);
}

/** Prompt text: paths and reasons only. Never bytes, never a URL. */
export function formatAttachmentNotes(attachments: readonly MaterialisedAttachment[]): string {
	if (attachments.length === 0) return "";
	const lines = ["Attached files (open the local paths — they are part of the command):"];
	for (const a of attachments) {
		const size = a.sizeBytes != null ? `, ${a.sizeBytes} bytes` : "";
		if (a.delivery === "file" && a.path) {
			lines.push(`- ${a.filename} (${a.mimeType}${size}) → ${a.path}`);
			lines.push(`  ${a.note}`);
		} else {
			lines.push(`- ${a.filename} (${a.mimeType}${size})`);
			lines.push(`  ${a.note}`);
		}
	}
	return lines.join("\n");
}

export function parseRawAttachments(value: unknown): RawAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.filter((a): a is RawAttachment => !!a && typeof a === "object");
}

/** True when a leftover payload still carries inline bytes (interim transport). */
export function hasLegacyInlineBytes(a: RawAttachment): boolean {
	return (
		(typeof a.content === "string" && a.content.length > 0) ||
		(typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:"))
	);
}
