import { join } from "node:path";

/** Pi's bash tool: /bin/bash, or Git Bash on native Windows (c4b14794). */
export const BASH = process.platform === "win32"
	? join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
	: "/bin/bash";

/** This environment plus `extra`, with exactly one PATH whatever case the platform spells it in. */
export function withEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if ("PATH" in extra) for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
	return { ...env, ...extra };
}
