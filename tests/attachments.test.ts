import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatAttachmentNotes,
	hasLegacyInlineBytes,
	materialiseAttachment,
	materialiseAttachments,
	safeAttachmentName,
} from "../extensions/core/attachments.ts";
import { extractOwnerCommands, formatInboundMessage } from "../extensions/core/remote-payload.ts";

const ME = "conn-123";

test("safeAttachmentName never escapes the attachment dir", () => {
	assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
	assert.equal(safeAttachmentName(""), "attachment");
	assert.equal(safeAttachmentName("Screenshot 2026.png"), "Screenshot_2026.png");
});

test("extractOwnerCommands keeps attachments and attachment-only commands", () => {
	const cmds = extractOwnerCommands(
		{
			commands: [
				{
					id: "m1",
					command_turn: { id: "turn-1" },
					content: "can you see this?" ,
					attachments: [{ filename: "shot.png", mimeType: "image/png", type: "image", sizeBytes: 12, resource_id: "res-1" }],
					addressed_to: { connection_id: ME },
					authority: { kind: "owner" },
				},
				{
					id: "m2",
					command_turn: { id: "turn-1" },
					content: "",
					attachments: [{ filename: "only.png", resource_id: "res-2" }],
					addressed_to: { connection_id: ME },
					authority: { kind: "owner" },
				},
			],
		},
		ME,
	);
	assert.equal(cmds.length, 2);
	assert.equal(cmds[0].attachments?.length, 1);
	assert.equal(cmds[1].text, "");
	assert.equal((cmds[1].attachments?.[0] as { filename: string }).filename, "only.png");
});

test("formatInboundMessage appends local-file notes, never bytes or URLs", () => {
	const msg = formatInboundMessage(
		{
			text: "can you see the screenshot?",
			userName: "Ali",
			attachmentNotes:
				"Attached files (open the local paths — they are part of the command):\n- shot.png (image/png, 12 bytes) → /tmp/shot.png\n  Image saved locally — Read this path to see it. It is part of the command, not decoration.",
		},
		"Golden Possum",
	);
	assert.match(msg, /can you see the screenshot\?/);
	assert.match(msg, /\/tmp\/shot\.png/);
	assert.doesNotMatch(msg, /iVBORw0KGgo/);
	assert.doesNotMatch(msg, /https:\/\//);
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

test("a failed fetch names the filename and the reason", async () => {
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
	assert.match(out!.note, /not found/);
});

test("legacy unavailable payload is named, not omitted", async () => {
	const out = await materialiseAttachments(
		[{ filename: "old.png", type: "image", payload: "unavailable", reason: "legacy_inline_payload" }],
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
