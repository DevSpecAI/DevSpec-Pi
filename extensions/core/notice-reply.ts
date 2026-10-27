/**
 * A notice-woken run's reply, posted into the room as a reply to the DevSpec
 * notices that woke it (DevSpec item 6aad2b46; the server side is 8885423d).
 *
 * What such a post means — outside every command, turn and attempt, labelled as
 * a reply to a DevSpec notice and to no person — is served at
 * devspec://product/remote-ingress-contract (semantics.notice_reply). This module
 * is Pi's side only: which notices a run answers, what counts as its final reply,
 * the post's arguments, reading the receipt or the refusal, and reading the
 * negotiated room snapshot of such a row exactly as the server's schema does.
 */
import { hasAssistantSpeech } from "./assistant-speech.ts";
import { advertisesRoomContext } from "./room-context.ts";
import { unwrapMcpResult } from "./result.ts";

/** The server's NoticeReplySnapshot version and bounds (parity-tested against the served schema). */
export const NOTICE_REPLY_SNAPSHOT_VERSION = 1;
export const NOTICE_REPLY_MAX_NOTICES = 25;
export const NOTICE_REPLY_NOTICE_KINDS = ["server_notice", "unlinked_commit_item_review"] as const;
export const NOTICE_REPLY_NOTICE_KEYS = ["notice_id", "kind", "topic", "notice_type", "summary", "records"] as const;
export const NOTICE_REPLY_RECORD_KEYS = ["label", "record_type", "record_id", "title", "url"] as const;
/** zod's z.string().uuid(), the pattern the served JSON schema carries for notice_id. */
export const NOTICE_REPLY_UUID_PATTERN = "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
const UUID = new RegExp(NOTICE_REPLY_UUID_PATTERN);

export interface NoticeReplyRecord { label: string; record_type: string; record_id: string; title: string; url: string | null }
export interface NoticeReplyNotice {
	notice_id: string;
	kind: (typeof NOTICE_REPLY_NOTICE_KINDS)[number];
	topic: string;
	notice_type: string;
	summary: string;
	records: NoticeReplyRecord[];
}
/** room_context.messages[].notice_reply: the server's snapshot of the notices a row replies to. */
export interface NoticeReplySnapshot { version: 1; notices: NoticeReplyNotice[] }

type Row = Record<string, unknown>;
function row(value: unknown): Row | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function exactly(value: Row, keys: readonly string[]): boolean {
	return keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));
}
const strings = (value: Row, keys: readonly string[]) => keys.every((key) => typeof value[key] === "string");

/**
 * The snapshot exactly as the server's NoticeReplySnapshotSchema reads it, or null
 * when the server's schema would refuse it. Strings may be empty, as zod's
 * z.string() allows; nothing is trimmed or rewritten.
 */
export function parseNoticeReplySnapshot(value: unknown): NoticeReplySnapshot | null {
	const snapshot = row(value);
	if (!snapshot || !exactly(snapshot, ["version", "notices"]) || snapshot.version !== NOTICE_REPLY_SNAPSHOT_VERSION) return null;
	const notices = snapshot.notices;
	if (!Array.isArray(notices) || notices.length < 1 || notices.length > NOTICE_REPLY_MAX_NOTICES) return null;
	const parsed: NoticeReplyNotice[] = [];
	for (const item of notices) {
		const notice = row(item);
		if (!notice || !exactly(notice, NOTICE_REPLY_NOTICE_KEYS) || !strings(notice, ["notice_id", "topic", "notice_type", "summary"])) return null;
		if (!UUID.test(notice.notice_id as string) || !NOTICE_REPLY_NOTICE_KINDS.includes(notice.kind as NoticeReplyNotice["kind"])) return null;
		if (!Array.isArray(notice.records)) return null;
		const records: NoticeReplyRecord[] = [];
		for (const entry of notice.records) {
			const record = row(entry);
			if (!record || !exactly(record, NOTICE_REPLY_RECORD_KEYS) || !strings(record, ["label", "record_type", "record_id", "title"])) return null;
			if (record.url !== null && typeof record.url !== "string") return null;
			records.push({ label: record.label as string, record_type: record.record_type as string, record_id: record.record_id as string, title: record.title as string, url: record.url as string | null });
		}
		parsed.push({ notice_id: notice.notice_id as string, kind: notice.kind as NoticeReplyNotice["kind"], topic: notice.topic as string, notice_type: notice.notice_type as string, summary: notice.summary as string, records });
	}
	return { version: 1, notices: parsed };
}

