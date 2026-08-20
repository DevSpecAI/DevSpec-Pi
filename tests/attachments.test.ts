import assert from "node:assert/strict";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../extensions/core/attachment-limits.ts";
import {
	AttachmentDeliveryLease,
	createAttachmentHydrationBudget,
	defaultFetchUrl,
	defaultWriteBytes,
	formatAttachmentNotes,
	hasLegacyInlineBytes,
	materialiseAttachment,
	materialiseAttachments,
	requireMaterialisedAttachments,
	safeAttachmentName,
} from "../extensions/core/attachments.ts";
import { formatCanonicalDeliveryContext, formatInboundBundleMessage, parsePollPayload } from "../extensions/core/remote-payload.ts";
import { canonicalPoll, IDS } from "./canonical-ingress-fixture.ts";

const ME = "conn-123";

function signedResource(
	url = "https://example.test/signed",
	fileMetadata: Record<string, unknown> = {},
	resourceMetadata: Record<string, unknown> = {},
) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify({ ...resourceMetadata, file: { ...fileMetadata, download_url: url } }),
		}],
	};
}

test("safeAttachmentName never escapes the attachment dir", () => {
	assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
	assert.equal(safeAttachmentName(""), "attachment");
	assert.equal(safeAttachmentName("Screenshot 2026.png"), "Screenshot_2026.png");
});

test("attachment paths stay in hidden typed framing and never mutate the visible command body", () => {
	const bundle = parsePollPayload(canonicalPoll({ body: "can you see the screenshot?" }), IDS.connection).ownerBundle!;
	bundle.commands[0].attachmentNotes =
		"Attached files (open the local paths — they are part of the command):\n- shot.png (image/png, 12 bytes) → /tmp/shot.png";
	const visible = formatInboundBundleMessage(bundle);
	const hidden = formatCanonicalDeliveryContext(bundle, [bundle.advisoryContext]);
	assert.match(visible, /can you see the screenshot\?/);
	assert.doesNotMatch(visible, /\/tmp\/shot\.png/);
	assert.match(hidden, /\/tmp\/shot\.png/);
	assert.doesNotMatch(hidden, /iVBORw0KGgo|https:\/\//);
});

test("legacy inline bytes decode to a file and never stay in the note", async () => {
	const written: Array<{ target: string; bytes: Uint8Array }> = [];
	const out = await materialiseAttachment(
		{
			filename: "shot.png",
			mimeType: "image/png",
			type: "image",
			sizeBytes: 3,
			content: Buffer.from("abc").toString("base64"),
			dataUrl: `data:image/png;base64,${Buffer.from("abc").toString("base64")}`,
		},
		{
			token: "tok",
			connectionId: ME,
			dir: "/tmp/devspec-attachments-test",
			writeFile: async (target, bytes) => {
				written.push({ target, bytes });
			},
			getResource: async () => {
				throw new Error("should not fetch when leftover bytes exist without resource_id");
			},
		},
		{ messageId: "msg-1", index: 0 },
	);
	assert.equal(out?.delivery, "file");
	assert.ok(out?.path?.endsWith("msg-1-0-shot.png"));
	assert.equal(Buffer.from(written[0].bytes).toString(), "abc");
	const notes = formatAttachmentNotes([out!]);
	assert.match(notes, /shot\.png/);
	assert.doesNotMatch(notes, /YWJj/);
	assert.doesNotMatch(notes, /data:image/);
});

test("resource_id fetches a signed URL then discards it", async () => {
	let fetchedUrl: string | undefined;
	const out = await materialiseAttachment(
		{
			filename: "shot.png",
			mimeType: "image/png",
			type: "image",
			sizeBytes: 4,
			resource_id: "res-1",
		},
		{
			token: "tok",
			connectionId: ME,
			dir: "/tmp/devspec-attachments-test",
			writeFile: async () => {},
			getResource: async (_token, args) => {
				assert.equal(args.id, "res-1");
				assert.equal(args.connection_id, ME);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								file: {
									filename: "shot.png",
									download_url: "https://example.test/signed",
									expires_in_seconds: 900,
								},
							}),
						},
					],
				};
			},
			fetchUrl: async (url) => {
				fetchedUrl = url;
				return new Uint8Array([1, 2, 3, 4]);
			},
		},
		{ messageId: "msg-9", index: 0 },
	);
	assert.equal(fetchedUrl, "https://example.test/signed");
	assert.equal(out?.delivery, "file");
	const notes = formatAttachmentNotes([out!]);
	assert.doesNotMatch(notes, /example\.test/);
	assert.doesNotMatch(notes, /signed/);
});

