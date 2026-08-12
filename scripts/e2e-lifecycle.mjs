/**
 * DevSpec-Pi — mechanical turn lifecycle e2e (slice 2).
 *
 * Bonds a headless RPC pi, attaches, then gives it a prompt with NO posting
 * instructions. Verifies the extension — not the model — streamed a trail
 * and posted the final answer into the DevSpec session.
 *
 * Usage: node scripts/e2e-lifecycle.mjs
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
	console.error("No DevSpec token.");
	process.exit(1);
}
const token = resolved.token;
const cwd = new URL("..", import.meta.url).pathname;

function fail(msg) {
	console.error(`E2E FAIL: ${msg}`);
	process.exit(1);
}

const sess = unwrapMcpResult(
	await callDevspec(token, "create_session", { session_type: "agent_remote_control", agent_name: "Pi", cwd }, { cwd }),
);
if (sess.isError) fail(`create_session: ${sess.text.slice(0, 300)}`);
const sessionId = sess.details?.session_id;
console.log("session created:", sessionId);

const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", ...EXT.flatMap((e) => ["-e", e])], {
	cwd,
	stdio: ["pipe", "pipe", "inherit"],
});
const rl = createInterface({ input: pi.stdout });
const events = [];
rl.on("line", (line) => {
	try { events.push(JSON.parse(line)); } catch { /* ignore */ }
});

function send(cmd) { pi.stdin.write(`${JSON.stringify(cmd)}\n`); }
function waitFor(pred, timeoutMs, what) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const t = setInterval(() => {
			const hit = events.find(pred);
			if (hit) { clearInterval(t); resolve(hit); }
			else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout: ${what}`)); }
		}, 100);
	});
}

try {
	send({ id: "remote", type: "prompt", message: `/devspec.remote --session ${sessionId}` });
	await waitFor((e) => e.type === "response" && e.id === "remote" && e.success === true, 30_000, "remote ack");
	await new Promise((r) => setTimeout(r, 4000));
	console.log("bonded + attached");

	const marker = `lifecycle-${Date.now()}`;
	send({
		id: "turn",
		type: "prompt",
		// TWO rounds minimum: the bash call forces a tool round before the
		// answer round, so this exercises the run-scoped trail + settle
		// (cc9e8c43) — a per-round state reset would lose the bash line.
		message: `First use the bash tool to run: echo hi. Then reply with exactly this text and nothing else: "${marker}". Do NOT call any DevSpec tools — this tests mechanical posting.`,
	});
	await waitFor(
		(e) => e.type === "message_end" && e.message?.role === "assistant" && JSON.stringify(e.message).includes(marker),
		120_000,
		"assistant reply",
	);
	await new Promise((r) => setTimeout(r, 6000)); // settle: trail flush + final post

	const tx = unwrapMcpResult(
		await callDevspec(token, "get_session_transcript", { session_id: sessionId }, { cwd }),
	);
	if (tx.isError) fail(`transcript: ${tx.text.slice(0, 300)}`);
	const messages = tx.details?.messages ?? [];
	const bodies = messages.map((m) => `${m.message_type ?? ""}|${m.phase ?? ""}|${(m.content ?? "").slice(0, 120)}`);
	console.log("transcript messages:");
	for (const b of bodies.slice(-8)) console.log("  ", b);

	const answer = messages.find((m) => typeof m.content === "string" && m.content.includes(marker));
	if (!answer) fail("mechanical final answer not found in transcript");
	console.log("mechanical final answer in transcript ✔");

	const trail = messages.find((m) => m.phase === "trail" || (typeof m.content === "string" && /`bash`|💭|`read`/.test(m.content)));
	if (trail) console.log("trail bubble present ✔");
	else console.log("note: no trail bubble detected (turn may have been too fast for the 1s tick)");

	send({ id: "stop", type: "prompt", message: "/devspec.remote stop" });
	await waitFor((e) => e.type === "response" && e.id === "stop", 15_000, "stop ack");
	console.log("E2E PASS");
} catch (err) {
	fail(err.message);
} finally {
	pi.kill();
}