/** Opt in to the snapshot only when the served contract advertises it: an older server refuses the argument. */
export function advertisesNoticeReply(resource: unknown): boolean {
	try {
		for (const item of (row(resource)?.contents ?? []) as unknown[]) {
			if (!advertisesRoomContext({ contents: [item] })) continue;
			const contract = row(JSON.parse(String(row(item)?.text)));
			const activation = row(contract?.activation);
			const requires = row(activation?.notice_reply_requires);
			if (activation?.notice_reply_negotiation_argument === "notice_reply_version" && requires?.room_context_version === 1 && requires?.notice_reply_version === 1) return true;
		}
	} catch { /* An older or unreadable advertisement keeps the room lane without the snapshot. */ }
	return false;
}

/** The notice ids of one delivered batch, from the details Pi put on the notice message itself. */
export function noticeIdsFromDelivery(details: unknown): string[] {
	const notices = row(details)?.notices;
	if (!Array.isArray(notices)) return [];
	const ids: string[] = [];
	for (const notice of notices) {
		const id = row(notice)?.notice_id;
		if (typeof id === "string" && UUID.test(id) && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * The run's final reply: the text of its last assistant message, when the model
 * finished that message itself. A run that ends on a tool call, an abort or a
 * provider error, or whose last message has no text, has no final reply.
 */
export function noticeReplyFinalText(message: { text: string; stopReason?: string | null }): string | null {
	if (message.stopReason !== "stop" && message.stopReason !== "length") return null;
	return hasAssistantSpeech(message.text) ? message.text : null;
}

/** What one notice-woken segment answers and what it ended up saying. */
export interface NoticeReplyCapture {
	/** The connection the notices were delivered to; only it may name them. */
	connectionId: string;
	noticeIds: string[];
	/** The notice framing told the model its final message reaches the room. */
	roomPromised: boolean;
	finalText: string | null;
}

export type NoticeReplyCallResult = { raw: unknown } | { refusal: string };

export type NoticeReplyOutcome =
	| { kind: "posted"; messageId: string; sessionId: string; idempotent: boolean }
	| { kind: "no_final_text" }
	| { kind: "not_attached" }
	| { kind: "connection_changed" }
	| { kind: "refused"; reason: string; detail: string }
	| { kind: "unconfirmed"; detail: string };

const canonical = (ids: readonly string[]) => [...new Set(ids.map((id) => id.trim().toLowerCase()))].sort();

/** A stored receipt for exactly this reply, or null. Anything else is not proof the room shows it. */
export function readNoticeReplyReceipt(raw: unknown, expected: { connectionId: string; noticeIds: readonly string[] }):
	{ messageId: string; sessionId: string; idempotent: boolean } | null {
	const { details, isError } = unwrapMcpResult(raw);
	const data = row(details);
	const delivery = row(data?.delivery);
	if (isError || !data || !delivery) return null;
	if (delivery.status !== "stored" && delivery.status !== "idempotently_stored") return null;
	const messageId = data.message_id;
	const sessionId = data.session_id;
	if (typeof messageId !== "string" || !messageId || delivery.message_id !== messageId || typeof sessionId !== "string" || !sessionId) return null;
	if (data.connection_id !== expected.connectionId || data.phase !== "answer" || data.turn_effect !== "none") return null;
	const answered = row(data.notice_reply)?.notice_ids;
	if (!Array.isArray(answered) || !answered.every((id) => typeof id === "string")) return null;
	if (JSON.stringify(canonical(answered as string[])) !== JSON.stringify(canonical(expected.noticeIds))) return null;
	return { messageId, sessionId, idempotent: delivery.status === "idempotently_stored" };
}

/** The server's refusal: its delivery reason and its own words, verbatim. */
export function readNoticeReplyRefusal(text: string): { reason: string; detail: string } {
	try {
		const data = row(JSON.parse(text));
		const delivery = row(data?.delivery);
		if (delivery?.status === "rejected" && typeof delivery.reason === "string" && delivery.reason) {
			return { reason: delivery.reason, detail: typeof data?.error === "string" && data.error.trim() ? data.error.trim() : text.trim() };
		}
	} catch { /* A refusal before anything was read is plain text. */ }
	return { reason: "refused", detail: text.trim() };
}

/**
 * Post the segment's final reply as a reply to its notices. Only connection_id,
 * the text and the notice ids identify it: no command, turn, attempt, trail or
 * completion, so nothing here can change Working, Pending or idle. The server
 * stores the same notices and text once, so a room change between its read and
 * its write is sent once more.
 */
export async function postNoticeReply(input: {
	capture: NoticeReplyCapture;
	/** This Pi's DevSpec connection and room right now, or null without one. */
	current: () => { connectionId: string; sessionId: string | null } | null;
	call: (args: Record<string, unknown>) => Promise<NoticeReplyCallResult>;
	/** agent_name, agent_stats and model, as every answer carries them. */
	extraArgs?: Record<string, unknown>;
}): Promise<NoticeReplyOutcome> {
	const { capture } = input;
	if (capture.finalText === null || capture.noticeIds.length === 0) return { kind: "no_final_text" };
	const args = { ...input.extraArgs, connection_id: capture.connectionId, message: capture.finalText, system_notice_ids: [...capture.noticeIds] };
	for (let attempt = 0; ; attempt += 1) {
		const now = input.current();
		if (!now || now.connectionId !== capture.connectionId) return { kind: "connection_changed" };
		if (!now.sessionId) return { kind: "not_attached" };
		let result: NoticeReplyCallResult;
		try { result = await input.call(args); }
		catch (error) { return { kind: "unconfirmed", detail: error instanceof Error ? error.message : String(error) }; }
		if ("refusal" in result) {
			const refusal = readNoticeReplyRefusal(result.refusal);
			if (refusal.reason === "room_changed" && attempt === 0) continue;
			return { kind: "refused", ...refusal };
		}
		const receipt = readNoticeReplyReceipt(result.raw, { connectionId: capture.connectionId, noticeIds: capture.noticeIds });
		return receipt ? { kind: "posted", ...receipt } : { kind: "unconfirmed", detail: "DevSpec's receipt did not confirm this reply" };
	}
}

/** What the person at Pi is told, or null when there is nothing to tell. Never silent about a reply that did not land. */
export function noticeReplyTerminalMessage(outcome: NoticeReplyOutcome, capture: NoticeReplyCapture): string | null {
	const what = capture.noticeIds.length === 1 ? "The reply to the DevSpec notice" : `The reply to ${capture.noticeIds.length} DevSpec notices`;
	switch (outcome.kind) {
		case "posted":
		case "no_final_text":
			return null;
		case "not_attached":
			// Not attached when the notice arrived: the model was told its reply stays here.
			return capture.roomPromised ? `DevSpec: ${what} was not posted, because Pi is no longer attached to a room. It stays here in the terminal.` : null;
		case "connection_changed":
			return `DevSpec: ${what} was not posted, because this Pi's DevSpec connection changed during the run. It stays here in the terminal.`;
		case "refused":
			return `DevSpec: ${what} was not posted to the room (${outcome.reason}). ${outcome.detail}`;
		case "unconfirmed":
			return `DevSpec: ${what} may not have reached the room (${outcome.detail}). Check the room before sending it again.`;
	}
}
