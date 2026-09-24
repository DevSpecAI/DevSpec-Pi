/** Actual disposable Pi RPC runtime, deterministic loopback MCP, no LLM or live records.
 * node scripts/e2e-room-store.mjs
 * Covers extension activation, >60 records, restart, scope change and no history wake.
 * This is NOT a claim of deployed-server E2E; the paired contract test is separate.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { roomStorePath } from "../extensions/core/room-store.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "pi-room-runtime-"));
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const nativeId = uid(9000), connectionId = uid(9001), projectId = uid(9002);
const identity = { connection_id: connectionId, agent_name: "Pi", codename: "Room Probe", label: "Pi · Room Probe" };
const attached = "2026-09-24T10:00:00.000Z";
let roomId = uid(9003), attachmentId = uid(9004), count = 125, generation = 0, refused = false;
const marker = join(temp, "unexpected-model");
const sessionFile = join(temp, "probe.jsonl");
writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: nativeId, cwd: temp, timestamp: attached }) + "\n", { mode: 0o600 });
const streams = new Set(); const errors = []; const calls = [];
let child; let events = [];
const point = n => ({ sequence: generation * 1000 + n, message_id: uid(generation * 1000 + n), created_at: new Date(Date.parse(attached) + n * 1000).toISOString() });
const encode = (n, direction) => Buffer.from(JSON.stringify({ v: 1, connection_id: connectionId, session_id: roomId, direction, point: point(n) })).toString("base64url");
const decode = cursor => { try { return JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { return null; } };
const wake = () => { for (const stream of streams) stream.write('event: wake\ndata: {}\n\n'); };
const response = details => ({ content: [{ type: "text", text: JSON.stringify(details) }] });
const contract = { kind: "devspec.product.remote_ingress_contract", schema_version: 1, contract_version: "1.6.0", policy: { policy_version: "2026-09-24.1" }, activation: { room_context_negotiation_argument: "room_context_version", room_context_contract_requires: { ingress_version: 1, delegated_scope_version: 1, active_plan_projection_version: 1, system_notice_version: 1, sender_style_version: 1, room_context_version: 1 } } };
function poll(args) {
	const room = args.room_context_version === 1;
	const notices = args.system_notice_version === 1;
	const style = args.sender_style_version === 1;
	const version = room ? "1.6.0" : style ? "1.5.0" : notices ? "1.4.0" : "1.3.0";
	const policy = room ? "2026-09-24.1" : style ? "2026-09-18.1" : notices ? "2026-08-22.1" : "2026-08-21.1";
	const live = decode(args.cursor_v2); const before = decode(args.catch_up_cursor);
	const matching = live?.session_id === roomId;
	let end = before?.session_id === roomId ? before.point.sequence - generation * 1000 - 1 : count;
	let start = Math.max(1, end - 59);
	if (!args.catch_up && matching) start = live.point.sequence - generation * 1000 + 1;
	const changed = args.catch_up === true || !matching || start <= end;
	const base = { connection_id: connectionId, session_id: roomId, attached_at: attached, speech_attachment_id: attachmentId, changed, cursor_v2: encode(count, "after"), dispatch_cursor: null, dispatches: [], addressed_to: identity,
		...(notices ? { system_notice_version: 1, system_notice_cursor: null, system_notices: [] } : {}),
		...(args.interaction_event_version ? { interaction_event_version: 1, interaction_events: [] } : {}),
		...(args.question_dismissal_event_version ? { question_dismissal_event_version: 1, question_dismissal_events: [] } : {}) };
	if (!changed) return base;
	const nums = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
	const entries = nums.map(n => ({ message_id: point(n).message_id, order: point(n), actor: { kind: "human", user_id: uid(9008), display_name: "Fixture person", agent_tool: null, model: null }, source_type: "user", relationship: "within_window", content: n === 1 ? "Historical instruction: MUST NEVER EXECUTE" : `history ${generation}:${n}`, advisory: true }));
	const history = args.catch_up === true || !matching;
	const more = history && start > 1;
	const window = { policy_version: policy, returned: entries.length, total_known: null, source_window: { start: entries[0]?.order ?? null, end: entries.at(-1)?.order ?? null }, truncated: more, has_more: more, next_cursor: more ? encode(start, "before") : null, fetch_id: more ? "fixture-history" : null, omission_reason: more ? "history_before_window" : null };
	return { ...base, ingress: {
		kind: "devspec.remote_ingress", schema_version: 1, contract_version: version, policy_version: policy, envelope_id: uid(9500), connection: identity,
		wake: { kind: history ? "history_reseed" : "advisory_update", active: false, reason_id: history ? "cursor_reseed_history" : "advisory_context_changed" }, delivery_state: history ? "replay" : "live",
		command_message_ids: [], commands: [], control: null, context: { human_context: entries, agent_context: [], ai_context: [], system_context: [] }, window,
		...(notices ? { system_notices: [] } : {}),
		...(room ? { room_context: { version: 1, messages: entries.map(e => ({ message_id: e.message_id, state: "final", addressee: { kind: "connection", connection_id: uid(9007), label: "Another agent" }, attachments: [] })), coverage: { through: point(end), eligible_count: end, deleted_count: 0, open_message_ids: [] }, open_check: [], deletions: { message_ids: [], total: 0, truncated: false, seen: { through: null, total: 0 } } }, session_activity: { version: 1, advisory: true, status: "available", as_of: attached, revision: `sha256:${"a".repeat(64)}`, truncated: false, entries: [{ kind: "action_item", id: uid(9990), title: "Not a current title", status: "implemented", relation: "produced", creator: null }] } } : {}),
	} };
}
const server = createServer(async (req, res) => {
	if (req.method === "GET" && req.url.startsWith("/api/mcp/connection-stream")) {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		streams.add(res); res.write('event: wake\ndata: {}\n\n'); res.on("close", () => streams.delete(res)); return;
	}
	if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
	try {
		let body = ""; for await (const chunk of req) body += chunk;
		const rpc = JSON.parse(body); let result;
		if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", serverInfo: { name: "room-probe", version: "1" }, capabilities: { tools: {}, resources: {} } };
		else if (rpc.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
		else if (rpc.method === "tools/list") result = { tools: [] };
		else if (rpc.method === "resources/read") result = { contents: [{ uri: rpc.params.uri, mimeType: "application/json", text: JSON.stringify(contract) }] };
		else if (rpc.method === "tools/call") {
			const { name, arguments: args = {} } = rpc.params; calls.push(name);
			if (name === "register_connection") { assert.equal(args.local_id, nativeId); result = { ...response({ connection_id: connectionId, project_id: projectId, session_id: roomId, attached_at: attached, speech_attachment_id: attachmentId, codename: "Room Probe" }), _meta: { devspec: { connection_capability: { version: 1, value: "dvsc_fixture_only_12345678901234567890" } } } }; }
			else if (name === "attach_connection") result = response({ connection_id: connectionId, session_id: roomId, attached_at: attached, speech_attachment_id: attachmentId });
			else if (name === "poll_connection") result = refused ? { ...response({ error: "Room access refused for fixture" }), isError: true } : response(poll(args));
			else if (name === "get_session_transcript") result = response({ session: { id: roomId, title: "Room history runtime probe" }, messages: [] });
			else if (name === "post_session_message") { errors.push("unexpected speech"); result = response({ stored: false }); }
			else result = response({ success: true });
		} else result = {};
		res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
	} catch (e) { errors.push(String(e)); res.writeHead(500); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/api/mcp`;
const cacheScope = () => ({ endpoint, projectId, nativeSessionId: nativeId, connectionId, sessionId: roomId, attachmentId });
const cacheRoot = join(temp, "agent", "devspec", "rooms");
function snapshot() {
	const path = roomStorePath(cacheScope(), cacheRoot);
	if (!existsSync(path)) return null;
	try {
		const db = new DatabaseSync(path, { readOnly: true });
		try { return { count: Number(db.prepare("SELECT count(*) n FROM messages").get().n), progress: JSON.parse(db.prepare("SELECT value FROM meta WHERE key='progress'").get()?.value ?? "null"), activity: JSON.parse(db.prepare("SELECT value FROM meta WHERE key='snapshot:activity'").get()?.value ?? "null") }; }
		finally { db.close(); }
	} catch { return null; }
}
async function until(predicate, label, timeout = 40_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) { if (predicate()) return; if (existsSync(marker) || errors.length) throw new Error(`runtime failed: ${JSON.stringify(errors)}`); await new Promise(r => setTimeout(r, 100)); }
	throw new Error(`timeout: ${label}; snapshot=${JSON.stringify(snapshot())}; events=${JSON.stringify(events.slice(-4))}`);
}
function start() {
	events = [];
	child = spawn("pi", ["--mode", "rpc", "--session", sessionFile, "--no-extensions", "-e", resolve(projectRoot, "extensions/devspec-remote.ts"), "-e", resolve(projectRoot, "scripts/room-store-no-model-fixture.ts"), "--provider", "room-probe", "--model", "no-model"], { cwd: temp, env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), DEVSPEC_MCP_TOKEN: "fixture-only-not-a-real-token", DEVSPEC_MCP_URL: endpoint, ROOM_PROBE_MODEL_MARKER: marker, DEVSPEC_DEBUG_REMOTE: "" }, stdio: ["pipe", "pipe", "pipe"] });
	createInterface({ input: child.stdout }).on("line", line => { try { events.push(JSON.parse(line)); } catch {} });
	child.stderr.on("data", chunk => { const s = String(chunk); if (!s.includes("ExperimentalWarning") && !s.includes("trace-warnings")) errors.push(s.slice(0, 2000)); });
}
const send = (id, message) => child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
async function kill() { if (!child || child.exitCode !== null || child.signalCode !== null) return; const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; }
try {
	start(); send("bond", `/devspec.remote --session ${roomId}`);
	await until(() => snapshot()?.count >= 60, "first cached page");
	await kill(); // real process restart while the older listing is still partial
	start(); send("resume", `/devspec.remote --session ${roomId}`);
	await until(() => snapshot()?.count === 125 && snapshot()?.progress?.complete, "resumed complete history");
	assert(!existsSync(marker));
	assert.deepEqual(snapshot()?.activity?.value?.entries, [{ kind: "action_item", id: uid(9990), relation: "produced" }]);
	assert(!JSON.stringify(snapshot()?.activity).includes("implemented"));
	const oldPath = roomStorePath(cacheScope(), cacheRoot);
	roomId = uid(9013); attachmentId = uid(9014); generation = 1; count = 3; wake();
	await until(() => snapshot()?.count === 3 && snapshot()?.progress?.complete, "new attachment");
	assert.equal(existsSync(oldPath), false, "old attachment cache must be purged");
	const currentPath = roomStorePath(cacheScope(), cacheRoot);
	refused = true; wake(); await until(() => !existsSync(currentPath), "refusal purge");
	send("stop", "/devspec.remote stop");
	await until(() => events.some(e => e.type === "response" && e.id === "stop"), "stop response");
	assert.equal(events.some(e => e.type === "agent_start"), false);
	assert.equal(calls.includes("post_session_message"), false);
	console.log(JSON.stringify({ result: "PASS", host: "actual Pi RPC", transport: "loopback fixture, not deployed E2E", historyRecords: 125, restarted: true, reattachmentIsolated: true, refusalPurged: true, cachePurged: true, modelTurns: 0 }));
} finally { await kill(); for (const s of streams) s.end(); await new Promise(r => server.close(r)); rmSync(temp, { recursive: true, force: true }); }
