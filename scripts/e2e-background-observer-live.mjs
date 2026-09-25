/** Disposable staging-only actual Pi/provider check. No paid model.
 * Create a dedicated test room, then provide OBSERVER_LIVE_SESSION and
 * BACKGROUND_PROBE_ROOT (an empty private directory). The operator observes
 * Working in the browser, creates job-0-release, then job-1-release, observes
 * live idle, and creates finish. Never use an occupied human room.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { resolveToken, resolveEndpoint } from "../extensions/core/auth-store.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = process.env.BACKGROUND_PROBE_ROOT;
const room = process.env.OBSERVER_LIVE_SESSION;
const provider = process.env.PI_BACKGROUND_EXTENSION;
assert(temp && isAbsolute(temp) && room && /^[0-9a-f-]{36}$/i.test(room), "Explicit disposable room and absolute probe directory required");
assert(provider && isAbsolute(provider) && existsSync(provider), "Installed public background provider required");
const endpoint = await resolveEndpoint();
assert.equal(new URL(endpoint).origin, "https://app.devspecstaging.com", "This check never runs against production");
const auth = await resolveToken();
assert(auth, "Authenticate the host normally before testing");
mkdirSync(temp, { recursive: true, mode: 0o700 });
const session = join(temp, "native.jsonl");
assert(!existsSync(session), "Use a fresh probe directory");
const native = randomUUID();
writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: native, cwd: temp, timestamp: new Date().toISOString() }) + "\n", { mode: 0o600 });
const events = [], failures = [];
const child = spawn("pi", ["--mode", "rpc", "--offline", "--session", session, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
	"-e", provider, "-e", resolve(root, "extensions/devspec-remote.ts"), "-e", resolve(root, "scripts/background-observer-live-fixture.ts"),
	"--provider", "background-observer-probe", "--model", "scripted"], {
	cwd: temp, env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), TMPDIR: temp, PI_BG_FEATURES: "process", PI_BG_DOCK_SHORTCUT: "off",
		DEVSPEC_MCP_TOKEN: auth.token, DEVSPEC_MCP_URL: endpoint, DEVSPEC_DEBUG_REMOTE: "1", BACKGROUND_PROBE_TRACE: join(temp, "provider-metadata.jsonl"),
		BACKGROUND_PROBE_ROOT: temp, BACKGROUND_PROBE_RACE: "0" }, stdio: ["pipe", "pipe", "pipe"],
});
const send = (id, message) => child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
let pending = ""; const decoder = new StringDecoder("utf8");
child.stdout.on("data", chunk => {
	pending += decoder.write(chunk); let end;
	while ((end = pending.indexOf("\n")) >= 0) {
		const line = pending.slice(0, end); pending = pending.slice(end + 1);
		try {
			const e = JSON.parse(line);
			events.push({ type: e.type, id: e.id, success: e.success, customType: e.message?.customType });
			if (e.type === "extension_error") failures.push(`${e.event}: extension failed`);
		} catch { failures.push("non-JSON host output"); }
	}
});
child.stderr.on("data", chunk => {
	const value = String(chunk);
	if (!value.includes("ExperimentalWarning") && !value.includes("trace-warnings")) failures.push("host stderr; inspect private runtime artifacts");
});
const until = async (predicate, label, timeout = 60_000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		if (failures.length || child.exitCode !== null || child.signalCode !== null) throw new Error(`${label}: host failed`);
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error(`timeout: ${label}`);
};
const rows = () => { const text = readFileSync(session, "utf8"); return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line)); };
const observations = () => rows().filter(row => row.type === "custom" && row.customType === "devspec-background-observation");
const terminals = () => new Set(observations().filter(row => row.data.task.state === "completed").map(row => row.data.task.id));
const phase = value => writeFileSync(join(temp, "phase.json"), JSON.stringify({ phase: value, room, native, at: new Date().toISOString() }), { mode: 0o600 });
try {
	send("bond", `/devspec.remote --session ${room}`);
	await until(() => events.some(e => e.id === "bond" && e.success), "bond");
	send("status", "/observer-probe-status");
	await until(() => events.some(e => e.id === "status" && e.success), "metadata");
	send("work", "BACKGROUND-OBSERVER-PROBE");
	await until(() => events.some(e => e.type === "agent_settled"), "foreground settled");
	assert.equal(new Set(observations().map(row => row.data.task.id)).size, 2);
	phase("two_jobs_running");
	await until(() => terminals().size === 1, "operator releases first job", 300_000);
	phase("one_job_running");
	await until(() => terminals().size === 2, "operator releases second job", 300_000);
	send("idle-status", "/observer-probe-status");
	await until(() => events.some(e => e.id === "idle-status" && e.success), "native idle metadata");
	assert.equal(events.filter(e => e.type === "agent_start").length, 1);
	assert.equal(events.filter(e => e.customType === "background-task-notification").length, 0);
	phase("both_terminal_check_server_and_browser");
	await until(() => existsSync(join(temp, "finish")), "operator finishes server/browser observation", 300_000);
	console.log(JSON.stringify({ result: "PASS", scope: "actual Pi and installed provider against staging; server/browser observations recorded separately", room, native, artifacts: temp }));
} catch (error) { console.error(JSON.stringify({ result: "FAIL", error: String(error), room, native, artifacts: temp })); process.exitCode = 1; }
finally {
	for (const n of [0, 1]) writeFileSync(join(temp, `job-${n}-release`), "cleanup");
	writeFileSync(join(temp, "host-metadata.json"), JSON.stringify(events, null, 2), { mode: 0o600 });
	if (child.exitCode === null && child.signalCode === null) {
		send("stop", "/devspec.remote stop");
		await until(() => events.some(e => e.id === "stop"), "disconnect", 15_000).catch(() => {});
		child.stdin.end();
		await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
}
