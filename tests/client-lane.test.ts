import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	callDevspec,
	DevspecToolError,
	readDevspecResource,
	resetClientCache,
	setLaneClientFactoryForTests,
	type LaneClient,
} from "../extensions/core/client.ts";

afterEach(() => {
	setLaneClientFactoryForTests(null);
	resetClientCache();
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolError(text: string) {
	return { isError: true, content: [{ type: "text", text }] };
}

function okResult(id: string) {
	return { content: [{ type: "text", text: id }] };
}

function fakeClient(opts: {
	callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
	readResource?: (uri: string) => Promise<unknown>;
}): LaneClient & { closeCount: number; closedAt: number | null } {
	const client = {
		closeCount: 0,
		closedAt: null as number | null,
		callTool: async (request: { name: string; arguments?: Record<string, unknown> }) =>
			opts.callTool(request.name, request.arguments),
		readResource: async (request: { uri: string }) =>
			opts.readResource ? opts.readResource(request.uri) : { contents: [] },
		close: async () => {
			client.closeCount += 1;
			client.closedAt = Date.now();
		},
	};
	return client;
}

test("two overlapping work-lane successes share one client and do not serialise", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	let connects = 0;
	setLaneClientFactoryForTests(async () => {
		connects += 1;
		return fakeClient({
			callTool: async (name) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await delay(40);
				inFlight -= 1;
				return okResult(name);
			},
		});
	});

	const started = Date.now();
	const [a, b] = await Promise.all([
		callDevspec("tok", "get_memory", { id: "a" }),
		callDevspec("tok", "get_memory", { id: "b" }),
	]);
	const elapsed = Date.now() - started;

	assert.equal(connects, 1);
	assert.ok(maxInFlight >= 2, `expected overlapping calls, maxInFlight=${maxInFlight}`);
	assert.ok(elapsed < 100, `serialised calls would take ~80ms, elapsed=${elapsed}`);
	assert.deepEqual((a as { content: Array<{ text: string }> }).content[0]?.text, "get_memory");
	assert.deepEqual((b as { content: Array<{ text: string }> }).content[0]?.text, "get_memory");
});

test("sibling isError does not close the shared client or kill the other verb", async () => {
	const work = fakeClient({
		callTool: async (name) => {
			if (name === "search_resources") return toolError("sessionless");
			await delay(40);
			return okResult("memory-body");
		},
	});
	let connects = 0;
	setLaneClientFactoryForTests(async () => {
		connects += 1;
		return work;
	});

	const [memory, refused] = await Promise.allSettled([
		callDevspec("tok", "get_memory", { id: "x" }),
		callDevspec("tok", "search_resources", { query: "q" }),
	]);

	assert.equal(memory.status, "fulfilled");
	assert.equal((memory.value as { content: Array<{ text: string }> }).content[0]?.text, "memory-body");
	assert.equal(refused.status, "rejected");
	assert.ok(refused.reason instanceof DevspecToolError);
	assert.match((refused.reason as Error).message, /sessionless/);
	assert.equal(work.closeCount, 0);
	assert.equal(connects, 1);
});

test("isError is surfaced after one request, not retried as transport", async () => {
	let calls = 0;
	setLaneClientFactoryForTests(async () =>
		fakeClient({
			callTool: async () => {
				calls += 1;
				return toolError("sessionless");
			},
		}),
	);

	await assert.rejects(
		() => callDevspec("tok", "search_resources", { query: "q" }),
		(err: unknown) => {
			assert.ok(err instanceof DevspecToolError);
			assert.match((err as Error).message, /sessionless/);
			return true;
		},
	);
	assert.equal(calls, 1);
});

test("transport retry does not close a client that still has an in-flight sibling", async () => {
	let connects = 0;
	const clients: Array<ReturnType<typeof fakeClient>> = [];
	let slowStarted = false;
	let slowFinished = false;
	let slowFinishedAt = 0;

	setLaneClientFactoryForTests(async () => {
		connects += 1;
		const generation = connects;
		const client = fakeClient({
			callTool: async (name) => {
				if (name === "slow") {
					slowStarted = true;
					await delay(60);
					slowFinished = true;
					slowFinishedAt = Date.now();
					return okResult("slow-ok");
				}
				if (generation === 1) throw new Error("MCP error -32000: Connection closed");
				return okResult("retry-ok");
			},
		});
		clients.push(client);
		return client;
	});

	const [slow, retried] = await Promise.allSettled([
		callDevspec("tok", "slow", {}),
		callDevspec("tok", "fast", {}),
	]);

	assert.equal(slow.status, "fulfilled");
	assert.equal(retried.status, "fulfilled");
	assert.ok(slowStarted && slowFinished);
	assert.ok(connects >= 2, "fast should reconnect after Connection closed");
	const first = clients[0]!;
	assert.ok(first.closeCount >= 1, "retired first client should close after drain");
	assert.ok(
		first.closedAt !== null && first.closedAt >= slowFinishedAt,
		`close() at ${first.closedAt} must not precede sibling finish at ${slowFinishedAt}`,
	);
});

