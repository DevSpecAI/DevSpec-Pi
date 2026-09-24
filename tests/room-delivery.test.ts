import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePollPayload, formatInboundBundleMessage, formatCanonicalDeliveryContext } from "../extensions/core/remote-payload.ts";
import { compactRoomAwareness } from "../extensions/core/room-reader.ts";
import { roomPoll } from "./room-context-fixture.ts";
import { TEST_CONNECTION, IDS, DELEGATED_PROJECT_INSTRUCTION } from "./canonical-ingress-fixture.ts";

test("compact delivery removes historical dumps, never the full current command or its authority/style", () => {
	const text = "A complete current instruction 🦎 ".repeat(400);
	const raw = roomPoll({ body: text, delegated: true, senderResponseStyles: [{ message_id: IDS.command, notes: ["Reply briefly."] }] });
	const parsed = parsePollPayload(raw, TEST_CONNECTION, { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true });
	assert.equal(parsed.canonicalState, "valid", parsed.canonicalError);
	const bundle = parsed.ownerBundle!;
	const visible = formatInboundBundleMessage(bundle);
	const old = formatCanonicalDeliveryContext(bundle, [bundle.advisoryContext]);
	const compact = formatCanonicalDeliveryContext(bundle, []) + "\n" + compactRoomAwareness({ room_id: IDS.plan, coverage: { saved_records: 100, complete_through_cutoff: true }, observed_at: "2026-09-24T10:00:00Z", checkpoint: "navigation-only" });
	assert(visible.includes(text)); assert(visible.includes(DELEGATED_PROJECT_INSTRUCTION));
	assert(compact.includes(DELEGATED_PROJECT_INSTRUCTION)); assert(compact.includes("Reply briefly."));
	assert(compact.includes(IDS.provenance)); assert(compact.includes('"kind":"delegated"'));
	assert(old.includes("agent observation")); assert(!compact.includes("agent observation"));
	assert(!compact.includes("quoted human context")); assert(compact.includes("read_room_context"));
	assert.equal(formatInboundBundleMessage(bundle), visible, "no metadata mutation may rewrite an earlier command");
});

test("cutover is conditional on a working local reader; existing tails and exact workflow stay separate", () => {
	const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");
	assert.match(source, /localHistory = Boolean\(pkg\.roomPage && pi_roomReaderAvailable\(\)[^]*!active\.roomSync\.store\.status\(\)\.storageError/);
	assert.match(source, /const contexts = localHistory \? \[\] : \[\.\.\.contextByEnvelope\.values\(\)\]/);
	assert.match(source, /formatCanonicalDeliveryContext\(hydrated, contexts\)/);
	assert.match(source, /appendActivePlanTail\(hiddenContent, awareness\)/);
	assert.match(source, /pi\.appendEntry\(ROOM_SCOPE_ENTRY/);
	assert.match(source, /pi_appendRoomScope\(null, active\.localSessionId\)/);
	assert.match(source, /expected\.attachment_id !== active\?\.bond\.speechAttachmentId/);
	const interaction = source.slice(source.indexOf("pi_sendInteractionContinuation ="), source.indexOf("pi_systemNoticeSend =", source.indexOf("pi_sendInteractionContinuation =")));
	assert.doesNotMatch(interaction, /compactRoomAwareness|readRoomForContext|ROOM_READ_TOOL/);
});
