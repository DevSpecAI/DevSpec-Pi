import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { installProjectSelection } from "../extensions/core/project-selection-ui.ts";
import { PROJECT_CHOICE_ENTRY, restoreProjectChoice, getProjectChoice, setProjectChoice, conversationScope, projectRemoteArgs, projectLabel, matchingProjects, readProjectChoiceRequired, projectFromRegistration, type ProjectCandidate, type ProjectChoice } from "../extensions/core/project-choice.ts";
import { callDevspec, DevspecToolError, setLaneClientFactoryForTests, resetClientCache } from "../extensions/core/client.ts";
import { setBond } from "../extensions/core/bond-state.ts";

const A: ProjectCandidate = { id: "11111111-1111-4111-8111-111111111111", name: "Website", organization: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Agency" } };
const B: ProjectCandidate = { id: "22222222-2222-4222-8222-222222222222", name: "Website", organization: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Client" } };
const endpoint = "https://example.invalid/api/mcp";
const choice = (project = A): ProjectChoice => ({ version: 1, endpoint, project, source: "explicit" });
const selection = { version: 1 as const, status: "choice_required" as const, reason: "ambiguous_remote", candidates: [A, B] };
let dir: string;
const priorToken = process.env.DEVSPEC_MCP_TOKEN, priorUrl = process.env.DEVSPEC_MCP_URL;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "devspec-project-choice-"));
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	setBond(null); resetClientCache();
	process.env.DEVSPEC_MCP_TOKEN = "test-only-token"; process.env.DEVSPEC_MCP_URL = endpoint;
});
afterEach(async () => {
	setLaneClientFactoryForTests(null); resetClientCache(); setBond(null);
	delete (globalThis as unknown as Record<string, unknown>).__devspecPiConversationProject;
	if (priorToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN; else process.env.DEVSPEC_MCP_TOKEN = priorToken;
	if (priorUrl === undefined) delete process.env.DEVSPEC_MCP_URL; else process.env.DEVSPEC_MCP_URL = priorUrl;
	await rm(dir, { recursive: true, force: true });
});
function harness(mode = "tui") {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const entries: unknown[] = [], notices: string[] = [], selects: string[][] = [], confirms: string[] = [];
	const answers: number[] = []; let consent = false; let flag: unknown;
	const pi = {
		registerFlag: () => {}, getFlag: () => flag,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, spec.handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: dir, mode, hasUI: mode === "tui", isIdle: () => true,
		sessionManager: { getSessionId: () => "local-A", getEntries: () => entries },
		ui: { setStatus: () => {}, notify: (text: string) => notices.push(text),
			select: async (_title: string, options: string[]) => { selects.push(options); const index = answers.shift(); return index === undefined ? undefined : options[index]; },
			confirm: async (_title: string, message: string) => { confirms.push(message); return consent; } },
	} as unknown as ExtensionCommandContext;
	return { pi, ctx, entries, notices, selects, confirms, answers, commands,
		consent: (value: boolean) => { consent = value; }, flag: (value: unknown) => { flag = value; } };
}
function listClient(projects = [A, B]) {
	let calls = 0;
	setLaneClientFactoryForTests(async () => ({ callTool: async () => { calls++; return { content: [{ type: "text", text: JSON.stringify({ projects }) }] }; }, readResource: async () => ({ contents: [] }), close: async () => {} }));
	return () => calls;
}

test("typed choice survives transport refusal, not English-message parsing", async () => {
	const raw = { isError: true, structuredContent: { code: "project_choice_required", project_selection: selection }, content: [{ type: "text", text: "Choose" }] };
	setLaneClientFactoryForTests(async () => ({ callTool: async () => raw, readResource: async () => ({ contents: [] }), close: async () => {} }));
	await assert.rejects(callDevspec("test", "register_connection", { local_id: "local" }), err => {
		assert.ok(err instanceof DevspecToolError); assert.deepEqual(err.projectChoice, selection); return true;
	});
	assert.equal(readProjectChoiceRequired({ isError: true, content: [{ type: "text", text: "git_remote matches more than one project" }] }), null);
});
test("duplicate names never choose a project while exact IDs do", () => {
	assert.equal(matchingProjects([A, B], "Website").length, 2);
	assert.deepEqual(matchingProjects([A, B], B.id), [B]);
	assert.equal(matchingProjects([A, B], "Web").length, 0);
	assert.match(projectLabel(B), /Client/);
});
test("project flag parser preserves room selector and rejects incomplete/duplicate flags", () => {
	assert.deepEqual(projectRemoteArgs('--project "My Website" --session room'), { selector: "My Website", remaining: "--session room" });
	assert.ok(projectRemoteArgs("--project --session room").error);
	assert.ok(projectRemoteArgs("--project a --project b").error);
	assert.ok(projectRemoteArgs('--project "unclosed').error);
	assert.equal(projectRemoteArgs("auto off").remaining, "auto off");
});
test("conversation restore is endpoint-local and never follows a folder pin", () => {
	const entries = [{ type: "custom", customType: PROJECT_CHOICE_ENTRY, data: choice(A) }];
	assert.deepEqual(restoreProjectChoice(entries, "one", endpoint), choice(A));
	assert.deepEqual(conversationScope({ pinned_project_id: B.id }, endpoint), { pinned_project_id: B.id, project_id: A.id });
	assert.deepEqual(conversationScope({ project_id: B.id }, endpoint), { project_id: B.id });
	assert.equal(restoreProjectChoice(entries, "two", "https://another.invalid/api/mcp"), null);
	assert.equal(getProjectChoice(), null);
});
test("old registration data remains usable, but inconsistent confirmed IDs are refused", () => {
	assert.equal(projectFromRegistration({ project_id: A.id }, endpoint)?.project.id, A.id);
	assert.equal(projectFromRegistration({ project_id: A.id, project_selection: { version: 1, status: "resolved", project: B } }, endpoint), null);
});
test("normal successful connection asks nothing and writes no pin", async () => {
	const h = harness(); let attempts = 0;
	const controller = installProjectSelection(h.pi, { attempt: async () => { attempts++; return { ok: true }; }, stop: async () => {} });
	assert.equal((await controller.connect(h.ctx)).ok, true);
	assert.equal(attempts, 1); assert.equal(h.selects.length, 0); assert.equal(h.confirms.length, 0);
	await assert.rejects(access(join(dir, ".devspec", "project.json")));
});
test("ambiguous auto-bond selects among org-labelled projects then defaults to conversation-only", async () => {
	const h = harness(); h.answers.push(1, 0); const attempts: Array<string | undefined> = [];
	const controller = installProjectSelection(h.pi, { attempt: async (_ctx, _room, project) => { attempts.push(project?.id); return project ? { ok: true } : { ok: false, projectChoice: selection }; }, stop: async () => {} });
	assert.equal((await controller.connect(h.ctx)).ok, true);
	assert.deepEqual(attempts, [undefined, B.id]); assert.match(h.selects[0]![1]!, /Client/);
	assert.equal(h.confirms.length, 0); await assert.rejects(access(join(dir, ".devspec", "project.json")));
});
test("cancel and headless ambiguity leave unconnected without any pin or fallback", async () => {
	for (const mode of ["tui", "rpc", "print"]) {
		const h = harness(mode); let attempts = 0;
		const controller = installProjectSelection(h.pi, { attempt: async () => { attempts++; return { ok: false, projectChoice: selection }; }, stop: async () => {} });
		assert.equal((await controller.connect(h.ctx)).ok, false); assert.equal(attempts, 1);
		if (mode !== "tui") assert.equal(h.selects.length, 0);
	}
	await assert.rejects(access(join(dir, ".devspec", "project.json")));
});
test("remember requires separate consent; forget leaves current conversation selected", async () => {
	const h = harness(); h.answers.push(0, 1); h.consent(true);
	const controller = installProjectSelection(h.pi, { attempt: async (_ctx, _room, project) => {
		if (!project) return { ok: false, projectChoice: selection };
		controller.persist(h.ctx, choice(project)); return { ok: true };
	}, stop: async () => {} });
	assert.equal((await controller.connect(h.ctx)).ok, true);
	assert.deepEqual(JSON.parse(await readFile(join(dir, ".devspec", "project.json"), "utf8")), { project_id: A.id, project_name: A.name });
	assert.match(h.confirms[0]!, /shared folder configuration/);
	await h.commands.get("devspec.project")!("forget", h.ctx);
	assert.equal(getProjectChoice()?.project.id, A.id);
	await assert.rejects(access(join(dir, ".devspec", "project.json")));
});
test("resume restores the selected project without querying discovery", async () => {
	const h = harness(); h.entries.push({ type: "custom", customType: PROJECT_CHOICE_ENTRY, data: choice(B) });
	const calls = listClient();
	const controller = installProjectSelection(h.pi, { attempt: async () => ({ ok: true }), stop: async () => {} });
	assert.equal(await controller.prepare(h.ctx), true);
	assert.equal(getProjectChoice()?.project.id, B.id); assert.equal(calls(), 0);
});
test("explicit launch flag selects without UI in headless mode and is consumed once", async () => {
	const h = harness("print"); h.flag(B.id); const calls = listClient();
	const controller = installProjectSelection(h.pi, { attempt: async () => ({ ok: true }), stop: async () => {} });
	assert.equal(await controller.prepare(h.ctx), true); assert.equal(getProjectChoice()?.project.id, B.id);
	assert.equal(await controller.prepare(h.ctx), true); assert.equal(calls(), 1); assert.equal(h.selects.length, 0);
});
test("an invalid explicit launch choice blocks automatic tool fallback", async () => {
	const h = harness("print"); h.flag("Missing project"); listClient();
	const controller = installProjectSelection(h.pi, { attempt: async () => ({ ok: true }), stop: async () => {} });
	assert.equal(await controller.prepare(h.ctx), false);
	assert.throws(() => conversationScope({}, endpoint), /No accessible project/);
	controller.persist(h.ctx, choice(A));
	assert.equal(conversationScope({}, endpoint).project_id, A.id);
});
test("changing project uses a fresh native session seeded only with project intent", async () => {
	const h = harness(); h.answers.push(1); h.consent(true); listClient();
	setProjectChoice("local-A", choice(A));
	let stopped = false; const seeded: Array<{ type: string; data: unknown }> = [];
	h.ctx.newSession = async options => {
		assert.equal(options?.parentSession, undefined);
		assert.equal(options?.withSession, undefined, "old extension graph must not restart a replacement runtime's pump");
		await options?.setup?.({ appendCustomEntry: (type: string, data: unknown) => { seeded.push({ type, data }); return "entry"; } } as never);
		return { cancelled: false };
	};
	installProjectSelection(h.pi, { attempt: async () => ({ ok: true }), stop: async () => { stopped = true; } });
	await h.commands.get("devspec.project")!("choose", h.ctx);
	assert.equal(stopped, true);
	assert.equal((seeded[0]?.data as ProjectChoice).project.id, B.id);
	assert.deepEqual(seeded[1], { type: "devspec-project-connect-once-v1", data: { requested: true } });
	assert.match(h.confirms[0]!, /model context will not be carried/);
});

test("an existing conversation cannot silently choose a different project via Remote", async () => {
	const h = harness(); setProjectChoice("local-A", choice(A)); listClient(); let attempts = 0;
	const controller = installProjectSelection(h.pi, { attempt: async () => { attempts++; return { ok: true }; }, stop: async () => {} });
	assert.equal((await controller.connect(h.ctx, undefined, B.id)).ok, false); assert.equal(attempts, 0);
	assert.equal(getProjectChoice()?.project.id, A.id);
});
