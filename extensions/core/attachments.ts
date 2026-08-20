/**
 * Materialise owner-command attachments to local 0600 files before the model
 * sees the turn. Signed URLs are bearer credentials: fetch now, never retain,
 * log, or place them in model-visible failure text.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_BYTES,
	MAX_TOTAL_ATTACHMENT_BYTES,
	isAttachmentType,
} from "./attachment-limits.ts";
import { unwrapMcpResult } from "./result.ts";
import { devspecDir } from "./config.ts";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const INITIAL_DOWNLOAD_BUFFER_BYTES = 64 * 1024;
const MAX_DOWNLOAD_CHUNKS = 65_536;
const MAX_ZERO_PROGRESS_CHUNKS = 16;

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

export interface AttachmentHydrationBudget {
	remainingBytes: number;
}

export interface MaterialiseDeps {
	token: string;
	connectionId: string;
	dir?: string;
	fetchUrl?: (url: string, maxBytes: number) => Promise<Uint8Array>;
	writeFile?: (target: string, bytes: Uint8Array) => Promise<void>;
	removeFile?: (target: string) => Promise<void>;
	getResource?: (token: string, args: Record<string, unknown>) => Promise<unknown>;
}

class SafeAttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SafeAttachmentError";
	}
}

export function sanitizeAttachmentFailureReason(value: unknown, fallback = "attachment operation failed"): string {
	if (value instanceof SafeAttachmentError) return value.message;
	const raw = typeof value === "string" ? value : value instanceof Error ? value.message : "";
	const sanitized = raw
		.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]+/g, "[redacted URL]")
		.replace(/\b(token|signature|sig|credential|authorization|key)=\S+/gi, "$1=[REDACTED]")
		.replace(/[\x00-\x1F\x7F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
	return sanitized || fallback;
}

function safeExternalFailure(error: unknown, fallback: string): string {
	return error instanceof SafeAttachmentError ? error.message : fallback;
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

function bytesFromLegacy(a: RawAttachment, maxBytes: number): Uint8Array | null {
	let b64 = typeof a.content === "string" && a.content.length > 0 ? a.content : null;
	if (!b64 && typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:")) {
		const comma = a.dataUrl.indexOf(",");
		if (comma >= 0) {
			const payload = a.dataUrl.slice(comma + 1).trim();
			if (payload) b64 = payload;
		}
	}
	if (!b64) return null;
	if (b64.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new SafeAttachmentError("attachment bytes exceed safe bound");
	const bytes = Buffer.from(b64, "base64");
	if (bytes.byteLength > maxBytes) throw new SafeAttachmentError("attachment bytes exceed safe bound");
	return bytes;
}

interface ResourceFile {
	url: string;
	filename: string | null;
	mimeType: string | null;
	sizeBytes: number | null;
}

function downloadFileFromResource(details: unknown): ResourceFile | null {
	if (!details || typeof details !== "object") return null;
	const file = (details as { file?: unknown }).file;
	if (!file || typeof file !== "object") return null;
	const row = file as Record<string, unknown>;
	const url = row.download_url;
	if (typeof url !== "string" || !url.startsWith("https://")) return null;
	const rawSize = row.size_bytes;
	if (rawSize !== undefined && rawSize !== null && (typeof rawSize !== "number" || !Number.isInteger(rawSize) || rawSize < 0)) {
		throw new SafeAttachmentError("resource returned invalid attachment size metadata");
	}
	return {
		url,
		filename: typeof row.filename === "string" && row.filename.length > 0 ? row.filename : null,
		mimeType: typeof row.mime_type === "string" && row.mime_type.length > 0 ? row.mime_type : null,
		sizeBytes: typeof rawSize === "number" ? rawSize : null,
	};
}

function assertResourceIdentity(a: RawAttachment, resourceId: string, details: unknown, file: ResourceFile): void {
	const root = details as { id?: unknown } | null;
	if (typeof root?.id === "string" && root.id !== resourceId) throw new SafeAttachmentError("resource identity did not match attachment metadata");
	if (typeof a.filename === "string" && a.filename.length > 0 && file.filename !== null && file.filename !== a.filename) {
		throw new SafeAttachmentError("resource filename did not match attachment metadata");
	}
	const declaredMime = typeof a.mime_type === "string" ? a.mime_type : a.mimeType;
	if (typeof declaredMime === "string" && declaredMime.length > 0 && file.mimeType !== null && file.mimeType !== declaredMime) {
		throw new SafeAttachmentError("resource MIME type did not match attachment metadata");
	}
	const declaredSize = metaOf(a).sizeBytes;
	if (declaredSize !== null && file.sizeBytes !== null && file.sizeBytes !== declaredSize) {
		throw new SafeAttachmentError("resource size did not match attachment metadata");
	}
}

function assertDownloadedSize(declaredSize: number | null, resourceSize: number | null, actualSize: number): void {
	if (declaredSize !== null && actualSize !== declaredSize) throw new SafeAttachmentError("downloaded size did not match attachment metadata");
	if (resourceSize !== null && actualSize !== resourceSize) throw new SafeAttachmentError("downloaded size did not match resource metadata");
}

export async function defaultWriteBytes(target: string, bytes: Uint8Array): Promise<void> {
	const dir = dirname(target);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	await writeFile(target, bytes, { mode: 0o600 });
	await chmod(target, 0o600);
}

export async function defaultFetchUrl(
	url: string,
	maxBytes: number,
	timeoutMs = DOWNLOAD_TIMEOUT_MS,
): Promise<Uint8Array> {
	const controller = new AbortController();
	let rejectTimeout!: (error: Error) => void;
	const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
	const timer = setTimeout(() => {
		controller.abort();
		rejectTimeout(new SafeAttachmentError("attachment download timed out"));
	}, timeoutMs);
	if (typeof timer.unref === "function") timer.unref();

	let response: Response | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const cancel = () => {
		controller.abort();
		if (reader) void reader.cancel().catch(() => {});
		else if (response?.body) void response.body.cancel().catch(() => {});
	};
	try {
		response = await Promise.race([fetch(url, { signal: controller.signal }), timeout]);
		if (!response.ok) {
			cancel();
			throw new SafeAttachmentError(`download failed (${response.status})`);
		}
		const rawLength = response.headers.get("content-length");
		const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
		if (contentLength !== null && contentLength > maxBytes) {
			cancel();
			throw new SafeAttachmentError("download exceeds attachment byte limit");
		}
		if (!response.body) {
			if (contentLength !== null && contentLength !== 0) throw new SafeAttachmentError("downloaded size did not match Content-Length");
			return new Uint8Array();
		}

		reader = response.body.getReader();
		let capacity = Math.min(maxBytes, Math.max(contentLength ?? 0, Math.min(INITIAL_DOWNLOAD_BUFFER_BYTES, maxBytes)));
		let bytes = new Uint8Array(capacity);
		let total = 0;
		let chunks = 0;
		let zeroProgress = 0;
		while (true) {
			const { done, value } = await Promise.race([reader.read(), timeout]);
			if (done) break;
			chunks += 1;
			if (chunks > MAX_DOWNLOAD_CHUNKS) throw new SafeAttachmentError("attachment download was excessively fragmented");
			if (value.byteLength === 0) {
				zeroProgress += 1;
				if (zeroProgress > MAX_ZERO_PROGRESS_CHUNKS) throw new SafeAttachmentError("attachment download made no progress");
				continue;
			}
			zeroProgress = 0;
			const needed = total + value.byteLength;
			if (needed > maxBytes) throw new SafeAttachmentError("download exceeds attachment byte limit");
			if (needed > capacity) {
				capacity = Math.min(maxBytes, Math.max(needed, Math.max(INITIAL_DOWNLOAD_BUFFER_BYTES, capacity * 2)));
				const grown = new Uint8Array(capacity);
				grown.set(bytes.subarray(0, total));
				bytes = grown;
			}
			bytes.set(value, total);
			total = needed;
		}
		if (contentLength !== null && total !== contentLength) throw new SafeAttachmentError("downloaded size did not match Content-Length");
		return bytes.slice(0, total);
	} catch (error) {
		cancel();
		throw error;
	} finally {
		clearTimeout(timer);
		try { reader?.releaseLock(); } catch { /* cancellation may already release it */ }
	}
}

