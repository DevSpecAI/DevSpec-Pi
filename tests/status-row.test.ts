import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { STATUS_KEY, formatStatusLine, getStatusSnapshot, paintStatus, patchStatus, resetStatus, syncBondIntoStatus, truncateLabel, type StatusUi } from "../extensions/core/status-line.ts";

afterEach(() => resetStatus());
const snap = { codename: "Rapid Kestrel", projectName: "Hairy Lemons Website", sessionId: "room", sessionTitle: "Homepage polish", workTitle: "Fix mobile navigation" };
const full = 'DevSpec: Rapid Kestrel · Hairy Lemons Website · “Homepage polish” · “Fix mobile navigation”';

test("dedicated row uses full names when space permits and shrinks in the requested order", () => {
 assert.equal(formatStatusLine(snap, 180), full);
 const projectOnly = formatStatusLine(snap, visibleWidth(full) - 5)!;
 assert.ok(projectOnly.includes("Rapid Kestrel"));
 assert.ok(projectOnly.includes('“Homepage polish” · “Fix mobile navigation”'));
 assert.ok(!projectOnly.includes(snap.projectName));
 const workNext = formatStatusLine(snap, 60)!;
 assert.ok(workNext.includes("Rapid Kestrel · … · “Homepage polish”"));
 assert.ok(!workNext.includes(snap.workTitle));
 assert.ok(visibleWidth(workNext) <= 60);
 const sessionLast = formatStatusLine(snap, 40)!;
 assert.ok(sessionLast.includes("Rapid Kestrel"));
 assert.ok(!sessionLast.includes(snap.sessionTitle));
 assert.ok(visibleWidth(sessionLast) <= 40);
 assert.equal(formatStatusLine({ codename: "Rapid Kestrel" }), "DevSpec: Rapid Kestrel");
 assert.equal(formatStatusLine({ projectName: "stale" }), undefined);
});

test("display labels are terminal-safe, grapheme-aware and column-bounded", () => {
 assert.equal(truncateLabel("\u001b[31mRed\u001b[0m\nName\u0007", 80), "Red Name");
 assert.equal(truncateLabel("界界界", 5), "界界…");
 const unicode = { ...snap, projectName: "界面项目 👨‍👩‍👧‍👦 café", workTitle: "修复手机导航 👩🏽‍💻", sessionTitle: "会话 e\u0301" };
 for (const width of [40, 60, 80, 120]) {
  const row = formatStatusLine(unicode, width)!;
  assert.ok(visibleWidth(row) <= width);
  assert.ok(row.startsWith("DevSpec: Rapid Kestrel"));
  assert.ok(!row.includes("\ufffd"));
 }
});

test("only identity and named work use normal foreground, including after truncation", () => {
 const calls: Array<{ role: string; text: string }> = [];
 const named = { ...snap, automationName: "Daily review", verb: "get_task" };
 formatStatusLine(named, 220, (role, text) => { calls.push({ role, text }); return text; });
 for (const text of ["DevSpec: ", snap.codename, snap.sessionTitle, snap.workTitle, "Daily review"]) {
  assert.ok(calls.some(call => call.role === "text" && call.text === text), `foreground: ${text}`);
 }
 for (const text of [snap.projectName, " · ", "automation “", "“", "”", "reading item"]) {
  assert.ok(calls.some(call => call.role === "dim" && call.text === text), `muted: ${text}`);
 }
 for (const foreground of ["38;2;212;212;212", "38;2;31;35;40"]) {
  const style = (role: "text" | "dim", text: string) => `\u001b[${role === "text" ? foreground : "38;2;128;128;128"}m${text}\u001b[0m`;
  for (const width of [40, 60, 80, 180]) {
   const styled = formatStatusLine(snap, width, style)!;
   assert.equal(stripVTControlCharacters(styled), formatStatusLine(snap, width));
   assert.ok(visibleWidth(styled) <= width);
   assert.ok(styled.includes(style("text", snap.codename)));
  }
 }
});

test("project metadata follows the confirmed bond, clears on stop, and never falls back to an ID", () => {
 syncBondIntoStatus({ codename: "Rapid Kestrel", projectId: "project-a", projectName: "Website A" });
 assert.equal(getStatusSnapshot().projectName, "Website A");
 syncBondIntoStatus({ codename: "Rapid Kestrel", projectId: "project-b", projectName: "Website B" });
 assert.equal(getStatusSnapshot().projectName, "Website B");
 syncBondIntoStatus({ codename: "Rapid Kestrel", projectId: "project-b" });
 assert.equal(getStatusSnapshot().projectName, undefined);
 syncBondIntoStatus({ codename: "Rapid Kestrel", projectId: "project-b", projectName: "project-b" });
 assert.equal(getStatusSnapshot().projectName, undefined);
 syncBondIntoStatus(null);
 assert.deepEqual(getStatusSnapshot(), {});
});

test("native below-editor widget leaves other statuses alone and responds to render width", () => {
 const statuses = new Map<string, string | undefined>([["bg", "BG 1 done"], ["mcp", "MCP 4 servers"]]);
 let widget: { render(width: number): string[]; invalidate(): void } | undefined;
 let placement: string | undefined;
 const ctx = { mode: "tui", hasUI: true, ui: {
  setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
  setWidget(key: string, factory: unknown, options?: { placement: string }) {
   assert.equal(key, STATUS_KEY); placement = options?.placement;
   widget = typeof factory === "function" ? factory({}, { fg: (_color: string, value: string) => value }) : undefined;
  },
 } } as unknown as StatusUi;
 patchStatus(snap); paintStatus(ctx);
 assert.equal(statuses.get(STATUS_KEY), undefined);
 assert.equal(statuses.get("bg"), "BG 1 done"); assert.equal(statuses.get("mcp"), "MCP 4 servers");
 assert.equal(placement, "belowEditor");
 assert.deepEqual(widget!.render(180), [full]);
 assert.deepEqual(widget!.render(60), [formatStatusLine(snap, 60)]);
 assert.deepEqual(widget!.render(180), [full], "resize restores full titles without another tool call");
 const tiny = widget!.render(10);
 assert.ok(tiny.every(line => visibleWidth(line) <= 10));
 assert.equal(tiny.join("").replace(/ /g, ""), "DevSpec:RapidKestrel", "identity wraps rather than being truncated on an exceptionally narrow terminal");
 resetStatus(); assert.equal(widget, undefined);
});

test("RPC remains text-only and headless painting does not touch UI", () => {
 let text: string | undefined;
 const ctx = { mode: "rpc", hasUI: true, ui: {
  setStatus(_key: string, value: string | undefined) { text = value; },
  setWidget(_key: string, value: unknown) { assert.equal(value, undefined, "RPC cannot render custom components"); },
 } } as unknown as StatusUi;
 patchStatus(snap); paintStatus(ctx); assert.equal(text, full);
 resetStatus();
 patchStatus(snap); paintStatus({ hasUI: false, ui: { setStatus() { throw new Error("headless UI"); } } });
});
