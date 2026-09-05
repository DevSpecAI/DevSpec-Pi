import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { refreshAgentStatsReport } from "../extensions/core/telemetry.ts";
import { executeControlCommand, parseControlCommand } from "../extensions/core/control.ts";

const source = readFileSync(new URL("../extensions/devspec-remote.ts", import.meta.url), "utf8");

function bodyBetween(start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
	return source.slice(from, to);
}

test("runtimeAgentStats uses native capabilities from the effective model, including custom maps", () => {
	const runtimeSource = bodyBetween("function runtimeAgentStats(", "/** Coalesce model_select");
	const runtimeAgentStats = runInNewContext(stripTypeScriptTypes(`
		${runtimeSource}
		runtimeAgentStats;
	`), { refreshAgentStatsReport, getSupportedThinkingLevels, latestAgentStats: null });
	for (const [model, expected] of [
		[undefined, undefined],
		[{ reasoning: false }, ["off"]],
		[{ reasoning: true }, ["off", "minimal", "low", "medium", "high"]],
		[{ reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, xhigh: null, max: "max" } }, ["high", "max"]],
		[{ reasoning: true, thinkingLevelMap: { xhigh: "extended" } }, ["off", "minimal", "low", "medium", "high", "xhigh"]],
	] as const) {
		const effectiveModel = model ? { provider: "custom", id: "alias", ...model } : undefined;
		const report = runtimeAgentStats({ model: effectiveModel, thinkingLevel: "high" });
		assert.deepEqual(report.supportedThinkingLevels, expected);
		if (!model) assert.equal(Object.hasOwn(report, "supportedThinkingLevels"), false);
	}
});

test("settle, heartbeat and model/thinking events retain the existing telemetry paths", () => {
	const settle = bodyBetween("function settleTelemetry()", "async function postToSession");
	assert.match(source, /import \{ getSupportedThinkingLevels, type ModelThinkingLevel \} from "@earendil-works\/pi-ai"/);
	assert.match(settle, /const model = ctx\?\.model;/);
	assert.match(settle, /supportedThinkingLevels: model \? getSupportedThinkingLevels\(model\) : undefined/);
	assert.match(source, /agent_stats: runtimeAgentStats\(ctx\)/);
	for (const event of ["model_select", "thinking_level_select"]) {
		assert.ok(source.includes(`pi.on("${event}", (_event, ctx) => {\n\t\tscheduleRuntimeStamp(ctx);`));
	}
});

test("Pi thinking adapter reads effective state and rejects unavailable APIs", () => {
	const adapter = bodyBetween("\tpi_setThinking = (level) => {", "\tpi_setModel = async");
	const makeAdapter = (pi: object) => runInNewContext(stripTypeScriptTypes(`let pi_setThinking; ${adapter}; pi_setThinking;`), { pi });
	let effective = "high";
	const setThinking = makeAdapter({
		setThinkingLevel: (level: Parameters<typeof clampThinkingLevel>[1]) => {
			effective = clampThinkingLevel({ reasoning: true } as Parameters<typeof clampThinkingLevel>[0], level);
		},
		getThinkingLevel: () => effective,
	});
	assert.equal(setThinking("xhigh"), "high", "clamped to already-active level without an event");
	assert.equal(setThinking("low"), "low");
	assert.throws(() => makeAdapter({ getThinkingLevel: () => "high" })("high"), /setThinkingLevel is not available/);
	assert.throws(() => makeAdapter({ setThinkingLevel: () => {} })("high"), /getThinkingLevel is not available/);
});

test("thinking control refreshes unchanged/clamped/failed attempts and still acknowledges consumption", async () => {
	const control = bodyBetween("const control = parseControlCommand(pkg.control);", "// Canonical replay/reseed");
	for (const scenario of ["unchanged", "clamped", "failed"]) {
		const order: string[] = [];
		const notifications: string[] = [];
		const ctx = { thinkingLevel: "high" };
		const handle = runInNewContext(stripTypeScriptTypes(`(async () => { ${control} })`), {
			pkg: { control: { id: "c1", verb: "set_thinking", issuedAt: "now", issuedByUserId: "owner", args: { thinking: scenario === "unchanged" ? "high" : "xhigh" } } },
			ctx, lastCtx: null, token: "token", active: { bond: { connectionId: "connection" } },
			parseControlCommand, executeControlCommand,
			pi_setThinking: () => {
				order.push("set");
				if (scenario === "failed") throw new Error("setter unavailable");
				return ctx.thinkingLevel; // Deliberately no thinking_level_select event.
			},
			scheduleRuntimeStamp: (liveCtx: typeof ctx) => {
				assert.equal(liveCtx, ctx);
				order.push(`stamp:${liveCtx.thinkingLevel}`);
			},
			ackControl: async (_token: string, _connection: string, id: string) => { order.push(`ack:${id}`); },
			notify: (_ctx: unknown, message: string) => { notifications.push(message); },
			debug: () => {},
		});
		await handle();
		assert.deepEqual(order, ["set", "stamp:high", "ack:c1"]);
		assert.match(notifications[0], scenario === "failed" ? /failed/ : /thinking=high/);
	}
});

test("control ack has no new result schema", () => {
	const ack = bodyBetween("async function ackControl(", "function setRemoteStatus");
	assert.match(ack, /control_ack: controlId/);
	assert.doesNotMatch(ack, /control_result|thinking|status:/);
});
