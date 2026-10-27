import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPoll, IDS, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";
import { roomPoll } from "./room-context-fixture.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { advertisesRoomContext } from "../extensions/core/room-context.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const explicit = process.env.DEVSPEC_V2_ROOT?.trim();
const relative = "packages/core/src/mcp/remote-ingress-contract.ts";
const root = explicit ? resolve(explicit) : [resolve(here, "../../devspecv2"), resolve(here, "../../../devspecv2")].find(r => existsSync(resolve(r, relative)));

test("real server schemas, advertisement and attachment producer pair with Pi", async t => {
	if (!root || !existsSync(resolve(root, relative))) {
		if (explicit) assert.fail("DEVSPEC_V2_ROOT does not contain the ingress contract");
		t.skip("paired server checkout unavailable; set DEVSPEC_V2_ROOT"); return;
	}
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const jiti = createJiti(resolve(root, "pi-room-contract-probe.mjs"), { fsCache: false, moduleCache: false, alias: { "@devspec/core": resolve(root, "packages/core/src"), "@": resolve(root, "apps/web") } });
	const server = await jiti.import(resolve(root, relative));
	const producer = await jiti.import(resolve(root, "apps/web/lib/mcp/typed-ingress-context.ts"));
	const options = { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true };
	const p = roomPoll();
	const metadata = producer.buildRoomMessage({ id: IDS.agentContext, role: "user", target_connection_id: IDS.otherConnection, deleted: false, response_status: null, attachments: [{ filename: "history.png", type: "image", mimeType: "image/png", sizeBytes: 1_000_000_000, resource_id: IDS.resource, storage_path: "private/path", bucket: "private", signed_url: "https://invalid.test?token=must-not-cross" }] }, new Map([[IDS.otherConnection, "Other agent"]]));
	p.ingress.room_context.messages = p.ingress.room_context.messages.map(m => m.message_id === IDS.agentContext ? metadata : m);
	const validated = server.RemoteIngressRoomContextEnvelopeV1Schema.safeParse(p.ingress);
	assert(validated.success, JSON.stringify(validated.error?.issues));
	const parsed = parsePollPayload(p, TEST_CONNECTION, options);
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	assert.equal(parsed.roomPage?.room.messages.find(m => m.message_id === IDS.agentContext)?.attachments[0]?.resource_id, IDS.resource);
	assert.equal(JSON.stringify(parsed.roomPage).includes("must-not-cross"), false);
	assert.equal(JSON.stringify(parsed.roomPage).includes("private/path"), false);
	assert.equal(advertisesRoomContext({ contents: [{ text: JSON.stringify(server.REMOTE_INGRESS_CONTRACT) }] }), true);
	const preserved = canonicalPoll({ senderStyleNegotiated: true });
	assert(server.RemoteIngressSenderStyleEnvelopeV1Schema.safeParse(preserved.ingress).success);
	assert.equal(parsePollPayload(preserved, TEST_CONNECTION, { systemNoticeNegotiated: true, senderStyleNegotiated: true }).canonicalState, "valid");
});

// A bound stricter than the served schema turns a valid notice into "could not be
// read" (the record URL was 500 against the schema's 1,000). 5a9eaa57.
test("Pi's system notice bounds are exactly the served wire schema's", async t => {
	if (!root || !existsSync(resolve(root, relative))) {
		if (explicit) assert.fail("DEVSPEC_V2_ROOT does not contain the ingress contract");
		t.skip("paired server checkout unavailable; set DEVSPEC_V2_ROOT"); return;
	}
	const { SYSTEM_NOTICE_WIRE_BOUNDS: bounds } = await import("../extensions/core/remote-payload.ts");
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const jiti = createJiti(resolve(root, "pi-room-contract-probe.mjs"), { fsCache: false, moduleCache: false, alias: { "@devspec/core": resolve(root, "packages/core/src"), "@": resolve(root, "apps/web") } });
	const server = await jiti.import(resolve(root, relative));
	const envelope = JSON.parse(JSON.stringify(server.REMOTE_INGRESS_CONTRACT)).wire_schema.json_schema.system_notice_envelope_v1;
	const notices = envelope.properties.system_notices;
	const [commit, serverNotice] = notices.items.oneOf;
	const record = serverNotice.properties.records;
	const list = serverNotice.properties.allowed_tools;
	assert.deepEqual({ ...bounds }, {
		noticesPerEnvelope: notices.maxItems,
		commitTaskTitle: commit.properties.task_title.maxLength,
		commitBranch: commit.properties.branch.maxLength,
		topic: serverNotice.properties.topic.maxLength,
		noticeType: serverNotice.properties.notice_type.maxLength,
		summary: serverNotice.properties.summary.maxLength,
		prompt: serverNotice.properties.prompt.maxLength,
		records: record.maxItems,
		recordLabel: record.items.properties.label.maxLength,
		recordType: record.items.properties.record_type.maxLength,
		recordId: record.items.properties.record_id.maxLength,
		recordTitle: record.items.properties.title.maxLength,
		recordText: record.items.properties.text.maxLength,
		recordUrl: record.items.properties.url.anyOf[0].maxLength,
		listItems: list.maxItems,
		listItemChars: list.items.maxLength,
	});
	assert.equal(serverNotice.properties.allowed_outcomes.maxItems, bounds.listItems);
	assert.equal(serverNotice.properties.allowed_outcomes.items.maxLength, bounds.listItemChars);
});

