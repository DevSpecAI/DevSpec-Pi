/** Actual Pi CLI: the git stand-in tags the one claimed task's commits (DevSpec item df71ab6c).
 * node scripts/e2e-commit-stamp.mjs
 * A deterministic provider makes the calls an agent would: claim_work_item through Pi's
 * native tool, then multi-line commits in an unpinned project repository (heredoc into
 * `-F -`, `-m "$(cat <<'EOF' …)"`, a message file) and a commit in a fixture repository
 * outside the project. A second run claims two tasks. Loopback MCP only: no paid model,
 * live DevSpec records or real credentials. Not a deployed-server E2E.
 * STAMP_E2E_PI_CLI=<path to pi's cli.js> runs that Pi with this Node instead of `pi`
 * on PATH (how the Windows CI job runs it under Git Bash; c4b14794).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PROJECT = "11111111-2222-4333-8444-555555555555";
const TASK = "df71ab6c-9bb1-49d1-a9e7-9ea6dc867607";
const OTHER_TASK = "6aad2b46-27a1-4aad-a60a-ec8ed7203d65";
const REMOTE = "https://example.invalid/devspec/stamp-fixture.git";
const TAG = `[devspec:${TASK}]`;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const PI = process.env.STAMP_E2E_PI_CLI ? [process.execPath, [resolve(process.env.STAMP_E2E_PI_CLI)]] : ["pi", []];
const message = (cwd, rev = "HEAD") => execFileSync("git", ["cat-file", "commit", rev], { cwd }).toString("utf8").split("\n\n").slice(1).join("\n\n");

function makeRepo(path, remote) {
	mkdirSync(path, { recursive: true });
	git(path, "init", "-q"); git(path, "config", "user.name", "Fixture"); git(path, "config", "user.email", "fixture@example.invalid");
	if (remote) git(path, "remote", "add", "origin", remote);
	git(path, "commit", "-q", "--allow-empty", "-m", "root");
	return path;
}

async function run(name, calls, temp, project) {
	const toolCalls = [];
	const unexpected = [];
	const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
	const server = createServer(async (req, res) => {
		try {
			if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
			let raw = ""; for await (const chunk of req) raw += chunk;
			const rpc = JSON.parse(raw); let result = {};
			if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "stamp-fixture", version: "1" }, capabilities: { tools: {}, resources: {} } };
			else if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
			else if (rpc.method === "tools/list") result = { tools: [] };
			else if (rpc.method === "resources/read") result = { contents: [] };
			else if (rpc.method === "tools/call") {
				const { name: tool, arguments: args = {} } = rpc.params;
				toolCalls.push({ tool, args });
				if (tool === "claim_work_item") result = text({ claim_success: true, task_id: args.task_id, task: { id: args.task_id, project_id: PROJECT }, project_id: PROJECT, work_claim_ref: "7f6b2a1e-0000-4000-8000-00000000000" + (toolCalls.length % 10) });
				else if (tool === "list_projects") result = text({ projects: [{ id: PROJECT, name: "Stamp fixture" }], remote_match: { resolved_project_id: args.git_remote === REMOTE ? PROJECT : null, candidate_project_ids: args.git_remote === REMOTE ? [PROJECT] : [] } });
				else if (tool === "report_commit_provenance") result = text({ recorded: true });
				else { unexpected.push(tool); result = text({ success: true }); }
			}
			res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
		} catch (error) { unexpected.push(String(error)); res.writeHead(500); res.end(); }
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const home = join(temp, `home-${name}`); mkdirSync(home, { recursive: true });
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(temp, `agent-${name}`), TMPDIR: temp,
			DEVSPEC_MCP_TOKEN: "fixture-stamp-account", DEVSPEC_MCP_URL: `http://127.0.0.1:${server.address().port}/api/mcp`,
			STAMP_PROBE_CALLS: JSON.stringify(calls), STAMP_PROBE_PROJECT: PROJECT, NODE_OPTIONS: "" };
		delete env.DEVSPEC_PI_STAMP_PROJECT; delete env.DEVSPEC_PI_STAMP_TASK; delete env.DEVSPEC_PI_STAMP_CLAIMS; delete env.DEVSPEC_PI_STAMP_REMOTE_SHA256;
		const out = await new Promise((resolve, reject) => {
			const child = spawn(PI[0], [...PI[1], "--mode", "json", "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
				"-e", join(root, "scripts/commit-stamp-runtime-fixture.ts"), "-e", join(root, "extensions/devspec-tools.ts"), "-e", join(root, "extensions/devspec-commit-ledger.ts"),
				"--provider", "commit-stamp-probe", "--model", "scripted", "-p", "Run the commit stamp fixture."], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "", stderr = "";
			const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Pi fixture timed out: ${stderr.slice(-2000)}`)); }, 120_000);
			child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Pi exit ${code}: ${stderr.slice(-3000)} ${stdout.slice(-1000)}`)); });
		});
		const events = out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.equal(events.some((event) => event.type === "extension_error"), false, "extension event failures are not silent passes");
		assert(out.includes("COMMIT-STAMP-RUNTIME-PASS"), out.slice(-2000));
		assert.deepEqual(unexpected, []);
		const toolResults = events.filter((event) => event.type === "message_end" && event.message?.role === "toolResult")
			.map((event) => ({ id: event.message.toolCallId, text: (event.message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n") }));
		return { toolCalls, toolResults };
	} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

const temp = mkdtempSync(join(tmpdir(), "pi-commit-stamp-"));
try {
	// One claim: three multi-line commits in the unpinned project repository, one outside it.
	const project = makeRepo(join(temp, "project"), REMOTE);
	const fixture = makeRepo(join(temp, "fixture"), "https://example.invalid/someone/else.git");
	const messageFile = "Message from a file\n\nWritten before the commit.\n";
	writeFileSync(join(project, "msg.txt"), messageFile);
	const commands = [
		`echo one > one.txt && git add one.txt && git commit -q -F - <<'EOF'\nAdd the first file\n\nA body line that explains it.\n\nCo-Authored-By: Fixture Agent <agent@example.invalid>\nEOF`,
		`git commit -q --allow-empty -m "$(cat <<'EOF'\nRecord the second step\n\nBody via command substitution.\nEOF\n)"`,
		`cd '${fixture}' && git commit -q --allow-empty -F - <<'EOF'\nFixture commit outside the project\n\nIt must stay exactly as written.\nEOF`,
		"git commit -q --allow-empty -F msg.txt",
	];
	const one = await run("one-claim", [
		{ name: "claim_work_item", arguments: { task_id: TASK, agent_branch: "work/stamp-fixture" } },
		...commands.map((command) => ({ name: "bash", arguments: { command } })),
	], temp, project);
	assert(one.toolCalls.some((call) => call.tool === "claim_work_item"), "the claim went through Pi's native tool");
	assert.equal(commands.some((command) => command.includes("[devspec:")), false, "the model never wrote a tag");
	const log = git(project, "log", "--format=%H", "-3").split("\n").reverse();
	assert.equal(message(project, log[0]), `Add the first file ${TAG}\n\nA body line that explains it.\n\nCo-Authored-By: Fixture Agent <agent@example.invalid>\n`);
	assert.equal(git(project, "log", "-1", "--format=%(trailers:only)", log[0]), "Co-Authored-By: Fixture Agent <agent@example.invalid>", "the trailer is still a trailer");
	assert.equal(message(project, log[1]), `Record the second step ${TAG}\n\nBody via command substitution.\n`);
	assert.equal(message(project, log[2]), `Message from a file ${TAG}\n\nWritten before the commit.\n`);
	assert.equal(readFileSync(join(project, "msg.txt"), "utf8"), messageFile, "the person's message file is untouched");
	assert.equal(message(fixture), "Fixture commit outside the project\n\nIt must stay exactly as written.\n", "the fixture repository outside the project is untouched");
	const resultFor = (id) => one.toolResults.find((result) => result.id === id)?.text ?? "";
	for (const [index, sha] of [[1, log[0]], [2, log[1]], [4, log[2]]]) {
		assert.match(resultFor(`stamp-probe-${index}`), new RegExp(`DevSpec: Pi added \\[devspec:${TASK}\\] to the message of commit ${sha.slice(0, 7)}, for the one task claimed in this conversation\\.`));
	}
	assert.doesNotMatch(resultFor("stamp-probe-3"), /DevSpec: Pi/, "nothing is said about a commit outside the project");
	assert.equal(one.toolCalls.filter((call) => call.tool === "report_commit_provenance").length, 4, "every commit is still observed and reported");

	// Two claims: nothing is stamped and the model is told to write the tag itself.
	const project2 = makeRepo(join(temp, "project-two-claims"), REMOTE);
	const two = await run("two-claims", [
		{ name: "claim_work_item", arguments: { task_id: TASK, agent_branch: "work/stamp-fixture" } },
		{ name: "claim_work_item", arguments: { task_id: OTHER_TASK, agent_branch: "work/stamp-fixture" } },
		{ name: "bash", arguments: { command: `git commit -q --allow-empty -F - <<'EOF'\nWork for one of two tasks\n\nBody.\nEOF` } },
	], temp, project2);
	assert.equal(message(project2), "Work for one of two tasks\n\nBody.\n");
	const twoNote = two.toolResults.find((result) => result.id === "stamp-probe-2")?.text ?? "";
	assert.match(twoNote, new RegExp(`DevSpec: Pi did not add a task tag to commit ${git(project2, "rev-parse", "--short=7", "HEAD")}: 2 tasks are claimed in this conversation, so it cannot tell which one this commit is for\\. Write the right task's \\[devspec:<full-uuid>\\] into the message yourself\\.`));

	console.log(JSON.stringify({ result: "PASS", host: execFileSync(PI[0], [...PI[1], "--version"], { encoding: "utf8" }).trim(), platform: process.platform,
		pluginVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
		stamped: ["-F - heredoc with trailer", "-m \"$(cat <<'EOF' …)\"", "-F msg.txt (file untouched)"], untouched: ["fixture repository outside the project", "two claims"],
		notes: [...one.toolResults, ...two.toolResults].map((result) => result.text.split("\n").filter((line) => line.startsWith("DevSpec: Pi")).join(" ")).filter(Boolean),
		paidInference: 0, liveDevspecRecords: 0 }, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }
