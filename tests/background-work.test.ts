import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundTaskStatusClient, OwnedBackgroundTasks, parseBackgroundTaskStatus } from "../extensions/core/background-work.ts";

const running = { id: "task-1", status: "running" as const };
const completed = { ...running, status: "completed" as const };

test("provider DTO drops commands, paths, logs and notification fields", () => {
	assert.deepEqual(parseBackgroundTaskStatus({ ...running, command: "private", outputPath: "private", notified: true }), running);
	assert.equal(parseBackgroundTaskStatus({ ...running, status: "unknown" }), null);
});

test("terminal-before-launch receipt is monotone even under stale provider snapshots", () => {
	const tasks = new OwnedBackgroundTasks<string>();
	tasks.terminal(completed);
	tasks.launch(running, "original-room");
	assert.deepEqual(tasks.observe([running], () => true), { state: "known", activeCount: 0 });
	assert.equal(tasks.scopeFor(running.id), "original-room");
});

test("non-notifying task remains active until provider terminal, not receipt consumption", () => {
	const tasks = new OwnedBackgroundTasks<string>();
	tasks.launch(running, "original-room");
	assert.deepEqual(tasks.observe([running], () => true), { state: "known", activeCount: 1 });
	tasks.terminal(completed);
	assert.deepEqual(tasks.observe([running], () => true), { state: "known", activeCount: 0 });
});

test("unknown and missing provider state are not successful zero", () => {
	const tasks = new OwnedBackgroundTasks<string>();
	tasks.launch(running, "room");
	assert.deepEqual(tasks.observe(null, () => true), { state: "unknown", activeCount: 0 });
	assert.deepEqual(tasks.observe([], () => true), { state: "unknown", activeCount: 0 });
	assert.deepEqual(tasks.observe([running], () => true), { state: "known", activeCount: 1 });
});

test("old attachment and duplicate receipt cannot reattribute work", () => {
	const tasks = new OwnedBackgroundTasks<string>();
	tasks.launch(running, "old-room");
	assert.equal(tasks.launch(running, "new-room"), false);
	assert.deepEqual(tasks.observe([running], (scope) => scope === "new-room"), { state: "known", activeCount: 0 });
	assert.equal(tasks.scopeFor(running.id), "old-room");
});

test("terminal old task and concurrent new task retain new activity", () => {
	const tasks = new OwnedBackgroundTasks<string>();
	const next = { id: "task-2", status: "running" as const };
	tasks.launch(running, "room");
	tasks.launch(next, "room");
	tasks.terminal(completed);
	assert.deepEqual(tasks.observe([running, next], () => true), { state: "known", activeCount: 1 });
});

function eventBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, handler: (data: unknown) => void) {
			const handlers = listeners.get(name) ?? new Set();
			handlers.add(handler); listeners.set(name, handlers);
			return () => { handlers.delete(handler); };
		},
		emit(name: string, data: unknown) { for (const handler of listeners.get(name) ?? []) handler(data); },
	};
}

test("public event client correlates status and terminal independent of notifications", async () => {
	const bus = eventBus();
	bus.on("pi-background-tasks:request:v1", (value) => {
		const request = value as { request_id: string };
		bus.emit("pi-background-tasks:response:v1", { schema_version: "pi-background-tasks.extension-response.v1", request_id: request.request_id, operation: "status", ok: true, result: { tasks: [running] } });
	});
	const terminal: unknown[] = [];
	const client = new BackgroundTaskStatusClient(bus, (task) => terminal.push(task));
	assert.deepEqual(await client.status(), [running]);
	bus.emit("pi-background-tasks:terminal:v1", { schema_version: "pi-background-tasks.extension-terminal.v1", task: { ...completed, command: "private", notified: false } });
	assert.deepEqual(terminal, [completed]);
	client.dispose();
	assert.equal(await client.status(), null);
});

test("unavailable provider and disposal return unknown rather than empty tasks", async () => {
	const bus = eventBus();
	const client = new BackgroundTaskStatusClient(bus, () => {}, 1);
	assert.equal(await client.status(), null);
	const pending = client.status();
	client.dispose();
	assert.equal(await pending, null);
});

test("confirmed positive roots survive incomplete attribution coverage", () => {
	const tasks = new OwnedBackgroundTasks<string>();
	tasks.launch(running, "room");
	assert.deepEqual(tasks.observe([running, { id: "unattributed", status: "running" }], () => true),
		{ state: "unknown", activeCount: 1 });
	assert.deepEqual(tasks.observe([{ id: "unattributed", status: "running" }], () => true),
		{ state: "unknown", activeCount: 0 });
});
