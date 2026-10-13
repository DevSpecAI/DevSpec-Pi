import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import authExtension, { principalFrom } from "../extensions/devspec-auth.ts";
import { setLaneClientFactoryForTests, resetClientCache } from "../extensions/core/client.ts";
import { loadStoredAuth, saveAuth } from "../extensions/core/auth-store.ts";

const result = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });

test("reads the real connected_as wire field from text JSON and structured content", () => {
  assert.equal(principalFrom(result({ verified: true, connected_as: "Ali Price" })), "Ali Price");
  assert.equal(principalFrom({ structuredContent: { connected_as: "  Brandon Young  " } }), "Brandon Young");
  assert.equal(principalFrom({ structuredContent: { user: { name: "Legacy User" } } }), "Legacy User");
  const longName = "Name ".repeat(40).trim();
  assert.equal(principalFrom(result({ connected_as: longName })), longName);
});

test("never derives a principal from response syntax, prose, missing fields or controls", () => {
  for (const payload of [{ verified: true }, { connected_as: null }, { connected_as: {} }, { connected_as: "{" }, { connected_as: "\u001b[31mName" }, { connected_as: "Name\nOther" }]) {
    assert.equal(principalFrom(result(payload)), null);
  }
  for (const text of ["{", "{\nmalformed", "Connection verified", "email@example.test"]) {
    assert.equal(principalFrom({ content: [{ type: "text", text }] }), null);
  }
  assert.equal(principalFrom({ ...result({ connected_as: "Not authenticated" }), isError: true }), null);
});

test("login and startup retain valid authentication without a display name or stale stored brace", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspec-auth-identity-"));
  const oldDirectory = process.env.PI_CODING_AGENT_DIR;
  const oldToken = process.env.DEVSPEC_MCP_TOKEN;
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.DEVSPEC_MCP_TOKEN;
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const notices: string[] = [];
  const prompts: string[] = [];
  let response: unknown = result({ verified: true, connected_as: "Ali Price" });
  let verificationFinished: (() => void) | undefined;
  const ctx = { hasUI: true, mode: "tui", ui: {
    setStatus: (_key: string, value: string | undefined) => { if (value !== "DevSpec: …") verificationFinished?.(); },
    notify: (text: string) => notices.push(text),
    input: async (title: string) => { prompts.push(title); return "fixture-token"; },
  } } as unknown as ExtensionContext;
  setLaneClientFactoryForTests(async () => ({ callTool: async () => response, readResource: async () => ({ contents: [] }), close: async () => {} }));
  try {
    authExtension({
      registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, spec.handler),
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, handler),
    } as unknown as ExtensionAPI);
    await commands.get("devspec.login")!("fixture-token", ctx);
    assert.equal(prompts.length, 0);
    assert.equal(notices.at(-1), "Connected to DevSpec as Ali Price.");
    assert.equal((await loadStoredAuth())?.principal, "Ali Price");

    response = result({ verified: true, connected_as: null });
    await commands.get("devspec.login")!("", ctx);
    assert.deepEqual(prompts, ["Connect to DevSpec"]);
    assert.equal(notices.at(-1), "Connected to DevSpec.");
    assert.equal((await loadStoredAuth())?.principal, undefined);
    assert.equal((await loadStoredAuth())?.token, "fixture-token");
    await commands.get("devspec.status")!("", ctx);
    assert.match(notices.at(-1)!, / · connected · /);
    assert.doesNotMatch(notices.at(-1)!, /not verified|\{/);

    await commands.get("devspec.logout")!("", ctx);
    await saveAuth({ token: "fixture-token", principal: "{" });
    const settled = new Promise<void>(resolve => { verificationFinished = resolve; });
    await events.get("session_start")!({}, ctx);
    await settled;
    await commands.get("devspec.status")!("", ctx);
    assert.match(notices.at(-1)!, / · connected · /);
    assert.doesNotMatch(notices.at(-1)!, /not verified|\{/);
  } finally {
    setLaneClientFactoryForTests(null);
    resetClientCache();
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDirectory;
    if (oldToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN; else process.env.DEVSPEC_MCP_TOKEN = oldToken;
    await rm(directory, { recursive: true, force: true });
  }
});
