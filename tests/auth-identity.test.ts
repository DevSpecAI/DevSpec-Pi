import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import authExtension, { principalFrom } from "../extensions/devspec-auth.ts";
import { setLaneClientFactoryForTests, resetClientCache } from "../extensions/core/client.ts";
import { authFilePath, loginState, saveLogin } from "../extensions/core/auth-store.ts";
import { mcpUrl } from "../extensions/core/config.ts";

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

test("login, status and startup say plainly where the credential comes from", { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "devspec-auth-identity-"));
  const oldDirectory = process.env.PI_CODING_AGENT_DIR;
  const oldToken = process.env.DEVSPEC_MCP_TOKEN;
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.DEVSPEC_MCP_TOKEN;
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const notices: string[] = [];
  let verificationFinished: (() => void) | undefined;
  const ctx = { hasUI: true, mode: "tui", ui: {
    setStatus: (_key: string, value: string | undefined) => { if (value !== "DevSpec: …") verificationFinished?.(); },
    notify: (text: string) => notices.push(text),
    input: async () => { throw new Error("nothing is pasted"); },
  } } as unknown as ExtensionContext;
  setLaneClientFactoryForTests(async () => ({ callTool: async () => result({ verified: true, connected_as: "Ali Price" }), readResource: async () => ({ contents: [] }), close: async () => {} }));
  const seed = (expiresInMs: number) => saveLogin({
    endpoint: mcpUrl(),
    tokens: { accessToken: "oat_fixture", refreshToken: "rt_fixture", issuedAt: Date.now(), expiresAt: Date.now() + expiresInMs },
    issuer: "https://issuer.test", tokenEndpoint: "https://issuer.test/oauth/token", clientId: "pi-client", resource: mcpUrl(),
  });
  try {
    authExtension({
      registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, spec.handler),
      on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, handler),
    } as unknown as ExtensionAPI);

    await commands.get("devspec.status")!("", ctx);
    assert.match(notices.at(-1)!, /\(production\): not signed in\. Run \/devspec\.login to sign in through your browser\./);
    assert.doesNotMatch(notices.at(-1)!, /pasted token/i);

    await events.get("session_start")!({}, ctx);
    assert.match(notices.at(-1)!, /Welcome to DevSpec \(production\)! Run \/devspec\.login to sign in through your browser\./);
    assert.doesNotMatch(notices.at(-1)!, /pasted token/i);

    // Even when a legacy token file exists, signed-out notices welcome the user without mentioning pasted tokens.
    await mkdir(join(directory, "devspec"), { recursive: true });
    await writeFile(authFilePath(), JSON.stringify({ token: "dvs_legacy" }), "utf8");
    assert.deepEqual(await loginState(), { kind: "none", legacyToken: true });
    await commands.get("devspec.status")!("", ctx);
    assert.match(notices.at(-1)!, /\(production\): not signed in\. Run \/devspec\.login to sign in through your browser\./);
    assert.doesNotMatch(notices.at(-1)!, /pasted token/i);
    await events.get("session_start")!({}, ctx);
    assert.match(notices.at(-1)!, /Welcome to DevSpec \(production\)! Run \/devspec\.login to sign in through your browser\./);
    assert.doesNotMatch(notices.at(-1)!, /pasted token/i);

    // A saved browser login is used, verified once, and its name remembered.
    await seed(24 * 3_600_000);
    const settled = new Promise<void>(resolve => { verificationFinished = resolve; });
    await events.get("session_start")!({}, ctx);
    await settled;
    await commands.get("devspec.status")!("", ctx);
    assert.match(notices.at(-1)!, /signed in through the browser as Ali Price/);
    assert.equal((await loginState()).kind, "active");

    // A token in the environment wins; login refuses rather than report a
    // success the next start would ignore, and both say how to remove it.
    process.env.DEVSPEC_MCP_TOKEN = "dvs_fixture";
    const before = notices.length;
    await commands.get("devspec.login")!("", ctx);
    assert.equal(notices.length, before + 1);
    assert.match(notices.at(-1)!, /DEVSPEC_MCP_TOKEN is set in this environment, so Pi uses that token and ignores a browser sign-in\. To use your browser sign-in, remove DEVSPEC_MCP_TOKEN/);
    await commands.get("devspec.status")!("", ctx);
    assert.match(notices.at(-1)!, /using the token in DEVSPEC_MCP_TOKEN[^]*ignores a browser sign-in/);
    delete process.env.DEVSPEC_MCP_TOKEN;

    // Signing out removes this server's login; nothing is left to use.
    await commands.get("devspec.logout")!("", ctx);
    assert.match(notices.at(-1)!, /Signed out of DevSpec \(production\)\./);
    assert.equal((await loginState()).kind, "none");
  } finally {
    setLaneClientFactoryForTests(null);
    resetClientCache();
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDirectory;
    if (oldToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN; else process.env.DEVSPEC_MCP_TOKEN = oldToken;
    await rm(directory, { recursive: true, force: true });
  }
});

test("headless login points at the environment token instead of waiting for a browser", async () => {
  const notices: string[] = [];
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const oldToken = process.env.DEVSPEC_MCP_TOKEN;
  delete process.env.DEVSPEC_MCP_TOKEN;
  try {
    authExtension({
      registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, spec.handler),
      on: () => {},
    } as unknown as ExtensionAPI);
    await commands.get("devspec.login")!("", { hasUI: false, mode: "print", ui: { notify: (text: string) => notices.push(text), setStatus() {} } } as unknown as ExtensionContext);
    assert.match(notices.at(-1)!, /needs a browser\. For a run without one, set DEVSPEC_MCP_TOKEN/);
  } finally {
    if (oldToken !== undefined) process.env.DEVSPEC_MCP_TOKEN = oldToken;
  }
});