test("nullable unknown-type and zero-sized canonical metadata hydrate safely", async () => {
	for (const [type, sizeBytes, bytes] of [
		["future-native-type", null, new Uint8Array([1])],
		["text", 0, new Uint8Array()],
	] as const) {
		const out = await materialiseAttachment(
			{ filename: "future.bin", mime_type: "application/octet-stream", type, size_bytes: sizeBytes, resource_id: "res-1" },
			{
				token: "tok",
				connectionId: ME,
				dir: "/tmp/devspec-attachments-test",
				getResource: async () => signedResource(),
				fetchUrl: async () => bytes,
				writeFile: async () => {},
			},
			{ index: 0 },
		);
		assert.equal(out?.delivery, "file");
	}
});

test("resource metadata and downloaded bytes must match non-null declarations", async () => {
	let fetches = 0;
	const metadataMismatch = await materialiseAttachment(
		{ filename: "shot.png", mime_type: "image/png", type: "image", size_bytes: 4, resource_id: "res-1" },
		{
			token: "tok",
			connectionId: ME,
			getResource: async () => signedResource(
				"https://example.test/signed",
				{ filename: "other.png", mime_type: "image/png", size_bytes: 4 },
				{ id: "res-1" },
			),
			fetchUrl: async () => { fetches++; return new Uint8Array(4); },
		},
		{ index: 0 },
	);
	assert.equal(metadataMismatch?.delivery, "unavailable");
	assert.match(metadataMismatch?.note ?? "", /resource filename did not match/);
	assert.equal(fetches, 0);

	const resourceSizeMismatch = await materialiseAttachment(
		{ filename: "shot.png", mime_type: "image/png", type: "image", size_bytes: 4, resource_id: "res-1" },
		{
			token: "tok",
			connectionId: ME,
			getResource: async () => signedResource(
				"https://example.test/signed",
				{ filename: "shot.png", mime_type: "image/png", size_bytes: 3 },
				{ id: "res-1" },
			),
			fetchUrl: async () => new Uint8Array(4),
		},
		{ index: 0 },
	);
	assert.equal(resourceSizeMismatch?.delivery, "unavailable");
	assert.match(resourceSizeMismatch?.note ?? "", /resource size did not match/);

	const downloadedMismatch = await materialiseAttachment(
		{ filename: "shot.png", mime_type: "image/png", type: "image", size_bytes: 4, resource_id: "res-1" },
		{
			token: "tok",
			connectionId: ME,
			getResource: async () => signedResource(
				"https://example.test/signed",
				{ filename: "shot.png", mime_type: "image/png", size_bytes: 4 },
				{ id: "res-1" },
			),
			fetchUrl: async () => new Uint8Array(3),
		},
		{ index: 0 },
	);
	assert.equal(downloadedMismatch?.delivery, "unavailable");
	assert.match(downloadedMismatch?.note ?? "", /downloaded size did not match/);
});

test("URL-bearing downloader exceptions are never copied into attachment failures", async () => {
	const secretUrl = "https://example.test/signed?token=top-secret&signature=credential";
	const out = await materialiseAttachment(
		{ filename: "notes.txt", mime_type: "text/plain", type: "text", size_bytes: null, resource_id: "res-1" },
		{
			token: "tok",
			connectionId: ME,
			getResource: async () => signedResource(secretUrl),
			fetchUrl: async (url) => { throw new Error(`failed to fetch ${url}`); },
		},
		{ index: 0 },
	);
	assert.equal(out?.delivery, "unavailable");
	assert.match(out?.note ?? "", /attachment download failed/);
	assert.doesNotMatch(out?.note ?? "", /example\.test|top-secret|signature|https:/);
});

test("full message identity prevents same-prefix attachment path collisions", async () => {
	const targets: string[] = [];
	for (const messageId of ["123456789012-first", "123456789012-second"]) {
		const out = await materialiseAttachment(
			{ filename: "notes.txt", mime_type: "text/plain", type: "text", size_bytes: 1, resource_id: "res-1" },
			{
				token: "tok",
				connectionId: ME,
				dir: "/tmp/devspec-attachments-test",
				getResource: async () => signedResource(),
				fetchUrl: async () => new Uint8Array([1]),
				writeFile: async (target) => { targets.push(target); },
			},
			{ messageId, index: 0 },
		);
		assert.equal(out?.delivery, "file");
	}
	assert.equal(new Set(targets).size, 2);
	assert.match(targets[0]!, /123456789012-first/);
	assert.match(targets[1]!, /123456789012-second/);
});

test("a failed fetch is unavailable and cannot pass atomic command hydration", async () => {
	const out = await materialiseAttachment(
		{ filename: "notes.txt", mimeType: "text/plain", type: "text", resource_id: "res-x" },
		{
			token: "tok",
			connectionId: ME,
			getResource: async () => {
				throw new Error("not found");
			},
		},
		{ index: 0 },
	);
	assert.equal(out?.delivery, "unavailable");
	assert.match(out!.note, /notes\.txt/);
	assert.match(out!.note, /attachment download failed/);
	assert.throws(() => requireMaterialisedAttachments([out!]), /attachment hydration failed: notes\.txt/);
});