async function removeBytes(deps: MaterialiseDeps, target: string): Promise<void> {
	if (deps.removeFile) await deps.removeFile(target);
	else await rm(target, { force: true });
}

async function writeBytes(
	deps: MaterialiseDeps,
	messageId: string | undefined,
	index: number,
	filename: string,
	bytes: Uint8Array,
): Promise<string> {
	const dir = deps.dir ?? attachmentDirFor(deps.connectionId);
	const safeMessageId = String(messageId ?? "msg").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "msg";
	const target = join(dir, `${safeMessageId}-${index}-${filename}`);
	const write = deps.writeFile ?? defaultWriteBytes;
	try {
		await write(target, bytes);
		return target;
	} catch (error) {
		await removeBytes(deps, target).catch(() => {});
		throw error;
	}
}

function unavailable(meta: ReturnType<typeof metaOf>, reason: unknown, fallback = "unavailable"): MaterialisedAttachment {
	return {
		...meta,
		delivery: "unavailable",
		note: `${meta.filename} was attached and could not be opened (${sanitizeAttachmentFailureReason(reason, fallback)}).`,
	};
}

function fileNote(type: string): string {
	return type === "image"
		? "Image saved locally — Read this path to see it. It is part of the command, not decoration."
		: "Saved locally — Read this path if the command refers to it.";
}

