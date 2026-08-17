import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseSubagentFleetReply,
	SubagentFleetClient,
	type SubagentEventBus,
} from "../extensions/core/subagent-fleet.ts";

class FakeBus implements SubagentEventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	requests: Array<Record<string, unknown>> = [];
	respond = true;
	fleet: Record<string, unknown> = {
		version: 1,
		entries: [],
		totalActive: 0,
		omitted: 0,
	};
	capability = true;

	on(event: string, handler: (data: unknown) => void): () => void {
		const listeners = this.handlers.get(event) ?? new Set();
		listeners.add(handler);
		this.handlers.set(event, listeners);
		return () => listeners.delete(handler);
	}

	emit(event: string, data: unknown): void {
		if (event === "subagents:rpc:v1:request") {
			const request = data as Record<string, unknown>;
			this.requests.push(request);
			if (!this.respond) return;
			const requestId = request.requestId as string;
			const method = request.method;
			queueMicrotask(() => this.emit(`subagents:rpc:v1:reply:${requestId}`, {
				version: 1,
				requestId,
				method,
				success: true,
				data: method === "ping"
					? { capabilities: this.capability ? { fleetStatus: { version: 1 } } : {} }
					: { fleet: this.fleet, text: "private terminal rendering must not be parsed" },
			}));
			return;
		}
		for (const handler of this.handlers.get(event) ?? []) handler(data);
	}
}

function successReply(fleet: unknown): unknown {
	return { version: 1, requestId: "request", success: true, data: { fleet } };
}

test("public fleet DTO becomes bounded child activity without private fields", () => {
	const aliases = new Map<string, string>();
	const parsed = parseSubagentFleetReply(successReply({
		version: 1,
		entries: [{
			key: "opaque-upstream-key",
			agent: "worker",
			role: "implementation",
			model: "gpt-5.6-sol",
			effort: "high",
			startedAt: 1_000,
			tokens: { input: 123, output: 456, total: 579 },
			goal: "private prompt-like goal",
			runId: "secret-run-id",
			asyncDir: "/private/path",
		}],
		totalActive: 1,
		omitted: 0,
	}), 3_500, (key) => {
		const alias = aliases.get(key) ?? `child-${aliases.size + 1}`;
		aliases.set(key, alias);
		return alias;
	});

	assert.deepEqual(parsed, {
		children: [{
			key: "child-1",
			agent: "implementation (worker)",
			status: "running",
			model: "gpt-5.6-sol",
			thinking: "high",
			durationMs: 2_500,
		}],
		totalActive: 1,
		omitted: 0,
		observedAt: 3_500,
		summary: "1 child agent active",
	});
	const serialized = JSON.stringify(parsed);
	for (const secret of ["opaque-upstream-key", "private prompt-like goal", "secret-run-id", "/private/path", "123", "456", "579"]) {
		assert.ok(!serialized.includes(secret), secret);
	}
});

test("client negotiates fleetStatus v1, deduplicates refresh, and keeps stable local child keys", async () => {
	const bus = new FakeBus();
	bus.fleet = {
		version: 1,
		entries: [{ key: "opaque-a", agent: "worker", startedAt: 1_000 }],
		totalActive: 1,
		omitted: 0,
	};
	let now = 2_000;
	const client = new SubagentFleetClient(bus, 50, () => now);
	const [first, duplicate] = await Promise.all([client.refresh(), client.refresh()]);
	assert.deepEqual(first, duplicate);
	assert.equal(bus.requests.filter((request) => request.method === "ping").length, 1);
	assert.equal(bus.requests.filter((request) => request.method === "status").length, 1);
	assert.equal(first?.children[0]?.key, "child-1");

	now = 3_000;
	const second = await client.refresh();
	assert.equal(second?.children[0]?.key, "child-1");
	assert.equal(second?.children[0]?.durationMs, 2_000);
	assert.equal(bus.requests.filter((request) => request.method === "ping").length, 1);
	assert.equal(bus.requests.filter((request) => request.method === "status").length, 2);
	client.dispose();
});

test("overflow is explicit and malformed or unsupported DTOs fail to the generic row", async () => {
	const parsed = parseSubagentFleetReply(successReply({
		version: 1,
		entries: [{ key: "one", agent: "worker", startedAt: 1_000 }],
		totalActive: 4,
		omitted: 3,
	}), 2_000, () => "child-1");
	assert.equal(parsed?.summary, "4 child agents active · 3 not shown");
	assert.equal(parsed?.omitted, 3);
	assert.equal(parseSubagentFleetReply(successReply({ version: 2, entries: [], totalActive: 0, omitted: 0 }), 0, String), null);
	assert.equal(parseSubagentFleetReply(successReply({
		version: 1,
		entries: [{ key: "one", agent: "worker", startedAt: 1_000 }],
		totalActive: 0,
		omitted: 0,
	}), 2_000, String), null);
	assert.equal(parseSubagentFleetReply({ version: 1, success: false }, 0, String), null);

	const unsupportedBus = new FakeBus();
	unsupportedBus.capability = false;
	const unsupported = new SubagentFleetClient(unsupportedBus, 20);
	assert.equal(await unsupported.refresh(), null);
	assert.equal(unsupportedBus.requests.filter((request) => request.method === "status").length, 0);
	unsupported.dispose();

	const absentBus = new FakeBus();
	absentBus.respond = false;
	const absent = new SubagentFleetClient(absentBus, 1);
	assert.equal(await absent.refresh(), null);
	assert.equal(await absent.refresh(), null);
	assert.equal(absentBus.requests.length, 1, "an absent optional extension is not polled repeatedly");
	absent.dispose();
});
