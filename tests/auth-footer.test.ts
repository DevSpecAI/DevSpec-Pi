import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import authExtension from "../extensions/devspec-auth.ts";
import { setLaneClientFactoryForTests, resetClientCache } from "../extensions/core/client.ts";

test("successful auth does not occupy the footer; identity stays in the status command", { timeout: 3000 }, async () => {
	const previousToken = process.env.DEVSPEC_MCP_TOKEN;
	process.env.DEVSPEC_MCP_TOKEN = "fixture-only-token";
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const notices: string[] = [];
	let verified!: () => void;
	const settled = new Promise<void>(resolve => { verified = resolve; });
	const ctx = { hasUI: true, mode: "tui", ui: {
		setStatus: (key: string, value: string | undefined) => { statuses.push({ key, value }); if (value !== "DevSpec: …") verified(); },
		notify: (text: string) => notices.push(text),
	} } as unknown as ExtensionContext;
	setLaneClientFactoryForTests(async () => ({ callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ principal: "DevSpec" }) }] }), readResource: async () => ({ contents: [] }), close: async () => {} }));
	try {
		authExtension({
			registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, spec.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(event, handler),
		} as unknown as ExtensionAPI);
		await events.get("session_start")!({}, ctx);
		await settled;
		assert.deepEqual(statuses.at(-1), { key: "devspec", value: undefined });
		assert.ok(!statuses.some(status => status.value === "DevSpec: DevSpec"));
		await commands.get("devspec.status")!("", ctx);
		assert.ok(notices.at(-1)!.includes("DevSpec"));
	} finally {
		setLaneClientFactoryForTests(null); resetClientCache();
		if (previousToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN; else process.env.DEVSPEC_MCP_TOKEN = previousToken;
	}
});
