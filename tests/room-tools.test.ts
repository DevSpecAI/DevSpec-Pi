import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoomReader } from "../extensions/core/room-tools.ts";
import { ROOM_READ_TOOL, ROOM_SCOPE_ENTRY } from "../extensions/core/room-reader.ts";
import { observeRoomAccess } from "../extensions/core/room-access.ts";
import { openRoomStore, roomPrincipalFingerprint } from "../extensions/core/room-store.ts";
import { setBond } from "../extensions/core/bond-state.ts";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { roomPoll } from "./room-context-fixture.ts";
import { IDS, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

test("registered native tool executes offline without network and honors a known access denial", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-room-tool-"));
	const keys = ["PI_CODING_AGENT_DIR", "DEVSPEC_MCP_TOKEN", "DEVSPEC_MCP_URL"] as const;
	const saved = Object.fromEntries(keys.map(k => [k, process.env[k]])); const oldFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = root; process.env.DEVSPEC_MCP_TOKEN = "fixture-only"; process.env.DEVSPEC_MCP_URL = "https://fixture.invalid/api/mcp";
	const scope = { endpoint: process.env.DEVSPEC_MCP_URL, projectId: IDS.project, nativeSessionId: IDS.owner, connectionId: IDS.connection, sessionId: IDS.plan, attachmentId: IDS.step };
	const store = await openRoomStore(scope, { principalFingerprint: roomPrincipalFingerprint("fixture-only") });
	const pkg = parsePollPayload(roomPoll(), TEST_CONNECTION, { systemNoticeNegotiated: true, senderStyleNegotiated: true, roomContextNegotiated: true });
	store.apply(pkg); store.close(); setBond(null); observeRoomAccess(scope.nativeSessionId, scope);
	let definition: any; let fallbacks = 0; registerRoomReader({ registerTool: (def: unknown) => { definition = def; } } as ExtensionAPI, () => { fallbacks++; return true; });
	const ctx = { sessionManager: { getSessionId: () => scope.nativeSessionId, getBranch: () => [{ type: "custom", customType: ROOM_SCOPE_ENTRY, data: { version: 1, scope } }] } } as unknown as ExtensionContext;
	globalThis.fetch = async () => { throw new Error("no network allowed"); };
	try {
		assert.equal(definition.name, ROOM_READ_TOOL);
		const r = await definition.execute("call", { view: "history" }, new AbortController().signal, undefined, ctx);
		const data = JSON.parse(r.content[0].text);
		assert.equal(data.network_used, false); assert.equal(data.access, "last_known_offline"); assert.equal(data.records.length, 5); assert.equal(fallbacks, 0);
		observeRoomAccess(scope.nativeSessionId, null);
		const denied = await definition.execute("call2", { view: "history" }, new AbortController().signal, undefined, ctx);
		assert.equal(JSON.parse(denied.content[0].text).availability, "unavailable");
		assert.equal(JSON.parse(denied.content[0].text).records, undefined);
		assert.equal(fallbacks, 1); assert.equal(JSON.parse(denied.content[0].text).online_fallback_tool, "get_session_transcript");
	} finally {
		globalThis.fetch = oldFetch; setBond(null);
		for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
		rmSync(root, { recursive: true, force: true });
	}
});
