/**
 * DevSpec-Pi — push channel e2e (item 0026da9f).
 *
 * Registers a connection, attaches it to a fresh remote-control session,
 * opens the SSE push channel, then moves the room (posts a message as the
 * agent). Expects a wake frame within a few seconds — proving the channel
 * delivers without any long-poll hold.
 *
 * Usage: node scripts/e2e-push-channel.mjs
 */

const { resolveToken, resolveEndpoint } = await import("../extensions/core/auth-store.ts");
const { callDevspec } = await import("../extensions/core/client.ts");
const { unwrapMcpResult } = await import("../extensions/core/result.ts");
const { openPushChannel } = await import("../extensions/core/push-channel.ts");

const resolved = await resolveToken();
if (!resolved) {
	console.error("No DevSpec token.");
	process.exit(1);
}
const cwd = new URL("..", import.meta.url).pathname;
const token = resolved.token;

function fail(msg) {
	console.error(`E2E FAIL: ${msg}`);
	process.exit(1);
}

// Session + bond + attach.
const sess = unwrapMcpResult(
	await callDevspec(token, "create_session", { session_type: "agent_remote_control", agent_name: "Pi", cwd }, { cwd }),
);
const sessionId = sess.details?.session_id;
if (!sessionId) fail(`create_session: ${sess.text.slice(0, 200)}`);

const localId = `push-e2e-${Date.now()}`;
const reg = unwrapMcpResult(
	await callDevspec(token, "register_connection", { local_id: localId, agent_name: "Pi", cwd }, { cwd }),
);
const connId = reg.details?.connection_id;
if (!connId) fail(`register: ${reg.text.slice(0, 200)}`);
const att = unwrapMcpResult(
	await callDevspec(token, "attach_connection", { connection_id: connId, session_id: sessionId }, { cwd }),
);
if (att.isError) fail(`attach: ${att.text.slice(0, 200)}`);
console.log("bonded + attached:", connId);

// Open the push channel.
const controller = new AbortController();
let woke = false;
let wakeAt = 0;
let helloSeen = false;
const openedAt = Date.now();
const channel = openPushChannel({
	mcpUrl: await resolveEndpoint(),
	token,
	connectionId: connId,
	signal: controller.signal,
	handlers: {
		onWake: () => {
			if (!woke) {
				woke = true;
				wakeAt = Date.now();
			}
		},
		onEnded: (r) => console.log("ended frame:", r),
		onClose: (r) => console.log("channel closed:", r),
	},
}).catch((err) => fail(`openPushChannel: ${err.message}`));
void channel;
console.log("push channel open");

// Give the stream a moment, then move the room.
await new Promise((r) => setTimeout(r, 1500));
const marker = `push-e2e ${Date.now()}`;
await callDevspec(token, "post_session_message", {
	connection_id: connId,
	message: marker,
}, { cwd });
console.log("room moved:", marker);

// Expect a wake well inside one marker interval (allow generous margin for CI).
const deadline = Date.now() + 15_000;
while (!woke && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

controller.abort();
await callDevspec(token, "heartbeat_connection", {
	connection_id: connId, status: "offline", end_reason: "local_stop",
}, { cwd });

if (!woke) fail("no wake frame within 15s of room activity");
console.log(`wake received ${wakeAt - openedAt}ms after channel open ✔`);
console.log("E2E PASS");
