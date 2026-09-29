/**
 * First execution performs shared install + OS registration + readiness, not
 * merely file copying (27b53001; ADR 4e87fc70). Generated launcher bytes belong
 * to DevSpec-Launcher. This module owns only Pi's lifecycle and customer UI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveEndpoint, resolveToken } from "./core/auth-store.ts";
import { promisify } from "node:util";
import { debugRemote as debug } from "./core/debug.ts";
import { launcherStatusMessage, type LauncherResult } from "./core/launcher-status.ts";

const LAUNCHER_DIR = fileURLToPath(new URL("../launcher", import.meta.url));
const execFileAsync = promisify(execFile);

export async function installBundledLauncher(options: { repair?: boolean } = {}): Promise<LauncherResult> {
	if (process.env.DEVSPEC_LAUNCHER_DISABLED === "1") return { ok: false, outcome: "disabled", disabledByEnvironment: true };
	const { setupFromPlugin } = await import(pathToFileURL(join(LAUNCHER_DIR, "plugin-setup.mjs")).href);
	const auth = await resolveToken();
	const endpoint = await resolveEndpoint();
	return await setupFromPlugin({ source: LAUNCHER_DIR, repair: options.repair === true, account: auth ? {
		fingerprint: createHash("sha256").update(auth.token).digest("hex"),
		endpoint,
		verifyAccount: async (publicKey: string) => {
			const response = await fetch(new URL("/api/launcher/pair", endpoint), { method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(15000) });
			if (!response.ok) throw new Error("Local launcher account pairing failed");
			return response.json();
		},
	} : undefined }) as LauncherResult;
}

export default function (pi: ExtensionAPI, dependencies: {
	install?: (options?: { repair?: boolean }) => Promise<LauncherResult>;
	run?: (command: string) => Promise<LauncherResult>;
} = {}) {
	const install = dependencies.install ?? installBundledLauncher;
	const run = dependencies.run ?? runLauncherCommand;
	pi.on("session_start", async (_event, ctx) => {
		try {
			const result = await install();
			if (!result.ok) {
				debug("launcher install failed", { errorPresent: true });
				if (result.outcome !== "disabled" && ctx.hasUI) ctx.ui.notify(launcherStatusMessage(result), "warning");
				return;
			}
			debug("launcher install", {
				installed: result.outcome === "installed" || result.outcome === "repaired",
				keptNewer: result.outcome === "kept_newer",
				current: result.outcome === "current",
			});
		} catch {
			debug("launcher install failed", { errorPresent: true });
			if (ctx.hasUI) ctx.ui.notify(launcherStatusMessage({ ok: false }), "warning");
		}
	});

	pi.registerCommand("devspec.launcher", {
		description: "Check or manage local launching: status | repair | enable | disable | uninstall",
		handler: async (input, ctx) => {
			const command = input.trim() || "status";
			if (!["status", "repair", "enable", "disable", "uninstall"].includes(command)) {
				ctx.ui.notify("Use /devspec.launcher status, repair, enable, disable or uninstall.", "warning");
				return;
			}
			try {
				let result = command === "repair"
					? await install({ repair: true })
					: await run(command);
				if (command === "enable" && (result.ok || result.error === "account_not_paired")) result = await install();
				ctx.ui.notify(launcherStatusMessage(result), result.ok ? "info" : "warning");
			} catch {
				ctx.ui.notify(launcherStatusMessage({ ok: false }), "warning");
			}
		},
	});
}

async function runLauncherCommand(command: string): Promise<LauncherResult> {
	try {
		const { stdout } = await execFileAsync(process.execPath, [join(LAUNCHER_DIR, "launcher.mjs"), command], { timeout: 50_000, windowsHide: true, maxBuffer: 64 * 1024 });
		return JSON.parse(stdout) as LauncherResult;
	} catch (error) {
		// The shared CLI returns a structured refusal with a nonzero status. Keep
		// the refusal, rather than replacing it with an unhelpful process error.
		const stdout = (error as { stdout?: string }).stdout;
		if (stdout) return JSON.parse(stdout) as LauncherResult;
		throw error;
	}
}
