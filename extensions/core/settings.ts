/**
 * DevSpec Pi — package settings (persisted at <pi-agent-dir>/devspec/settings.json).
 *
 * autoBond (default true): interactive sessions bond as DevSpec capacity on
 * launch — the zero-command behavior (VISION.md principle 6). Headless modes
 * never auto-bond regardless; scripts and one-shot runs stay explicit.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { devspecDir } from "./config.ts";

export interface DevspecSettings {
	autoBond: boolean;
}

const DEFAULTS: DevspecSettings = { autoBond: true };

function settingsPath(): string {
	return join(devspecDir(), "settings.json");
}

export async function loadSettings(): Promise<DevspecSettings> {
	try {
		const raw = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<DevspecSettings>;
		return { ...DEFAULTS, ...raw };
	} catch {
		return { ...DEFAULTS };
	}
}

export async function saveSettings(patch: Partial<DevspecSettings>): Promise<DevspecSettings> {
	const next = { ...(await loadSettings()), ...patch };
	await mkdir(devspecDir(), { recursive: true, mode: 0o700 });
	await writeFile(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
	return next;
}
