import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Do not inspect the developer's MCP configuration or credentials.
const home = await mkdtemp(join(tmpdir(), "devspec-guard-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PI_CODING_AGENT_DIR = home;
after(() => rm(home, { recursive: true, force: true }));
const { default: installGuard } = await import("../extensions/devspec-adapter-guard.ts");
const { SUPPRESSION_NOTICE, SUPPRESSION_AGENT_GUIDANCE, resetAdapterGuardState } = await import("../extensions/core/adapter-overlap.ts");

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
type ContextMessage = { message: { customType: string; content: string; display: boolean } };
const config = JSON.stringify({ mcpServers: {
  devspec: { url: "https://api.devspec.ai/api/mcp", headers: { Authorization: "Bearer fixture-only" } },
  supabase: { url: "https://mcp.supabase.com/mcp" },
} });

async function harness(shared?: string, mode = "tui", hasUI = true) {
  resetAdapterGuardState();
  const cwd = await mkdtemp(join(home, "project-"));
  if (shared) await writeFile(join(cwd, ".mcp.json"), shared);
  const handlers = new Map<string, Handler>();
  const notices: Array<{ text: string; type: string }> = [];
  let active = ["get_action_item", "devspec_get_action_item", "supabase_list_projects", "read"];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => active.map((name) => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => { active = next; },
  } as unknown as ExtensionAPI;
  const ctx = { cwd, mode, hasUI, ui: { notify: (text: string, type: string) => notices.push({ text, type }) } } as unknown as ExtensionContext;
  installGuard(pi);
  return {
    cwd, notices,
    active: () => active,
    refreshAdapter: () => { active.push("devspec_get_action_item"); },
    start: () => handlers.get("session_start")!({}, ctx),
    turn: () => handlers.get("before_agent_start")!({}, ctx),
  };
}

test("only a new override is announced; subsequent starts stay quiet with hidden agent context", async () => {
  const host = await harness(config);
  await host.start();
  assert.deepEqual(host.notices, [{ text: SUPPRESSION_NOTICE, type: "info" }]);
  assert.deepEqual(host.active(), ["get_action_item", "supabase_list_projects", "read"]);
  const overlay = await readFile(join(host.cwd, ".pi", "mcp.json"), "utf8");
  assert.deepEqual(JSON.parse(overlay), { mcpServers: { devspec: { disabled: true } } });
  assert.equal(await readFile(join(host.cwd, ".mcp.json"), "utf8"), config);

  const first = await host.turn() as ContextMessage;
  assert.equal(first.message.customType, "devspec-mcp-guard");
  assert.equal(first.message.content, SUPPRESSION_AGENT_GUIDANCE);
  assert.equal(first.message.display, false);
  assert.doesNotMatch(first.message.content, /fixture-only|Bearer/);
  host.refreshAdapter();
  assert.equal(await host.turn(), undefined);
  assert.deepEqual(host.active(), ["get_action_item", "supabase_list_projects", "read"]);
  assert.equal(host.notices.length, 1, "turns must not repeat terminal notifications");

  await host.start(); // saved override, no new write
  assert.deepEqual(host.notices, [{ text: SUPPRESSION_NOTICE, type: "info" }]);
  for (let launch = 3; launch <= 50; launch++) await host.start();
  assert.equal(host.notices.length, 1, "the fiftieth launch must not repeat established information");
  assert.equal(await readFile(join(host.cwd, ".pi", "mcp.json"), "utf8"), overlay);
  assert.equal(await readFile(join(host.cwd, ".mcp.json"), "utf8"), config);
  assert.equal((await host.turn() as ContextMessage).message.content, SUPPRESSION_AGENT_GUIDANCE);
});

test("no duplicate means no notice, no model note and no changes to foreign tools", async () => {
  const host = await harness(JSON.stringify({ mcpServers: { supabase: { url: "https://mcp.supabase.com/mcp" } } }));
  const active = [...host.active()];
  await host.start();
  assert.deepEqual(host.notices, []);
  assert.equal(await host.turn(), undefined);
  assert.deepEqual(host.active(), active);
  await assert.rejects(readFile(join(host.cwd, ".pi", "mcp.json")), { code: "ENOENT" });
});

for (const [mode, hasUI] of [["rpc", true], ["json", false], ["print", false]] as const) {
  test(`${mode}: agent receives the explanation without a terminal notification`, async () => {
    const host = await harness(config, mode, hasUI);
    await host.start();
    assert.deepEqual(host.notices, []);
    assert.equal((await host.turn() as ContextMessage).message.content, SUPPRESSION_AGENT_GUIDANCE);
    assert.equal(await host.turn(), undefined);
  });
}

test("failed persistence does not announce a successfully disabled server", async () => {
  const host = await harness(config);
  await writeFile(join(host.cwd, ".pi"), "not a directory");
  await host.start();
  assert.deepEqual(host.notices, []);
  assert.equal(await readFile(join(host.cwd, ".mcp.json"), "utf8"), config);
});

test("user-level shared MCP configuration is untouched", async () => {
  const dir = join(home, ".config", "mcp");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "mcp.json");
  await writeFile(path, config);
  try {
    const host = await harness();
    await host.start();
    assert.deepEqual(host.notices, [{ text: SUPPRESSION_NOTICE, type: "info" }]);
    assert.equal(await readFile(path, "utf8"), config);
    assert.deepEqual(JSON.parse(await readFile(join(host.cwd, ".pi", "mcp.json"), "utf8")), { mcpServers: { devspec: { disabled: true } } });
  } finally {
    await rm(path);
  }
});

test("agent guidance explains the symptom without promising healthy native tools", () => {
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /expected, not a sign-in or connection failure/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /do not re-enable the duplicate or delete shared MCP configuration/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /Pi-only/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /Explain this only if asked/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /Do not announce this proactively/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /Claude Code settings or foreign MCP servers/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /does not prove.*signed in or healthy/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE, /\/devspec.status and \/devspec.login/);
});
