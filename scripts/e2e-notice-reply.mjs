/** Actual disposable Pi RPC: a notice-woken run's final message reaches the room as
 * a reply to that notice, and nothing else (DevSpec item 6aad2b46).
 * node scripts/e2e-notice-reply.mjs [--scenario reply|refused|silent|unattached|queued]
 * Loopback MCP and a scripted provider only; no live room, paid model or real notice.
 * This is NOT a claim of deployed-server E2E: the wire receipt and refusal below are
 * the served shapes (post_session_message with system_notice_ids), played back.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { canonicalPoll, IDS } from "../tests/canonical-ingress-fixture.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const only = process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : null;
const SCENARIOS = ["reply", "refused", "silent", "unattached", "queued"].filter((s) => !only || s === only);
const COMMAND_FIELDS = ["command_turn_id", "command_message_id", "command_turn_unbound", "local_turn", "attempt_id", "assistant_source_id", "ingest_version", "expected_session_id", "turn_kind", "work_trail", "trail_events", "complete_turn", "needs_input", "reply_to_message_id", "phase"];
const REFUSAL = "Nothing was posted. A reply can name only notices DevSpec delivered to this connection. 17171717-1717-4171-8171-171717171717: DevSpec did not deliver this notice to this connection in this project.";

async function scenario(name) {
	const temp = mkdtempSync(join(tmpdir(), `pi-notice-reply-${name}-`));
	mkdirSync(join(temp, "agent/devspec"), { recursive: true, mode: 0o700 });
	writeFileSync(join(temp, "agent/devspec/settings.json"), JSON.stringify({ autoBond: false, preemptOwner: false }));
	const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	const native = uid(1), room = uid(3), attachment = uid(4), conn = IDS.connection;
	const attached = name !== "unattached";
	const now = new Date().toISOString();
	const session = join(temp, "session.jsonl");
	writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: native, cwd: temp, timestamp: now }) + "\n", { mode: 0o600 });
	const notice = { version: 1, kind: "server_notice", notice_id: IDS.notice, topic: "coherence_finding", notice_type: "duplicate", summary: "Confirmed duplicate: \"A\" duplicates \"B\".", prompt: "Tell your person in plain words unless they already know.", contract_uri: "devspec://product/remote-ingress-contract", records: [{ label: "Duplicate record", record_type: "task", record_id: uid(20), title: "B", text: "B", url: null }], allowed_outcomes: ["acknowledge_finding"], allowed_tools: ["get_task"] };
	const calls = [], events = [], errors = [], notifications = [], streams = new Set();
	let phase = "startup", noticePending = false, noticeOffered = false, ownerPending = false, ownerOffered = false, child;
	const response = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
	const base = (args = {}) => ({ connection_id: conn, session_id: attached ? room : null, attached_at: attached ? now : null, speech_attachment_id: attached ? attachment : null, changed: false, cursor_v2: null, dispatch_cursor: null, dispatches: [],
		...(args.system_notice_version === 2 ? { system_notice_version: 2, system_notice_cursor: null, system_notices: [] } : {}),
		...(args.interaction_event_version === 1 ? { interaction_event_version: 1, interaction_events: [], question_dismissal_event_version: 1, question_dismissal_events: [] } : {}) });
	const contract = { kind: "devspec.product.remote_ingress_contract", schema_version: 1, contract_version: "1.5.0", policy: { policy_version: "2026-09-18.1" } };
	function poll(args) {
		const style = args.sender_style_version === 1;
		if (ownerPending && !ownerOffered) {
			ownerOffered = true;
			return { ...base(args), ...canonicalPoll({ body: "OWNER-COMMAND-BODY", senderStyleNegotiated: style, systemNoticeNegotiated: args.system_notice_version === 2 }) };
		}
		if (noticePending && !noticeOffered && args.system_notice_version === 2) {
			noticeOffered = true;
			return { ...base(args), ...canonicalPoll({ wakeKind: "system_notice", systemNotices: [notice], senderStyleNegotiated: style, context: { human_context: [], agent_context: [], ai_context: [], system_context: [] } }) };
		}
		return base(args);
	}
	const server = createServer(async (req, res) => {
		if (req.method === "GET") { res.writeHead(200, { "Content-Type": "text/event-stream" }); streams.add(res); res.write("event: wake\ndata: {}\n\n"); res.on("close", () => streams.delete(res)); return; }
		try {
			let body = ""; for await (const b of req) body += b;
			const rpc = JSON.parse(body); let result = {};
			if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "notice-reply-probe", version: "1" }, capabilities: { tools: {}, resources: {} } };
			else if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
			else if (rpc.method === "resources/read") result = { contents: [{ uri: rpc.params.uri, mimeType: "application/json", text: JSON.stringify(contract) }] };
			else if (rpc.method === "tools/list") result = { tools: [] };
			else if (rpc.method === "tools/call") {
				const { name: tool, arguments: args = {} } = rpc.params;
				calls.push({ at: Date.now(), phase, name: tool, args });
				if (tool === "register_connection") result = { ...response({ ...base(), project_id: uid(10), codename: "Amber Hawk" }), _meta: { devspec: { connection_capability: { version: 1, value: "dvsc_fixture_only_12345678901234567890" } } } };
				else if (tool === "attach_connection") result = response(base());
				else if (tool === "poll_connection") result = response(poll(args));
				else if (tool === "get_session_transcript") result = response({ session: { id: room, title: "Notice reply probe" }, messages: [] });
				else if (tool === "post_session_message" && args.system_notice_ids) {
					if (name === "refused") result = { ...response({ delivery: { status: "rejected", reason: "notice_refused", retryable: false }, error: REFUSAL, refused: [{ notice_id: IDS.notice, reason: "not_delivered_to_connection", why: "DevSpec did not deliver this notice to this connection in this project" }] }), isError: true };
					else {
						const id = uid(500 + calls.length);
						result = response({ delivery: { status: "stored", message_id: id }, message_id: id, session_id: room, connection_id: conn, sort_key: 1, message_type: "external_agent", phase: "answer", notice_reply: { notice_ids: [...new Set(args.system_notice_ids.map((v) => v.toLowerCase()))].sort() }, turn_effect: "none", complete_turn: false });
					}
				}
				else if (tool === "post_session_message") { const id = uid(600 + calls.length); result = response({ connection_id: conn, session_id: room, phase: args.phase ?? "answer", turn_kind: args.turn_kind, assistant_source_id: args.assistant_source_id, message_id: id, delivery: { status: "stored", message_id: id } }); }
				else if (tool === "report_pickup") result = response({ outcome: "started", phase: "working", idempotent: false, attempt_id: uid(700), source_session_id: room });
				else result = response({ success: true });
			}
			res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
		} catch (e) { errors.push(String(e)); res.writeHead(500); res.end(); }
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const endpoint = `http://127.0.0.1:${server.address().port}/api/mcp`;
	const wake = () => { for (const s of streams) s.write("event: wake\ndata: {}\n\n"); };
	const until = async (pred, label, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return; if (errors.length) throw Error(errors.join("; ")); if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(`child exited at ${label}`); await new Promise((r) => setTimeout(r, 25)); } throw Error(`timeout: ${label}`); };
	const settled = () => events.filter((e) => e.type === "agent_settled" || e.type === "agent_end").length;
	const send = (id, message) => child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
	const trace = () => existsSync(join(temp, "provider-trace.jsonl")) ? readFileSync(join(temp, "provider-trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	try {
		child = spawn("pi", ["--mode", "rpc", "--offline", "--session", session, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools", "-e", resolve(root, "extensions/devspec-remote.ts"), "-e", resolve(root, "scripts/notice-reply-runtime-fixture.ts"), "--provider", "notice-probe", "--model", "scripted"], { cwd: temp, env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), TMPDIR: temp, DEVSPEC_MCP_TOKEN: "fixture-only-not-real", DEVSPEC_MCP_URL: endpoint, DEVSPEC_DEBUG_REMOTE: "1", NOTICE_PROBE_ROOT: temp, NOTICE_PROBE_MODE: name === "silent" ? "silent" : "reply" }, stdio: ["pipe", "pipe", "pipe"] });
		let pending = ""; const decoder = new StringDecoder("utf8");
		child.stdout.on("data", (b) => { pending += decoder.write(b); let i; while ((i = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, i); pending = pending.slice(i + 1); try { const e = JSON.parse(line); events.push({ at: Date.now(), phase, type: e.type, id: e.id, success: e.success }); if (e.type === "extension_ui_request" && e.method === "notify") notifications.push({ phase, level: e.notifyType, message: e.message }); if (e.type === "extension_error") errors.push(String(e.error)); } catch { errors.push("non-JSON stdout"); } } });
		child.stderr.on("data", (b) => { const t = String(b); if (!t.includes("ExperimentalWarning") && !t.includes("trace-warnings")) errors.push(t.slice(0, 500)); });
		send("bond", attached ? `/devspec.remote --session ${room}` : "/devspec.remote");
		await until(() => events.some((e) => e.id === "bond" && e.success), "bond");
		await until(() => calls.some((c) => c.name === "poll_connection"), "first poll");
		if (name === "queued") {
			phase = "owner"; ownerPending = true; wake();
			await until(() => existsSync(join(temp, "owner-started")), "owner command running");
			phase = "notice-while-busy"; noticePending = true; wake();
			await until(() => noticeOffered, "notice offered while the command runs");
			await new Promise((r) => setTimeout(r, 500));
			assert.equal(trace().filter((t) => t.notice).length, 0, "a notice never interrupts a running command");
			// The command's own settle (its answer, completion and idle) and the queued
			// notice run follow each other immediately; only ordering is checked here.
			phase = "after-command"; writeFileSync(join(temp, "owner-release"), "release");
		} else { phase = "notice"; noticePending = true; wake(); }
		const expectedRuns = name === "queued" ? 2 : 1;
		await until(() => trace().some((t) => t.notice) && settled() >= expectedRuns, "notice run settled");
		await new Promise((r) => setTimeout(r, 1500)); // let the settle post land
		const noticeCalls = calls.filter((c) => c.phase === "notice");
		const replies = calls.filter((c) => c.name === "post_session_message" && c.args.system_notice_ids);
		const noticeRequest = trace().find((t) => t.notice);
		// What the model was told about its final message.
		assert.match(noticeRequest.input, attached ? /posted to your DevSpec room as your reply to this notice/ : /not attached to a DevSpec room, so your final message stays in this terminal/);
		// Nothing in the notice run touched a turn, an attempt, Working or the speech writer.
		for (const c of noticeCalls) {
			assert(!["report_complete", "report_pickup", "report_keepalive", "report_request"].includes(c.name), `notice run called ${c.name}`);
			if (c.name === "heartbeat_connection") assert.notEqual(c.args.busy, true, "notice run claimed Working");
			if (c.name === "poll_connection") assert.notEqual(c.args.busy, true, "notice run polled as busy");
			if (c.name === "post_session_message") assert(c.args.system_notice_ids, `notice run posted outside the notice reply: ${JSON.stringify(Object.keys(c.args))}`);
		}
		assert.equal(notifications.filter((n) => /assistant speech storage not confirmed/.test(n.message)).length, 0, "no false speech warning for notice text");
		if (name === "reply" || name === "queued" || name === "refused") {
			assert.equal(replies.length, 1, "exactly one notice reply post");
			const args = replies[0].args;
			assert.deepEqual(args.system_notice_ids, [IDS.notice]);
			assert.equal(args.connection_id, conn);
			assert.equal(args.message, "NOTICE-REPLY-FINAL: DevSpec confirmed the duplicate; I closed mine.", "the run's last message, not its progress text");
			for (const field of COMMAND_FIELDS) assert.equal(Object.hasOwn(args, field), false, `notice reply carried ${field}`);
		} else assert.equal(replies.length, 0, "no notice reply post");
		if (name === "refused") {
			const shown = notifications.filter((n) => n.message.includes("notice_refused"));
			assert.equal(shown.length, 1, `refusal shown once: ${JSON.stringify(notifications)}`);
			assert(shown[0].message.includes(REFUSAL), "the server's own reason is shown");
		} else assert.deepEqual(notifications.filter((n) => n.phase === "notice" && n.level !== "info"), [], "no warnings in the terminal");
		if (name === "queued") {
			const ownerPosts = calls.filter((c) => c.name === "post_session_message" && !c.args.system_notice_ids);
			assert(ownerPosts.some((c) => c.args.message === "OWNER-ANSWER"), "the command's own answer is still posted");
			assert(ownerPosts.every((c) => !c.args.system_notice_ids), "the command's answer never names the notice");
			const ownerAnswerAt = ownerPosts.find((c) => c.args.message === "OWNER-ANSWER").at;
			assert(replies[0].at > ownerAnswerAt, "the notice runs after the command, then posts its own reply");
			assert(trace().findIndex((t) => t.notice) > trace().findIndex((t) => t.input?.includes("OWNER-COMMAND-BODY") && t.round === 1), "notice queued until the command finished");
		}
		assert.deepEqual(errors, []);
		return { scenario: name, result: "PASS", noticeReplyPosts: replies.length, notifications: notifications.filter((n) => n.phase !== "startup").map((n) => n.message), artifacts: temp };
	} catch (e) {
		return { scenario: name, result: "FAIL", error: String(e), artifacts: temp, calls: calls.slice(-12).map((c) => ({ phase: c.phase, name: c.name, keys: Object.keys(c.args) })), events: events.slice(-12), notifications, errors };
	} finally {
		writeFileSync(join(temp, "transport.json"), JSON.stringify(calls, null, 2));
		if (child && child.exitCode === null && child.signalCode === null) { child.stdin.end(); await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }
		for (const s of streams) s.destroy(); server.closeAllConnections(); await new Promise((r) => server.close(r));
	}
}

const results = [];
for (const name of SCENARIOS) results.push(await scenario(name));
const summary = { result: results.every((r) => r.result === "PASS") ? "PASS" : "FAIL", hostVersion: execFileSync("pi", ["--version"], { encoding: "utf8" }).trim(), pluginVersion: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version, liveServer: false, paidModels: 0, scenarios: results };
console.log(JSON.stringify(summary, null, 2));
if (summary.result !== "PASS") process.exitCode = 1;
