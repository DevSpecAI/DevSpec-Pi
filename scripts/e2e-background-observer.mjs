/** Actual Pi + installed public background provider, loopback DevSpec, no paid model.
 * PI_BACKGROUND_EXTENSION=/absolute/path/to/pi-background-tasks/dist/extensions/background-tasks.js node scripts/e2e-background-observer.mjs
 * This qualifies host observation/idle drain, not a deployed-server/browser test.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPoll, IDS, TEST_CONNECTION } from "../tests/canonical-ingress-fixture.ts";

const race = process.argv.includes("--foreground-race");
const provider = process.env.PI_BACKGROUND_EXTENSION;
if (!provider || !isAbsolute(provider) || !existsSync(provider)) throw new Error("Set PI_BACKGROUND_EXTENSION to the installed provider's published background-tasks entrypoint");
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-background-observer-"));
const room = "01010101-0101-4101-8101-010101010101";
const native = "02020202-0202-4202-8202-020202020202";
const attachment = "03030303-0303-4303-8303-030303030303";
const attached = new Date().toISOString();
const session = join(temp, "probe.jsonl");
const trace = join(temp, "provider-metadata.jsonl");
writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: native, cwd: temp, timestamp: attached }) + "\n", { mode: 0o600 });
const calls = [], events = [], failures = [], streams = new Set();
let child, enabled = false, offered = false;
const textResult = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const base = () => ({ connection_id: IDS.connection, project_id: IDS.project, session_id: room, attached_at: attached, speech_attachment_id: attachment,
	changed: false, cursor_v2: "probe-cursor", dispatch_cursor: null, dispatches: [], addressed_to: TEST_CONNECTION,
	interaction_event_version: 1, interaction_events: [], question_dismissal_event_version: 1, question_dismissal_events: [], system_notice_version: 1, system_notice_cursor: null, system_notices: [] });
function poll(args) {
	if (!enabled || offered) return { ...base(), ...(!enabled ? canonicalPoll({ wakeKind: "history_reseed", deliveryState: "replay", senderStyleNegotiated: args.sender_style_version === 1 }) : {}) };
	offered = true;
	return { ...base(), ...canonicalPoll({ body: "BACKGROUND-OBSERVER-PROBE", senderStyleNegotiated: args.sender_style_version === 1,
		context: { human_context: [], agent_context: [], ai_context: [], system_context: [] } }) };
}
const server = createServer(async (req, res) => {
	if (req.method === "GET") { res.writeHead(200, { "Content-Type": "text/event-stream" }); streams.add(res); res.write("event: wake\ndata: {}\n\n"); res.on("close", () => streams.delete(res)); return; }
	try {
		let body = ""; for await (const chunk of req) body += chunk;
		const rpc = JSON.parse(body); let result = {};
		if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "background-probe", version: "1" }, capabilities: { tools: {}, resources: {} } };
		else if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
		else if (rpc.method === "tools/list") result = { tools: [] };
		else if (rpc.method === "resources/read") result = { contents: [{ uri: rpc.params.uri, mimeType: "application/json", text: JSON.stringify({ kind: "devspec.product.remote_ingress_contract", schema_version: 1, contract_version: "1.5.0", policy: { policy_version: "2026-09-18.1" } }) }] };
		else if (rpc.method === "tools/call") {
			const { name, arguments: args = {} } = rpc.params;
			calls.push({ at: Date.now(), name, busy: args.busy ?? null, sourceId: args.assistant_source_id ?? null, phase: args.phase ?? null,
				commandTurnId: args.command_turn_id ?? null, commandMessageId: args.command_message_id ?? null, reason: args.reason ?? null });
			if (name === "register_connection") result = { ...textResult({ ...base(), codename: "Amber Hawk" }), _meta: { devspec: { connection_capability: { version: 1, value: "dvsc_fixture_only_12345678901234567890" } } } };
			else if (name === "attach_connection") result = textResult(base());
			else if (name === "poll_connection") result = textResult(poll(args));
			else if (name === "get_session_transcript") result = textResult({ session: { id: room, title: "Background observation probe" }, messages: [] });
			else if (name === "post_session_message") result = textResult({ connection_id: IDS.connection, session_id: room, message_id: IDS.resource,
				phase: args.phase ?? "answer", turn_kind: args.turn_kind, assistant_source_id: args.assistant_source_id,
				delivery: { status: "stored", message_id: IDS.resource } });
			else if (name === "report_complete") result = textResult({ connection_id: IDS.connection, command_turn_id: args.command_turn_id,
				command_message_id: args.command_message_id, attempt_id: args.attempt_id, phase: "done" });
			else result = textResult({ success: true });
		}
		res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
	} catch (error) { failures.push(String(error)); res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/api/mcp`;
const until = async (predicate, label, timeout = 30_000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		if (failures.length) throw new Error(`probe failure at ${label}: ${failures.join("; ")}`);
		if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`child exited at ${label}`);
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error(`timeout: ${label}`);
};
const entries = () => {
	const text = readFileSync(session, "utf8");
	return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
};
const observations = () => entries().filter(row => row.type === "custom" && row.customType === "devspec-background-observation").map(row => row.data);
const terminalIds = () => new Set(observations().filter(row => row.task.state === "completed").map(row => row.task.id));
try {
	child = spawn("pi", ["--mode", "rpc", "--offline", "--session", session, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
		"-e", provider, "-e", resolve(root, "extensions/devspec-remote.ts"), "-e", resolve(root, "scripts/background-observer-runtime-fixture.ts"),
		"--provider", "background-observer-probe", "--model", "scripted"], {
		cwd: temp, env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), TMPDIR: temp, PI_BG_FEATURES: "process", PI_BG_DOCK_SHORTCUT: "off",
			DEVSPEC_MCP_TOKEN: "fixture-only-not-real", DEVSPEC_MCP_URL: endpoint, DEVSPEC_DEBUG_REMOTE: "1", BACKGROUND_PROBE_TRACE: trace,
			BACKGROUND_PROBE_ROOT: temp, BACKGROUND_PROBE_RACE: race ? "1" : "0" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let pending = ""; const decoder = new StringDecoder("utf8");
	child.stdout.on("data", chunk => {
		pending += decoder.write(chunk); let end;
		while ((end = pending.indexOf("\n")) >= 0) {
			const line = pending.slice(0, end); pending = pending.slice(end + 1);
			try { const event = JSON.parse(line); events.push({ at: Date.now(), type: event.type, id: event.id, success: event.success,
				role: event.message?.role, customType: event.message?.customType, stopReason: event.message?.stopReason, toolName: event.toolName });
				if (event.type === "extension_error") failures.push(`${event.event}: ${event.error}`);
			} catch { failures.push("non-JSON host output"); }
		}
	});
	child.stderr.on("data", chunk => { const message = String(chunk); if (!message.includes("ExperimentalWarning") && !message.includes("trace-warnings")) failures.push(message.slice(0, 1000)); });
	child.stdin.write(JSON.stringify({ id: "bond", type: "prompt", message: `/devspec.remote --session ${room}` }) + "\n");
	await until(() => events.some(event => event.id === "bond" && event.success) && calls.some(call => call.name === "poll_connection"), "bond and first poll");
	enabled = true; for (const stream of streams) stream.write("event: wake\ndata: {}\n\n");
	await until(() => events.some(event => event.type === "agent_settled"), "foreground park");
	const settledAt = events.find(event => event.type === "agent_settled").at;
	assert.equal(calls.some(call => call.name === "report_complete" && call.commandTurnId === IDS.turn), false,
		"the exact command must not complete while jobs run (startup unbound cleanup is a different identity)");
	writeFileSync(join(temp, "job-0-release"), "release");
	await until(() => terminalIds().size === 1, "first terminal observation");
	assert.equal(calls.some(call => call.name === "report_complete" && call.commandTurnId === IDS.turn), false, "first job cannot consume its still-running sibling");
	let newerStartedAt;
	if (race) {
		child.stdin.write(JSON.stringify({ id: "newer", type: "prompt", message: "NEWER-FOREGROUND" }) + "\n");
		await until(() => existsSync(join(temp, "foreground-started")), "newer foreground held");
		newerStartedAt = Date.now();
	}
	writeFileSync(join(temp, "job-1-release"), "release");
	await until(() => terminalIds().size === 2, "second terminal observation");
	if (race) {
		assert.equal(calls.some(call => call.name === "report_complete" && call.at >= newerStartedAt), false, "background terminal callback cannot complete newer foreground");
		assert.equal(calls.some(call => call.name === "heartbeat_connection" && call.busy === false && call.at >= newerStartedAt), false);
		writeFileSync(join(temp, "foreground-release"), "release");
		await until(() => events.filter(event => event.type === "agent_settled").length === 2, "newer foreground settles normally");
	} else {
		await until(() => calls.some(call => call.name === "report_complete" && call.commandTurnId === IDS.turn && call.commandMessageId === IDS.command), "exact idle completion without model wake");
	}
	await until(() => calls.some(call => call.name === "heartbeat_connection" && call.busy === false && call.at > settledAt), "idle heartbeat");
	const observed = observations();
	const terminal = observed.filter(row => row.task.state === "completed");
	assert.equal(new Set(terminal.map(row => row.task.id)).size, 2);
	assert.equal(events.filter(event => event.type === "agent_start").length, race ? 2 : 1, "terminal observation must not wake model");
	assert.equal(events.filter(event => event.customType === "background-task-notification").length, 0, "notices disabled");
	assert.equal(calls.filter(call => call.sourceId).length, race ? 2 : 1, "one mechanical copy per authored final speech");
	assert.equal(JSON.stringify(observed).includes("command"), false, "no provider commands in observation journal");
	assert(terminal.every(row => typeof row.task.startTime === "number"));
	const result = { result: "PASS", actualHost: "Pi RPC with installed public background provider", liveServer: false, paidModelRequests: 0,
		scenario: race ? "newer_foreground_protected" : "exact_idle_completion", controlledJobs: true,
		jobs: 2, notifications: 0, modelRuns: race ? 2 : 1, sourceSpeechCopies: race ? 2 : 1,
		exactCommandCompletion: !race, newerForegroundProtected: race, artifacts: temp };
	writeFileSync(join(temp, "summary.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ result: "FAIL", error: String(error), artifacts: temp, calls: calls.slice(-12), events: events.slice(-8), failures }, null, 2)); process.exitCode = 1; }
finally {
	writeFileSync(join(temp, "transport-metadata.json"), JSON.stringify(calls, null, 2));
	writeFileSync(join(temp, "host-metadata.json"), JSON.stringify(events, null, 2));
	if (child && child.exitCode === null && child.signalCode === null) { child.stdin.end(); await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }
	for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