// 6aad2b46: a reply to a DevSpec notice carries the server's snapshot on the room
// lane. Pi must read exactly what the served schema accepts: stricter would drop a
// valid snapshot, looser would keep one DevSpec never sends.
test("Pi reads a reply to a DevSpec notice exactly as the served schema and producer do", async t => {
	if (!root || !existsSync(resolve(root, relative))) {
		if (explicit) assert.fail("DEVSPEC_V2_ROOT does not contain the ingress contract");
		t.skip("paired server checkout unavailable; set DEVSPEC_V2_ROOT"); return;
	}
	const reply = await import("../extensions/core/notice-reply.ts");
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const jiti = createJiti(resolve(root, "pi-room-contract-probe.mjs"), { fsCache: false, moduleCache: false, alias: { "@devspec/core": resolve(root, "packages/core/src"), "@": resolve(root, "apps/web") } });
	const server = await jiti.import(resolve(root, relative));
	const producer = await jiti.import(resolve(root, "apps/web/lib/mcp/typed-ingress-context.ts"));
	const served = JSON.parse(JSON.stringify(server.REMOTE_INGRESS_CONTRACT));
	// The served shape, field by field.
	const schema = served.wire_schema.json_schema.notice_reply_v1;
	const notice = schema.properties.notices.items;
	const record = notice.properties.records.items;
	assert.deepEqual([schema.required, schema.properties.version.const, schema.additionalProperties], [["version", "notices"], reply.NOTICE_REPLY_SNAPSHOT_VERSION, false]);
	assert.deepEqual([schema.properties.notices.minItems, schema.properties.notices.maxItems], [1, reply.NOTICE_REPLY_MAX_NOTICES]);
	assert.deepEqual([notice.required, notice.additionalProperties, notice.properties.kind.enum, notice.properties.notice_id.pattern], [[...reply.NOTICE_REPLY_NOTICE_KEYS], false, [...reply.NOTICE_REPLY_NOTICE_KINDS], reply.NOTICE_REPLY_UUID_PATTERN]);
	assert.equal(notice.properties.records.maxItems, undefined, "records are unbounded by the schema, so Pi bounds them by nothing");
	assert.deepEqual([record.required, record.additionalProperties, record.properties.url.type], [[...reply.NOTICE_REPLY_RECORD_KEYS], false, ["string", "null"]]);
	// The same verdict on every candidate.
	const valid = { version: 1, notices: [{ notice_id: "17171717-1717-4171-8171-171717171717", kind: "unlinked_commit_item_review", topic: "", notice_type: "review", summary: "s", records: [{ label: "l", record_type: "task", record_id: "r", title: "", url: null }] }] };
	const n = valid.notices[0]!;
	const candidates: unknown[] = [
		valid,
		{ ...valid, notices: Array.from({ length: 25 }, () => n) },
		{ ...valid, notices: Array.from({ length: 26 }, () => n) },
		{ ...valid, notices: [] },
		{ ...valid, version: 2 },
		{ ...valid, version: "1" },
		{ ...valid, extra: 1 },
		{ notices: valid.notices },
		{ ...valid, notices: [{ ...n, prompt: "p" }] },
		{ ...valid, notices: [{ ...n, kind: "server_notice", records: [] }] },
		{ ...valid, notices: [{ ...n, kind: "unreadable" }] },
		{ ...valid, notices: [{ ...n, notice_id: "17171717-1717-4171-8171-17171717171" }] },
		{ ...valid, notices: [{ ...n, notice_id: "00000000-0000-0000-0000-000000000000" }] },
		{ ...valid, notices: [{ ...n, notice_id: "17171717-1717-9171-8171-171717171717" }] },
		{ ...valid, notices: [{ ...n, summary: null }] },
		{ ...valid, notices: [{ ...n, records: [{ ...n.records[0], url: "https://x" }] }] },
		{ ...valid, notices: [{ ...n, records: [{ ...n.records[0], url: undefined }] }] },
		{ ...valid, notices: [{ ...n, records: [{ ...n.records[0], text: "t" }] }] },
		{ ...valid, notices: [{ ...n, records: Array.from({ length: 300 }, () => n.records[0]) }] },
		[valid],
		null,
	];
	for (const candidate of candidates) {
		assert.equal(reply.parseNoticeReplySnapshot(candidate) !== null, server.RemoteIngressNoticeReplySchema.safeParse(candidate).success, JSON.stringify(candidate)?.slice(0, 200));
	}
	// What the producer emits on the negotiated lane passes the served envelope and Pi.
	const p = roomPoll();
	const message = producer.buildRoomMessage({ id: IDS.agentContext, role: "assistant", message_type: "external_agent", deleted: false, response_status: null, attachments: [], notice_reply: valid }, new Map(), { noticeReplyAware: true });
	assert.deepEqual(message.notice_reply, valid);
	p.ingress.room_context.messages = p.ingress.room_context.messages.map(m => m.message_id === IDS.agentContext ? message : m);
	const validated = server.RemoteIngressRoomContextEnvelopeV1Schema.safeParse(p.ingress);
	assert(validated.success, JSON.stringify(validated.error?.issues));
	const parsed = parsePollPayload(p, TEST_CONNECTION, { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true, noticeReplyNegotiated: true });
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	assert.deepEqual(parsed.roomPage?.room.messages.find(m => m.message_id === IDS.agentContext)?.notice_reply, valid);
	// Without the opt-in the producer leaves it out, and the advertisement turns it on.
	assert.equal(Object.hasOwn(producer.buildRoomMessage({ id: IDS.agentContext, role: "assistant", attachments: [], notice_reply: valid }, new Map()), "notice_reply"), false);
	assert.equal(reply.advertisesNoticeReply({ contents: [{ text: JSON.stringify(served) }] }), true);
});