test("work-lane isError does not close the pump client", async () => {
	const pump = fakeClient({
		callTool: async () => {
			await delay(30);
			return okResult("poll-ok");
		},
	});
	const work = fakeClient({
		callTool: async () => toolError("sessionless"),
	});
	setLaneClientFactoryForTests(async ({ lane }) => (lane === "pump" ? pump : work));

	const [poll, refused] = await Promise.allSettled([
		callDevspec("tok", "poll_connection", {}, { lane: "pump" }),
		callDevspec("tok", "search_resources", { query: "q" }, { lane: "work" }),
	]);

	assert.equal(poll.status, "fulfilled");
	assert.equal(refused.status, "rejected");
	assert.equal(pump.closeCount, 0);
	assert.equal(work.closeCount, 0);
});

test("readDevspecResource does not close the work lane on a sibling isError", async () => {
	const work = fakeClient({
		callTool: async () => toolError("sessionless"),
		readResource: async () => {
			await delay(40);
			return { contents: [{ uri: "devspec://product/implementation-contract", text: "{}" }] };
		},
	});
	setLaneClientFactoryForTests(async () => work);

	const [resource, refused] = await Promise.allSettled([
		readDevspecResource("tok", "devspec://product/implementation-contract"),
		callDevspec("tok", "search_resources", { query: "q" }),
	]);

	assert.equal(resource.status, "fulfilled");
	assert.equal(refused.status, "rejected");
	assert.equal(work.closeCount, 0);
});

const SCOPE_ERROR =
	"This call needs a project and you can access more than one. Pass project_id, or pass git_remote (from `git remote get-url origin`) so DevSpec can match a tracked repo.";

test("cwd attaches folder facts on the first call, not after a scope error", async (t) => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { execFileSync } = await import("node:child_process");
	const dir = await mkdtemp(join(tmpdir(), "devspec-client-first-scope-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
	execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: dir, stdio: "pipe" });

	const seen: Array<Record<string, unknown> | undefined> = [];
	const work = fakeClient({
		callTool: async (_name, args) => {
			seen.push(args);
			return okResult("ok");
		},
	});
	setLaneClientFactoryForTests(async () => work);

	await callDevspec("tok", "register_connection", { local_id: "sess" }, { cwd: dir, lane: "pump" });
	assert.equal(seen.length, 1);
	assert.equal(seen[0]?.git_remote, "git@github.com:acme/app.git");
	assert.equal(seen[0]?.local_id, "sess");
	assert.equal(work.closeCount, 0);
});

test("isError project-scope retries once with folder facts on the same client", async () => {
	const seen: Array<Record<string, unknown> | undefined> = [];
	const work = fakeClient({
		callTool: async (_name, args) => {
			seen.push(args);
			if (!args?.git_remote && !args?.pinned_project_id) return toolError(SCOPE_ERROR);
			return okResult("ok");
		},
	});
	setLaneClientFactoryForTests(async () => work);

	const raw = await callDevspec("tok", "get_memory", { id: "x" });
	assert.equal(seen.length, 2);
	assert.equal(seen[0]?.git_remote, undefined);
	assert.equal(typeof seen[1]?.git_remote, "string");
	assert.match(String(seen[1]?.git_remote), /DevSpec-Pi/);
	assert.equal((raw as { content: Array<{ text: string }> }).content[0]?.text, "ok");
	assert.equal(work.closeCount, 0);
});

test("isError project-scope retry does not re-init the client", async () => {
	let connects = 0;
	const seen: string[] = [];
	setLaneClientFactoryForTests(async () => {
		connects += 1;
		return fakeClient({
			callTool: async (_name, args) => {
				seen.push(args?.git_remote ? "scoped" : "bare");
				if (!args?.git_remote) return toolError(SCOPE_ERROR);
				return okResult("ok");
			},
		});
	});

	await callDevspec("tok", "search_tasks", { query: "x" });
	assert.deepEqual(seen, ["bare", "scoped"]);
	assert.equal(connects, 1);
});

test("a host-frozen endpoint isolates the lane and survives reconnect without adopting current config", async (t) => {
	const old = process.env.DEVSPEC_MCP_URL;
	t.after(() => { if (old === undefined) delete process.env.DEVSPEC_MCP_URL; else process.env.DEVSPEC_MCP_URL = old; });
	process.env.DEVSPEC_MCP_URL = "https://new-login.invalid/api/mcp";
	const opened: Array<{ token: string; url: string; connectionCapability?: string }> = [];
	setLaneClientFactoryForTests(async ({ token, url, connectionCapability }) => {
		opened.push({ token, url, connectionCapability });
		const index = opened.length;
		return fakeClient({ callTool: async () => {
			if (index === 1) throw new Error("fetch failed");
			return okResult("ok");
		} });
	});
	await callDevspec("original-token", "report_commit_provenance", { connection_id: "original-connection" }, {
		endpoint: "https://original.invalid/api/mcp", connectionCapability: "original-capability",
	});
	assert.equal(opened.length, 2);
	for (const binding of opened) assert.deepEqual(binding, {
		token: "original-token", url: "https://original.invalid/api/mcp", connectionCapability: "original-capability",
	});
});
