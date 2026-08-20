/**
 * Attachment safety bounds mirrored from DevSpec core validation.
 * Keep these values aligned with packages/core/src/validation/attachments.ts.
 */
export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;

export const ATTACHMENT_TYPES = ["text", "pdf", "image", "document"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const MAX_ATTACHMENT_BYTES: Readonly<Record<AttachmentType, number>> = Object.freeze({
	text: 2 * 1024 * 1024,
	pdf: 12 * 1024 * 1024,
	image: 5 * 1024 * 1024,
	document: 10 * 1024 * 1024,
});

export function isAttachmentType(value: unknown): value is AttachmentType {
	return typeof value === "string" && (ATTACHMENT_TYPES as readonly string[]).includes(value);
}
