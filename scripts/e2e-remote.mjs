/**
 * DevSpec-Pi — remote-control end-to-end smoke (slice 1).
 *
 * Drives a headless pi (RPC mode) through: bond → attach → agent posts an
 * answer into the attached DevSpec session → verify it landed → stop.
 * The final ingress leg (owner message from the web UI arriving as a pi user
 * message) is the human acceptance step — owner→agent addressing requires
 * the web app.
 *
 * Usage: node scripts/e2e-remote.mjs   (from the repo root, token resolved
 * via the extension's auth store / env)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const EXT = ["devspec-auth", "devspec-tools", "devspec-context", "devspec-remote"].map(
	(n) => `./extensions/${n}.ts`,
);

const { resolveToken } = await import("../extensions/core/auth-store.ts");
const { callDevspec } = await import("../extensions/core/client.ts");
const { unwrapMcpResult } = await import("../extensions/core/result.ts");

const resolved = await resolveToken();
if (!resolved) {
	console.error("No DevSpec token — /devspec.login or DEVSPEC_MCP_TOKEN first.");
	process.exit(1);
}
const token = resolved.token;
const cwd = new URL("..", import.meta.url).pathname;

function fail(msg) {
	console.error(`E2E FAIL: ${msg}`);
	process.exit(1);
}

// 1. Create the agent_remote_control session to attach to.
const sess = unwrapMcpResult(
	await callDevspec(token, "create_session", {
		session_type: "agent_remote_control",
		agent_name: "Pi",
		cwd,
	}, { cwd }),
);
if (sess.isError) fail(`create_session: ${sess.text.slice(0, 300)}`);
const sessionId = sess.details?.session_id;
if (!sessionId) fail(`no session_id in ${JSON.stringify(sess.details).slice(0, 300)}`);
console.log("session created:", sessionId);

// 2. Boot headless pi with the extensions.
const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", ...EXT.flatMap((e) => ["-e", e])], {
	cwd,
	stdio: ["pipe", "pipe", "inherit"],
});
const rl = createInterface({ input: pi.stdout });
const events = [];
rl.on("line", (line) => {
	try {
		const e = JSON.parse(line);
		events.push(e);
		if (e.type !== "message_update") console.log(`  [event ${e.type}]`, JSON.stringify(e).slice(0, 300));
	} catch { /* ignore non-JSON */ }
});

function send(cmd) {
	pi.stdin.write(`${JSON.stringify(cmd)}\n`);
}
function waitFor(pred, timeoutMs, what) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const t = setInterval(() => {
			const hit = events.find(pred);
			if (hit) { clearInterval(t); resolve(hit); }
			else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout waiting for ${what}`)); }
		}, 100);
	});
}

try {
	// 3. Bond + attach.
	send({ id: "remote", type: "prompt", message: `/devspec.remote --session ${sessionId}` });
	await waitFor((e) => e.type === "response" && e.id === "remote" && e.success === true, 30_000, "remote command ack");
	await new Promise((r) => setTimeout(r, 4000)); // let register+attach settle
	console.log("bonded + attached");

	// 4. Agent posts an answer into the attached session.
	const marker = `e2e-${Date.now()}`;
	send({
		id: "post",
		type: "prompt",
		message: `Post exactly this text into your bonded DevSpec session with post_session_message (complete_turn: true): "pi e2e ${marker}". Then reply with the single word DONE.`,
	});
	await waitFor(
		(e) => e.type === "message_end" && e.message?.role === "assistant" && JSON.stringify(e.message).includes("DONE"),
		120_000,
		"assistant DONE",
	);
	// Let the final tool result settle server-side before reading the transcript.
	await new Promise((r) => setTimeout(r, 2000));
	console.log("agent reported DONE");

	// 5. Verify the answer landed in the DevSpec transcript.
	const tx = unwrapMcpResult(
		await callDevspec(token, "get_session_transcript", { session_id: sessionId }, { cwd }),
	);
	if (tx.isError) fail(`get_session_transcript: ${tx.text.slice(0, 300)}`);
	const txText = JSON.stringify(tx.details ?? tx.text);
	if (!txText.includes(`pi e2e ${marker}`)) fail("marker not found in session transcript");
	console.log("transcript contains the posted answer ✔");

	// 6. Stop the bond.
	send({ id: "stop", type: "prompt", message: "/devspec.remote stop" });
	await waitFor((e) => e.type === "response" && e.id === "stop", 15_000, "stop ack");
	console.log("bond stopped");

	console.log("E2E PASS");
} catch (err) {
	fail(err.message);
} finally {
	pi.kill();
}