interface HydratedResult {
	attachment: MaterialisedAttachment | null;
	actualBytes: number;
}

export function createAttachmentHydrationBudget(lists: readonly (readonly unknown[])[]): AttachmentHydrationBudget {
	let count = 0;
	for (const list of lists) {
		count += list.length;
		if (count > MAX_ATTACHMENTS) throw new SafeAttachmentError("attachment count exceeds safe bound across command bundle");
	}
	let declaredTotal = 0;
	let index = 0;
	for (const list of lists) {
		for (const raw of list) {
			index += 1;
			if (!raw || typeof raw !== "object") throw new SafeAttachmentError(`attachment ${index} has invalid metadata`);
			const a = raw as RawAttachment;
			const meta = metaOf(a);
			const declared = a.size_bytes ?? a.sizeBytes;
			if (declared !== undefined && declared !== null) {
				if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) {
					throw new SafeAttachmentError(`attachment ${index} has invalid declared size`);
				}
				if (isAttachmentType(meta.type) && declared > MAX_ATTACHMENT_BYTES[meta.type]) {
					throw new SafeAttachmentError(`attachment ${index} declared size exceeds safe bound`);
				}
				declaredTotal += declared;
				if (declaredTotal > MAX_TOTAL_ATTACHMENT_BYTES) throw new SafeAttachmentError("declared attachment total exceeds safe bound across command bundle");
			}
		}
	}
	return { remainingBytes: MAX_TOTAL_ATTACHMENT_BYTES };
}

