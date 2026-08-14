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

const EXT = [
	...["devspec-auth", "devspec-tools", "devspec-context", "devspec-remote"].map(
		(n) => `./extensions/${n}.ts`,
	),
	"./scripts/e2e-background-fixture.ts",
];

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
function assistantText(event) {
	if (event.type !== "message_end" || event.message?.role !== "assistant") return "";
	return (event.message.content ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}
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
	await new Promise((r) => setTimeout(r, 15000)); // settle: trail flush + final post

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

	// Phase 2 (item b1fb756a): a mid-run followUp is a DELIVERY BOUNDARY —
	// each message's answer must be its own bubble. Prompt A produces an
	// early answer text, then sleeps (keeping the run alive); prompt B
	// injects mid-run. Expected: the bubble for A closes with A's text at
	// the boundary, and B's answer closes its own row — never one row with
	// the run's last text replacing everything.
	const m1 = `seg-one-${Date.now()}`;
	const m2 = `seg-two-${Date.now()}`;
	send({
		id: "turn-a",
		type: "prompt",
		message: `Reply with exactly "${m1}" and nothing else. Then use the bash tool to run: sleep 10. Then reply with exactly "tail-${m1}". Do NOT call any DevSpec tools.`,
	});
	// Let round 1 (the m1 text) complete, then inject mid-run during the sleep.
	// streamingBehavior:'followUp' is the production pump's delivery mode
	// (deliverAs:'followUp') — and is REQUIRED while busy: a bare prompt is
	// rejected silently otherwise (rpc.md).
	await new Promise((r) => setTimeout(r, 5000));
	send({
		id: "turn-b",
		type: "prompt",
		streamingBehavior: "followUp",
		message: `Reply with exactly "${m2}" and nothing else. Do NOT call any DevSpec tools.`,
	});
	await waitFor((e) => e.type === "response" && e.id === "turn-b" && e.success === true, 15_000, "turn-b accepted (queued)");
	await waitFor(
		(e) => e.type === "message_end" && e.message?.role === "assistant" && JSON.stringify(e.message).includes(m2),
		120_000,
		"segment-2 reply",
	);
	await new Promise((r) => setTimeout(r, 15000)); // settle: boundary close + final post

	const tx2 = unwrapMcpResult(
		await callDevspec(token, "get_session_transcript", { session_id: sessionId }, { cwd }),
	);
	const messages2 = tx2.details?.messages ?? [];
	const rowA = messages2.find((m) => m.message_type === "external_agent" && typeof m.content === "string" && m.content.includes(m1) && !m.content.includes(m2));
	const rowB = messages2.find((m) => m.message_type === "external_agent" && typeof m.content === "string" && m.content.includes(m2));
	if (!rowA) fail(`segment-1 bubble missing or contaminated (expected its own row containing ${m1})`);
	if (!rowB) fail(`segment-2 bubble missing (expected its own row containing ${m2})`);
	if (rowA.id === rowB.id) fail("both segments collapsed onto one row — the boundary did not fire");
	console.log("segment bubbles: one per message ✔");

	// Phase 3 (item 15cb0983): overlapping automatic-wake tasks remain owned
	// by the original remote turn until EACH matching terminal notification
	// arrives. Completion A must not consume B. Process closes before B are
	// silent; B's substantive recap is delivered exactly once.
	const taskA = `overlap-a-${Date.now()}`;
	const taskB = `overlap-b-${Date.now()}`;
	const parked = `overlap-parked-${Date.now()}`;
	const between = `overlap-between-${Date.now()}`;
	const recap = `overlap-recap-${Date.now()}`;
	send({
		id: "overlap",
		type: "prompt",
		message: [
			"Call bg_run exactly twice in the SAME assistant response, with these exact arguments:",
			`1. {\"id\":\"${taskA}\",\"delay_ms\":6000,\"completion_instruction\":\"Task A completed. Reply with exactly ${between} and nothing else.\"}`,
			`2. {\"id\":\"${taskB}\",\"delay_ms\":14000,\"completion_instruction\":\"Task B completed. Reply with exactly ${recap} and nothing else.\"}`,
			`After both tool calls return, reply with exactly ${parked} and nothing else.`,
			"Do not call any other tools.",
		].join("\n"),
	});
	await waitFor(
		(e) => assistantText(e).includes(parked),
		120_000,
		"overlap parked close",
	);
	await waitFor(
		(e) => assistantText(e).includes(recap),
		120_000,
		"overlap final recap",
	);
	await new Promise((r) => setTimeout(r, 15000));

	const tx3 = unwrapMcpResult(
		await callDevspec(token, "get_session_transcript", { session_id: sessionId }, { cwd }),
	);
	if (tx3.isError) fail(`overlap transcript: ${tx3.text.slice(0, 300)}`);
	const external3 = (tx3.details?.messages ?? []).filter((m) => m.message_type === "external_agent");
	const recapRows = external3.filter((m) => typeof m.content === "string" && m.content.includes(recap));
	if (recapRows.length !== 1) fail(`expected exactly one overlap recap bubble; found ${recapRows.length}`);
	if (external3.some((m) => typeof m.content === "string" && m.content.includes(parked))) {
		fail("initial overlap process close became a room answer");
	}
	if (external3.some((m) => typeof m.content === "string" && m.content.includes(between))) {
		fail("task A completion consumed sibling B and became a room answer");
	}
	console.log("overlapping background tasks: final recap once, process closes silent ✔");

	send({ id: "stop", type: "prompt", message: "/devspec.remote stop" });
	await waitFor((e) => e.type === "response" && e.id === "stop", 15_000, "stop ack");
	console.log("E2E PASS");
} catch (err) {
	fail(err.message);
} finally {
	pi.kill();
}
