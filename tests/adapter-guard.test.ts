import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
async function harness(native?: string, mode = "tui", trusted = true) {
  resetAdapterGuardState();
  const cwd = await mkdtemp(join(home, "project-"));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".mcp.json"), config);
  if (native) await writeFile(join(cwd, ".pi/mcp.json"), native);
  const handlers = new Map<string, Handler>();
  const notices: Array<{ text: string; type: string }> = [];
  let active = ["get_action_item", "mcp__devspec__get_action_item", "supabase_list_projects", "read"];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getCommands: () => [{name:'mcp',sourceInfo:{path:'builtin:mcp'}}], getFlag: () => undefined, events: { on: () => () => {} },
    getAllTools: () => active.map((name) => ({ name, sourceInfo: { path: name.startsWith('mcp__') ? 'builtin:mcp' : 'devspec-tools.ts' } })),
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => { active = next; },
  } as unknown as ExtensionAPI;
  const ctx = { cwd, mode, hasUI: mode === "tui", isProjectTrusted: () => trusted,
    ui: { notify: (text: string, type: string) => notices.push({ text, type }) } } as unknown as ExtensionContext;
  installGuard(pi);
  return { cwd, notices, active: () => active,
    start: async () => { await handlers.get("session_start")!({}, ctx); },
    turn: () => handlers.get("before_agent_start")!({}, ctx) };
}
test("native first change is announced once; fifty starts stay quiet; shared config is unchanged", async () => {
  const host = await harness(config);
  await host.start();
  assert.deepEqual(host.notices, [{ text: SUPPRESSION_NOTICE, type: "info" }]);
  assert.deepEqual(host.active(), ["get_action_item", "supabase_list_projects", "read"]);
  const saved = await readFile(join(host.cwd, ".pi/mcp.json"), "utf8");
  assert.equal(JSON.parse(saved).mcpServers.devspec.enabled, false);
  assert.equal(JSON.parse(saved).mcpServers.devspec.headers.Authorization, "Bearer fixture-only");
  assert.equal(await readFile(join(host.cwd, ".mcp.json"), "utf8"), config);
  const first = await host.turn() as ContextMessage;
  assert.equal(first.message.content, SUPPRESSION_AGENT_GUIDANCE);
  assert.equal(first.message.display, false);
  assert.doesNotMatch(first.message.content, /fixture-only|Bearer/);
  assert.equal(await host.turn(), undefined);
  for(let i=0;i<49;i++) await host.start();
  assert.equal(host.notices.length,1);
  assert.equal(await readFile(join(host.cwd, ".pi/mcp.json"), "utf8"),saved);
});
test("stock Pi ignores shared Claude config: no notices, overrides or model note", async () => {
  const host=await harness(); await host.start();
  assert.deepEqual(host.notices,[]); assert.equal(await host.turn(),undefined);
  await assert.rejects(readFile(join(host.cwd,".pi/mcp.json")),{code:"ENOENT"});
  await assert.rejects(readFile(join(host.cwd,".pi/mcp-adapter.json")),{code:"ENOENT"});
});
test("untrusted project config is neither read nor changed",async()=>{
  const host=await harness(config,"tui",false); await host.start();
  assert.equal(await readFile(join(host.cwd,".pi/mcp.json"),"utf8"),config);
  assert.deepEqual(host.notices,[]);
});
for(const mode of ["rpc","json","print"]) test(`${mode}: hidden guidance without routine notification`,async()=>{
  const host=await harness(config,mode); await host.start();
  assert.deepEqual(host.notices,[]);
  assert.equal((await host.turn() as ContextMessage).message.content,SUPPRESSION_AGENT_GUIDANCE);
});
test("malformed config remains intact and produces a redacted actionable warning",async()=>{
  const host=await harness('{"secret":"fixture-secret"'); await host.start();
  assert.equal(await readFile(join(host.cwd,".pi/mcp.json"),"utf8"),'{"secret":"fixture-secret"');
  assert.equal(host.notices[0].type,"warning");
  assert.doesNotMatch(host.notices[0].text,/fixture-secret/);
});
test("guidance distinguishes suppression from connection health",()=>{
  assert.match(SUPPRESSION_AGENT_GUIDANCE,/does not prove.*signed in or healthy/);
  assert.match(SUPPRESSION_AGENT_GUIDANCE,/Do not announce this proactively/);
});