async function hydrateAttachment(
	raw: unknown,
	deps: MaterialiseDeps,
	opts: { messageId?: string; index: number; budget: AttachmentHydrationBudget },
): Promise<HydratedResult> {
	if (!raw || typeof raw !== "object") return { attachment: null, actualBytes: 0 };
	if (isMaterialisedAttachment(raw)) return { attachment: raw, actualBytes: raw.sizeBytes ?? 0 };

	const a = raw as RawAttachment;
	const meta = metaOf(a);
	const typeLimit = isAttachmentType(meta.type) ? MAX_ATTACHMENT_BYTES[meta.type] : MAX_TOTAL_ATTACHMENT_BYTES;
	const maxBytes = Math.min(typeLimit, opts.budget.remainingBytes);

	if (a.materialization === "unavailable" || a.payload === "unavailable") {
		return { attachment: unavailable(meta, a.reason, "unavailable"), actualBytes: 0 };
	}

	const resourceId = typeof a.resource_id === "string" && a.resource_id.length > 0 ? a.resource_id : null;
	if (resourceId) {
		try {
			if (!deps.getResource) return { attachment: unavailable(meta, "no fetch helper"), actualBytes: 0 };
			const rawResult = await deps.getResource(deps.token, { id: resourceId, connection_id: deps.connectionId });
			const { details, isError } = unwrapMcpResult(rawResult);
			if (isError) return { attachment: unavailable(meta, "resource fetch failed"), actualBytes: 0 };
			const file = downloadFileFromResource(details);
			if (!file) return { attachment: unavailable(meta, "no signed download"), actualBytes: 0 };
			assertResourceIdentity(a, resourceId, details, file);
			const bytes = await (deps.fetchUrl ?? defaultFetchUrl)(file.url, maxBytes);
			if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) throw new SafeAttachmentError("download exceeds attachment byte limit");
			assertDownloadedSize(meta.sizeBytes, file.sizeBytes, bytes.byteLength);
			const path = await writeBytes(deps, opts.messageId, opts.index, meta.filename, bytes);
			return { attachment: { ...meta, delivery: "file", path, note: fileNote(meta.type) }, actualBytes: bytes.byteLength };
		} catch (error) {
			return { attachment: unavailable(meta, safeExternalFailure(error, "attachment download failed")), actualBytes: 0 };
		}
	}

	try {
		const leftover = bytesFromLegacy(a, maxBytes);
		if (leftover) {
			assertDownloadedSize(meta.sizeBytes, null, leftover.byteLength);
			const path = await writeBytes(deps, opts.messageId, opts.index, meta.filename, leftover);
			return { attachment: { ...meta, delivery: "file", path, note: fileNote(meta.type) }, actualBytes: leftover.byteLength };
		}
	} catch (error) {
		return { attachment: unavailable(meta, safeExternalFailure(error, "attachment hydration failed")), actualBytes: 0 };
	}
	return { attachment: unavailable(meta, "missing_resource"), actualBytes: 0 };
}

export async function materialiseAttachment(
	raw: unknown,
	deps: MaterialiseDeps,
	opts: { messageId?: string; index: number },
): Promise<MaterialisedAttachment | null> {
	const budget = createAttachmentHydrationBudget([[raw]]);
	return (await hydrateAttachment(raw, deps, { ...opts, budget })).attachment;
}

export async function cleanupMaterialisedAttachments(
	attachments: readonly MaterialisedAttachment[],
	removeFile: (target: string) => Promise<void> = (target) => rm(target, { force: true }),
): Promise<void> {
	await Promise.allSettled(
		attachments
			.filter((attachment) => attachment.delivery === "file" && attachment.path)
			.map((attachment) => removeFile(attachment.path!)),
	);
}

export class AttachmentDeliveryLease {
	private accepted = false;
	private readonly attachments: readonly MaterialisedAttachment[];
	private readonly removeFile?: (target: string) => Promise<void>;
	constructor(
		attachments: readonly MaterialisedAttachment[],
		removeFile?: (target: string) => Promise<void>,
	) {
		this.attachments = attachments;
		this.removeFile = removeFile;
	}
	accept(): void { this.accepted = true; }
	async cleanupIfPending(): Promise<void> {
		if (!this.accepted) await cleanupMaterialisedAttachments(this.attachments, this.removeFile);
	}
}

export async function materialiseAttachments(
	list: unknown,
	deps: MaterialiseDeps,
	messageId?: string,
	budget?: AttachmentHydrationBudget,
): Promise<MaterialisedAttachment[]> {
	if (!Array.isArray(list) || list.length === 0) return [];
	const activeBudget = budget ?? createAttachmentHydrationBudget([list]);
	const out: MaterialisedAttachment[] = [];
	for (let i = 0; i < list.length; i++) {
		const result = await hydrateAttachment(list[i], deps, { messageId, index: i, budget: activeBudget });
		if (result.attachment) out.push(result.attachment);
		if (!result.attachment || result.attachment.delivery !== "file") {
			await cleanupMaterialisedAttachments(out, (target) => removeBytes(deps, target));
			return out;
		}
		activeBudget.remainingBytes -= result.actualBytes;
	}
	return out;
}

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

export function hasLegacyInlineBytes(a: RawAttachment): boolean {
	return (
		(typeof a.content === "string" && a.content.length > 0) ||
		(typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:"))
	);
}