test("materialisation rejects an over-count list before any fetch or write", async () => {
	let fetches = 0;
	let writes = 0;
	const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => ({
		filename: `notes-${index}.txt`,
		mime_type: "text/plain",
		type: "text",
		size_bytes: 1,
		resource_id: `res-${index}`,
	}));
	await assert.rejects(
		materialiseAttachments(attachments, {
			token: "tok",
			connectionId: ME,
			getResource: async () => {
				fetches++;
				return signedResource();
			},
			writeFile: async () => { writes++; },
		}),
		/attachment count exceeds safe bound/,
	);
	assert.equal(fetches, 0);
	assert.equal(writes, 0);
});

test("custom downloads cannot return actual bytes over the per-file ceiling", async () => {
	let writes = 0;
	const out = await materialiseAttachment(
		{ filename: "notes.txt", mime_type: "text/plain", type: "text", size_bytes: 1, resource_id: "res-1" },
		{
			token: "tok",
			connectionId: ME,
			getResource: async () => signedResource(),
			fetchUrl: async () => new Uint8Array(MAX_ATTACHMENT_BYTES.text + 1),
			writeFile: async () => { writes++; },
		},
		{ index: 0 },
	);
	assert.equal(out?.delivery, "unavailable");
	assert.match(out?.note ?? "", /attachment byte limit/);
	assert.equal(writes, 0);
});

for (const [label, headers] of [
	["missing Content-Length", undefined],
	["misleading Content-Length", { "content-length": "1" }],
] as const) {
	test(`streaming download enforces actual bytes with ${label}`, async (t) => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES.text));
				controller.enqueue(new Uint8Array([1]));
				controller.close();
			},
		});
		t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 200, headers }));
		let writes = 0;
		const out = await materialiseAttachment(
			{ filename: "notes.txt", mime_type: "text/plain", type: "text", size_bytes: 1, resource_id: "res-1" },
			{
				token: "tok",
				connectionId: ME,
				getResource: async () => signedResource(),
				writeFile: async () => { writes++; },
			},
			{ index: 0 },
		);
		assert.equal(out?.delivery, "unavailable");
		assert.match(out?.note ?? "", /attachment byte limit/);
		assert.equal(writes, 0);
	});
}

test("bounded downloader rejects a falsely low Content-Length even below the byte ceiling", async (t) => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2]));
			controller.close();
		},
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-length": "1" } }));
	await assert.rejects(defaultFetchUrl("https://example.test/signed", 10, 1_000), /Content-Length/);
});

test("bounded downloader cancels the response body on early Content-Length refusal", async (t) => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new Uint8Array([1])); },
		cancel() { cancelled = true; },
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-length": "11" } }));
	await assert.rejects(defaultFetchUrl("https://example.test/signed", 10, 1_000), /byte limit/);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(cancelled, true);
});

test("bounded downloader coalesces tiny chunks without retaining a chunk list", async (t) => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < 1_000; i++) controller.enqueue(new Uint8Array([i % 251]));
			controller.close();
		},
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body));
	const bytes = await defaultFetchUrl("https://example.test/signed", 1_000, 1_000);
	assert.equal(bytes.byteLength, 1_000);
	assert.equal(bytes[999], 999 % 251);
});

test("bounded downloader rejects repeated zero-progress chunks and cancels", async (t) => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array());
		},
		cancel() { cancelled = true; },
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body));
	await assert.rejects(defaultFetchUrl("https://example.test/signed", 10, 1_000), /made no progress/);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(cancelled, true);
});

test("bounded downloader times out a stalled body and cancels it", async (t) => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull: () => new Promise<void>(() => {}),
		cancel() { cancelled = true; },
	});
	t.mock.method(globalThis, "fetch", async () => new Response(body));
	await assert.rejects(defaultFetchUrl("https://example.test/signed", 10, 20), /timed out/);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(cancelled, true);
});

test("actual bytes are also bounded across the attachment list", async () => {
	let writes = 0;
	let removals = 0;
	const out = await materialiseAttachments(
		Array.from({ length: 3 }, (_, index) => ({
			filename: `doc-${index}.docx`,
			mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			type: "document",
			size_bytes: null,
			resource_id: `res-${index}`,
		})),
		{
			token: "tok",
			connectionId: ME,
			dir: "/tmp/devspec-attachments-test",
			getResource: async (_token, args) => signedResource(`https://example.test/${String(args.id)}`),
			fetchUrl: async () => new Uint8Array(5 * 1024 * 1024),
			writeFile: async () => { writes++; },
			removeFile: async () => { removals++; },
		},
		"message-total",
	);
	assert.equal(out.length, 3);
	assert.equal(out[2]?.delivery, "unavailable");
	assert.match(out[2]?.note ?? "", /attachment byte limit/);
	assert.equal(writes, 2);
	assert.equal(removals, 2);
});

