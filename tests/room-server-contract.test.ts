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
