import assert from "node:assert/strict";
import { describe, it } from "node:test";
import register from "../extensions/devspec-launcher.ts";
import { launcherStatusMessage } from "../extensions/core/launcher-status.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function harness() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const pi = { on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler), registerCommand: (name: string, command: any) => commands.set(name, command) } as unknown as ExtensionAPI;
	const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
	return { pi, ctx, handlers, commands, notices };
}

describe("launcher first-execution lifecycle", () => {
	it("runs readiness on session_start, never in the factory", async () => {
		const h = harness(); let calls = 0;
		register(h.pi, { install: async () => { calls++; return { ok: true, outcome: "installed" }; } });
		assert.equal(calls, 0);
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.equal(calls, 1); assert.deepEqual(h.notices, []);
	});
	it("reports failed OS setup without throwing away the Pi session", async () => {
		const h = harness();
		register(h.pi, { install: async () => ({ ok: false, outcome: "not_ready", error: "os_registration_failed" }) });
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.match(h.notices[0]!, /operating system did not accept/);
		assert.match(h.notices[0]!, /Copy commands still work/);
	});
	it("catches installation exceptions and does not disclose raw paths/errors", async () => {
		const h = harness();
		register(h.pi, { install: async () => { throw new Error("secret /private/customer/path"); } });
		await h.handlers.get("session_start")!({}, h.ctx);
		assert.equal(h.notices.length, 1);
		assert.doesNotMatch(h.notices[0]!, /secret|\/private/);
	});
	it("respects deliberate disable and stays silent when headless", async () => {
		for (const outcome of ["disabled", "failed"]) {
			const h = harness(); h.ctx.hasUI = outcome === "disabled";
			register(h.pi, { install: async () => ({ ok: false, outcome }) });
			await h.handlers.get("session_start")!({}, h.ctx);
			assert.deepEqual(h.notices, []);
		}
	});
	it("offers bounded native recovery commands without arbitrary shell input", async () => {
		const h = harness(), calls: string[] = [], options: unknown[] = [];
		register(h.pi, { install: async input => { options.push(input); return { ok: true, outcome: "repaired" }; }, run: async command => { calls.push(command); return { ok: true }; } });
		const command = h.commands.get("devspec.launcher");
		await command.handler("status", h.ctx);
		await command.handler("enable; unsafe", h.ctx);
		assert.deepEqual(calls, ["status"]);
		assert.match(h.notices[1]!, /Use \/devspec.launcher/);
		await command.handler("repair", h.ctx);
		assert.match(h.notices[2]!, /launcher is ready/);
		assert.deepEqual(options, [{ repair: true }]);
	});
	it("pairs the current account after an explicit enable without bypassing policy refusal", async () => {
		for (const error of ["account_not_paired", "os_registration_failed"]) {
			const h = harness(); let paired = 0;
			register(h.pi, { run: async () => ({ ok: false, error }), install: async () => { paired++; return { ok: true }; } });
			await h.commands.get("devspec.launcher").handler("enable", h.ctx);
			assert.equal(paired, error === "account_not_paired" ? 1 : 0);
		}
	});
	it("never describes a healthy launcher as an opened agent", () => {
		assert.match(launcherStatusMessage({ ok: true }), /not whether a coding agent has opened/);
	});
});
