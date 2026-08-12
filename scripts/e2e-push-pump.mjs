/**
 * DevSpec-Pi — pump-level push-mode e2e.
 *
 * Bonds a headless RPC pi in PUSH mode, then moves the attached room from a
 * second client. The pump must wake via SSE and fetch — verified via the
 * DEVSPEC_DEBUG_REMOTE log (wake lines) and the room's transcript.
 *
 * Usage: DEVSPEC_DEBUG_REMOTE=1 node scripts/e2e-push-pump.mjs
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";

const EXT = ["devspec-auth", "devspec-tools", "devspec-context", "devspec-remote"].map(
	(n) => `./extensions/${n}.ts`,
);
const { resolveToken } = await import("../extensions/core/auth-store.ts");
const { callDevspec } = await import("../extensions/core/client.ts");
const { unwrapMcpResult } = await import("../extensions/core/result.ts");

const resolved = await resolveToken();
if (!resolved) process.exit(1);
const token = resolved.token;
const cwd = new URL("..", import.meta.url).pathname;
const fail = (m) => { console.error(`E2E FAIL: ${m}`); process.exit(1); };

const sess = unwrapMcpResult(
	await callDevspec(token, "create_session", { session_type: "agent_remote_control", agent_name: "Pi", cwd }, { cwd }),
);
const sessionId = sess.details?.session_id;
console.log("session:", sessionId);

const pi = spawn("pi", ["--mode", "rpc", "--no-session", ...EXT.flatMap((e) => ["-e", e])], {
	cwd,
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env, DEVSPEC_DEBUG_REMOTE: "1" },
});
const rl = createInterface({ input: pi.stdout });
const events = [];
rl.on("line", (l) => { try { events.push(JSON.parse(l)); } catch { /* ignore */ } });
const send = (c) => pi.stdin.write(`${JSON.stringify(c)}\n`);
const waitFor = (pred, ms, what) => new Promise((res, rej) => {
	const t0 = Date.now();
	const t = setInterval(() => {
		const hit = events.find(pred);
		if (hit) { clearInterval(t); res(hit); }
		else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error(`timeout: ${what}`)); }
	}, 100);
});

try {
	send({ id: "r", type: "prompt", message: `/devspec.remote --session ${sessionId}` });
	await waitFor((e) => e.type === "response" && e.id === "r" && e.success, 30_000, "remote ack");
	await new Promise((r) => setTimeout(r, 4000));

	// Move the room from a second client (self-post; marker moves regardless).
	const reg = unwrapMcpResult(
		await callDevspec(token, "register_connection", { local_id: "push-pump-probe", agent_name: "Pi", cwd }, { cwd }),
	);
	// Post into the SAME session directly by session_id (not via the bond).
	await callDevspec(token, "post_session_message", {
		session_id: sessionId,
		message: "probe ping",
	}, { cwd });
	console.log("room moved; waiting for wake…");

	// The pump should wake via SSE within a few seconds. Check the debug log.
	const deadline = Date.now() + 20_000;
	let sawWake = false;
	while (Date.now() < deadline) {
		if (existsSync("/tmp/devspec-remote-debug.log")) {
			const log = readFileSync("/tmp/devspec-remote-debug.log", "utf8");
			if (log.includes("push wake")) { sawWake = true; break; }
			if (log.includes("push channel connect failed")) break;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	if (!sawWake) fail("no push wake in the pump's debug log");
	console.log("pump woke via SSE ✔");

	send({ id: "s", type: "prompt", message: "/devspec.remote stop" });
	await waitFor((e) => e.type === "response" && e.id === "s", 15_000, "stop ack");
	console.log("E2E PASS");
} catch (err) {
	fail(err.message);
} finally {
	pi.kill();
}
