import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundWorkObserver, backgroundTaskFromLaunch, backgroundTasksFromManagement, projectBackgroundTask, type BackgroundEventBus, type BackgroundObservation } from "../extensions/core/background-observer.ts";

const REQUEST = "pi-background-tasks:request:v1";
const RESPONSE = "pi-background-tasks:response:v1";
const TERMINAL = "pi-background-tasks:terminal:v1";
const responseSchema = "pi-background-tasks.extension-response.v1";
const terminalSchema = "pi-background-tasks.extension-terminal.v1";
type Request = { request_id: string; operation: string; payload: { taskId?: string } };
class Bus implements BackgroundEventBus {
	listeners = new Map<string, Set<(value: unknown) => void>>();
	requests: Request[] = [];
	handle: ((request: Request) => void) | null = null;
	on(event: string, callback: (value: unknown) => void) {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(callback); this.listeners.set(event, listeners);
		return () => { listeners.delete(callback); };
	}
	emit(event: string, value: unknown) {
		if (event === REQUEST) { this.requests.push(value as Request); this.handle?.(value as Request); }
		for (const callback of this.listeners.get(event) ?? []) callback(value);
	}
	reply(request: Request, result: unknown, ok = true) {
		this.emit(RESPONSE, { schema_version: responseSchema, request_id: request.request_id, operation: request.operation, ok, result });
	}
	finish(id: string, status = "completed", startTime = 1) {
		this.emit(TERMINAL, { schema_version: terminalSchema, task: { id, startTime, status, command: "SECRET", outputPath: "/private", token: "SECRET" } });
	}
}
function fixture(options = {}) {
	const bus = new Bus(); const changes: BackgroundObservation[] = [];
	const observer = new BackgroundWorkObserver(bus, value => changes.push(value), { timeoutMs: 20, ...options });
	observer.bind("native-A/attachment-A");
	return { bus, observer, changes, track: (id: string, startTime = 1) => observer.track({ id, startTime, state: "running" }, "native-A/attachment-A") };
}
function provider(bus: Bus, status: (request: Request) => unknown) {
	bus.handle = request => bus.reply(request, request.operation === "capabilities" ? { api_version: 1, status: true } : status(request));
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("successful launches are owned independently of both notification flags", () => {
	for (const notify of [true, false]) for (const wake of [true, false]) {
		const result = { details: { task: { id: "job", startTime: 1, status: "running", notifyOnCompletion: notify, triggerOnCompletion: wake, command: "SECRET" } } };
		assert.deepEqual(backgroundTaskFromLaunch("bg_run", result), { id: "job", startTime: 1, state: "running" });
		assert.equal(backgroundTaskFromLaunch("bg_status", result), null);
		assert.equal(backgroundTaskFromLaunch("bg_run", result, true), null);
	}
	for (const tool of ["bg_delegate", "bg_run_pi_attested", "fusion_reason", "fusion_investigate", "fusion_research", "fusion_validate"]) {
		assert.equal(backgroundTaskFromLaunch(tool, { task: { id: "job", startTime: 1, status: "completed" } })?.state, "completed");
	}
});

test("management observations preserve exact identity and cannot adopt foreign work", () => {
	const { observer, track } = fixture(); track("owned");
	const values = backgroundTasksFromManagement("bg_status", { tasks: [
		{ id: "owned", startTime: 1, status: "killed", command: "SECRET" },
		{ id: "foreign", startTime: 1, status: "completed" },
		{ id: "malformed", status: "completed" },
	] });
	assert.equal(values.length, 2);
	assert.equal(observer.observe(values[1]!, "native-A/attachment-A"), false);
	assert.equal(observer.observe({ ...values[0]!, startTime: 99 }, "native-A/attachment-A"), false);
	assert.deepEqual(observer.pendingIds(), ["owned"]);
	assert.equal(observer.observe(values[0]!, "native-A/attachment-A"), true);
	assert.deepEqual(observer.pendingIds(), []);
	assert.deepEqual(backgroundTasksFromManagement("bg_status", { tasks: values }, true), []);
	assert.deepEqual(backgroundTasksFromManagement("bg_logs", { tasks: values }), []);
	assert.equal(backgroundTasksFromManagement("bg_kill", { details: { task: { id: "owned", startTime: 1, status: "killed" } } })[0]?.state, "killed");
	observer.dispose();
});

test("provider metadata projection rejects malformed identity and never retains content", () => {
	assert.deepEqual(projectBackgroundTask({ id: "job", startTime: 2, status: "failed", command: "SECRET", outputPath: "private", error: "token" }), { id: "job", startTime: 2, state: "failed" });
	for (const bad of [null, [], {}, { id: "job", startTime: 1, status: "unknown" }, { id: " job ", startTime: 1, status: "running" }, { id: "job", startTime: NaN, status: "running" }, { id: "job", startTime: -1, status: "running" }]) assert.equal(projectBackgroundTask(bad), null);
	const { observer } = fixture();
	observer.track({ id: "job", startTime: 1, state: "running", secret: "DO-NOT-RETAIN" } as any, "native-A/attachment-A");
	assert.equal(JSON.stringify(observer.snapshot()).includes("DO-NOT-RETAIN"), false);
	const exposed = observer.snapshot(); exposed.tasks[0]!.state = "completed";
	assert.deepEqual(observer.pendingIds(), ["job"], "caller cannot mutate internal state");
	observer.dispose();
});

test("terminal events resolve exactly owned jobs and are idempotent", () => {
	const { bus, observer, changes, track } = fixture(); track("a"); track("b");
	bus.finish("foreign"); bus.finish("a", "completed", 99);
	assert.deepEqual(observer.pendingIds(), ["a", "b"]);
	bus.finish("a"); const count = changes.length; bus.finish("a");
	assert.equal(changes.length, count); assert.deepEqual(observer.pendingIds(), ["b"]);
	bus.finish("b", "killed"); assert.deepEqual(observer.pendingIds(), []);
	assert.equal(JSON.stringify(changes).includes("SECRET"), false);
	observer.dispose();
});

test("fast completion before launch receipt is remembered but does not adopt foreign work", () => {
	const { bus, observer, track } = fixture();
	bus.finish("fast"); assert.deepEqual(observer.snapshot().tasks, []);
	track("fast"); assert.deepEqual(observer.pendingIds(), []);
	assert.equal(observer.snapshot().tasks[0]!.state, "completed");
	assert.equal(observer.track({ id: "late-other-room", startTime: 1, state: "running" }, "native-A/old-attachment"), false);
	observer.dispose();
});

test("bounded early-terminal eviction is recovered by status, never guessed terminal", async () => {
	const { bus, observer, track } = fixture({ earlyLimit: 1 });
	bus.finish("a"); bus.finish("b"); track("a");
	assert.deepEqual(observer.pendingIds(), ["a"]);
	provider(bus, request => ({ tasks: [{ id: request.payload.taskId, startTime: 1, status: "completed" }] }));
	await observer.refresh(); assert.deepEqual(observer.pendingIds(), []);
	observer.dispose();
});

test("status resolves missing-notice completion without a model turn", async () => {
	const { bus, observer, track } = fixture(); track("no-notice");
	provider(bus, () => ({ tasks: [{ id: "no-notice", startTime: 1, status: "completed" }] }));
	await observer.refresh(); assert.deepEqual(observer.pendingIds(), []);
	assert.deepEqual(bus.requests.map(r => r.operation), ["capabilities", "status"]);
	assert.deepEqual(bus.requests[1]!.payload, { taskId: "no-notice" });
	observer.dispose();
});

test("unavailable capabilities remain unknown and are retried on a later explicit refresh", async () => {
	const { bus, observer, track } = fixture(); track("job");
	await observer.refresh(); assert.deepEqual(observer.pendingIds(), ["job"]);
	assert.equal(observer.snapshot().tasks[0]!.state, "unknown");
	provider(bus, () => ({ tasks: [{ id: "job", startTime: 1, status: "failed" }] }));
	await observer.refresh(); assert.deepEqual(observer.pendingIds(), []);
	observer.dispose();
});

test("missing, malformed, foreign, identity-mismatched or unknown status resolves nothing", async () => {
	for (const result of [null, { tasks: [] }, { tasks: [{ id: "foreign", startTime: 1, status: "completed" }] }, { tasks: [{ id: "job", startTime: 2, status: "completed" }] }, { tasks: [{ id: "job", startTime: 1, status: "unknown" }] }]) {
		const { bus, observer, track } = fixture(); track("job"); provider(bus, () => result);
		await observer.refresh(); assert.deepEqual(observer.pendingIds(), ["job"]); assert.equal(observer.snapshot().tasks[0]!.state, "unknown"); observer.dispose();
	}
});

test("a terminal event wins over an older in-flight running snapshot", async () => {
	const { bus, observer, track } = fixture(); track("job"); let status: Request | undefined;
	bus.handle = request => { if (request.operation === "capabilities") bus.reply(request, { api_version: 1, status: true }); else status = request; };
	const waiting = observer.refresh(); await tick(); assert.ok(status);
	bus.finish("job"); bus.reply(status, { tasks: [{ id: "job", startTime: 1, status: "running" }] });
	await waiting; assert.deepEqual(observer.pendingIds(), []); observer.dispose();
});

test("same scope refreshes are deduplicated, work is bounded and later batches are fair", async () => {
	const { bus, observer, track } = fixture({ batchSize: 2, concurrency: 1 });
	for (const id of ["a", "b", "c", "d", "e"]) track(id);
	provider(bus, request => ({ tasks: [{ id: request.payload.taskId, startTime: 1, status: "running" }] }));
	const one = observer.refresh(); assert.equal(observer.refresh(), one); await one;
	assert.equal(bus.requests.filter(r => r.operation === "status").length, 2);
	await observer.refresh(); await observer.refresh();
	assert.deepEqual(new Set(bus.requests.filter(r => r.operation === "status").map(r => r.payload.taskId)), new Set(["a", "b", "c", "d", "e"]));
	observer.dispose();
});

test("scope changes cancel old requests and cannot mutate a newer attachment", async () => {
	const { bus, observer, track } = fixture(); track("job"); let old: Request | undefined;
	bus.handle = request => { if (request.operation === "capabilities") bus.reply(request, { api_version: 1, status: true }); else old = request; };
	const waiting = observer.refresh(); await tick(); assert.ok(old);
	observer.bind("native-B/attachment-B");
	observer.track({ id: "job", startTime: 2, state: "running" }, "native-B/attachment-B");
	bus.reply(old, { tasks: [{ id: "job", startTime: 1, status: "completed" }] }); bus.finish("job");
	await waiting; assert.deepEqual(observer.snapshot(), { scope: "native-B/attachment-B", tasks: [{ id: "job", startTime: 2, state: "running" }] });
	observer.dispose();
});

test("dispose releases requests/listeners and late messages have no effects", async () => {
	const { bus, observer, track } = fixture(); track("job"); const waiting = observer.refresh(); observer.dispose();
	await waiting; observer.dispose(); bus.finish("job");
	assert.equal([...bus.listeners.values()].every(values => values.size === 0), true);
	assert.deepEqual(observer.snapshot(), { scope: null, tasks: [] });
	assert.equal(observer.track({ id: "job", startTime: 1, state: "running" }, "native-A/attachment-A"), false);
});

test("consumer exceptions never break provider publication and unknown frames never resolve", () => {
	const bus = new Bus(); const observer = new BackgroundWorkObserver(bus, () => { throw new Error("consumer failed"); });
	observer.bind("scope"); observer.track({ id: "job", startTime: 1, state: "running" }, "scope");
	bus.emit(TERMINAL, { schema_version: "unknown", task: { id: "job", startTime: 1, status: "completed" } });
	assert.deepEqual(observer.pendingIds(), ["job"]);
	assert.doesNotThrow(() => bus.finish("job")); assert.deepEqual(observer.pendingIds(), []); observer.dispose();
});