test("one hydration budget enforces actual total across command attachment lists", async () => {
	const first = [{ filename: "first.bin", mime_type: "application/octet-stream", type: "future", size_bytes: null, resource_id: "res-1" }];
	const second = [{ filename: "second.bin", mime_type: "application/octet-stream", type: "future", size_bytes: null, resource_id: "res-2" }];
	const budget = createAttachmentHydrationBudget([first, second]);
	const deps = {
		token: "tok",
		connectionId: ME,
		dir: "/tmp/devspec-attachments-test",
		getResource: async () => signedResource(),
		fetchUrl: async () => new Uint8Array(7 * 1024 * 1024),
		writeFile: async () => {},
	};
	const firstOut = await materialiseAttachments(first, deps, "first-message", budget);
	const secondOut = await materialiseAttachments(second, deps, "second-message", budget);
	assert.equal(firstOut[0]?.delivery, "file");
	assert.equal(secondOut[0]?.delivery, "unavailable");
	assert.match(secondOut[0]?.note ?? "", /attachment byte limit/);
});

test("atomic hydration removes files written before a later attachment fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "devspec-attachment-cleanup-"));
	try {
		const out = await materialiseAttachments(
			[
				{ filename: "first.txt", mime_type: "text/plain", type: "text", size_bytes: 3, resource_id: "res-1" },
				{ filename: "second.txt", mime_type: "text/plain", type: "text", size_bytes: 3, resource_id: "res-2" },
			],
			{
				token: "tok",
				connectionId: ME,
				dir,
				getResource: async (_token, args) => signedResource(`https://example.test/${String(args.id)}`),
				fetchUrl: async (url) => {
					if (url.endsWith("res-2")) throw new Error("second fetch failed");
					return new Uint8Array([1, 2, 3]);
				},
			},
			"message-1",
		);
		assert.equal(out[0]?.delivery, "file");
		assert.equal(out[1]?.delivery, "unavailable");
		assert.throws(() => requireMaterialisedAttachments(out, 2), /second\.txt/);
		await assert.rejects(access(out[0]!.path!), /ENOENT/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("delivery lease removes hydrated files on preemption and send failures before acceptance", async (t) => {
	for (const failure of ["preemption", "send"]) {
		await t.test(failure, async () => {
			const dir = await mkdtemp(join(tmpdir(), `devspec-${failure}-cleanup-`));
			const target = join(dir, "hydrated.txt");
			try {
				await defaultWriteBytes(target, new Uint8Array([1]));
				const lease = new AttachmentDeliveryLease([{
					filename: "hydrated.txt",
					mimeType: "text/plain",
					type: "text",
					sizeBytes: 1,
					delivery: "file",
					path: target,
					note: "saved",
				}]);
				try {
					throw new Error(`${failure} failed before Pi accepted send`);
				} finally {
					await lease.cleanupIfPending();
				}
			} catch (error) {
				assert.match(String(error), new RegExp(failure));
			}
			await assert.rejects(access(target), /ENOENT/);
			await rm(dir, { recursive: true, force: true });
		});
	}
});

test("default hydration writes retain 0700 directory and 0600 file permissions", async () => {
	const parent = await mkdtemp(join(tmpdir(), "devspec-permissions-parent-"));
	const dir = join(parent, "attachments");
	const target = join(dir, "file.txt");
	try {
		await defaultWriteBytes(target, new Uint8Array([1, 2, 3]));
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.equal((await stat(target)).mode & 0o777, 0o600);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("canonical unavailable payload is named, not omitted by the materializer", async () => {
	const out = await materialiseAttachments(
		[{ filename: "old.png", mime_type: "image/png", type: "image", size_bytes: null, materialization: "unavailable", reason: "legacy_inline_payload" }],
		{ token: "tok", connectionId: ME },
		"m",
	);
	assert.equal(out[0].delivery, "unavailable");
	assert.match(out[0].note, /old\.png/);
	assert.match(out[0].note, /legacy_inline_payload/);
});

test("hasLegacyInlineBytes detects leftover transport only", () => {
	assert.equal(hasLegacyInlineBytes({ content: "abc" }), true);
	assert.equal(hasLegacyInlineBytes({ dataUrl: "data:image/png;base64,QUJD" }), true);
	assert.equal(hasLegacyInlineBytes({ resource_id: "res-1" }), false);
});
