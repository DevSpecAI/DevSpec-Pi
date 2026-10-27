/** Pi 1.x configuration ownership (9021dd85). No shared/other-host files are written. */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { findDevspecServers, type DevspecServerHit } from "./adapter-overlap.ts";

type ObjectMap = Record<string, unknown>;
export interface ConfigSnapshot { path: string; text: string | null; value: ObjectMap }
function object(value: unknown): value is ObjectMap {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function readConfig(path: string): ConfigSnapshot {
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, text: null, value: {} }; throw error; }
	const value: unknown = JSON.parse(text);
	if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers))) throw new Error("Invalid MCP config shape");
	return { path, text, value };
}
function unchanged(snapshot: ConfigSnapshot): void {
	if (readConfig(snapshot.path).text !== snapshot.text) throw new Error("MCP configuration changed concurrently");
	// Do not follow a symlink into a shared configuration or another host's settings.
	try { if (lstatSync(snapshot.path).isSymbolicLink()) throw new Error("MCP configuration is a symlink; review it manually"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function saveConfig(snapshot: ConfigSnapshot, value: ObjectMap): boolean {
	if (isDeepStrictEqual(snapshot.value, value)) return false;
	unchanged(snapshot);
	mkdirSync(dirname(snapshot.path), { recursive: true });
	const temp = `${snapshot.path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		unchanged(snapshot);
		renameSync(temp, snapshot.path);
	} finally { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
	return true;
}

/** Move only recognized legacy overlay entries. Full native entries are never migrated. */
export function migrateLegacyOverlay(nativePath: string, adapterPath: string): boolean {
	const source = readConfig(nativePath);
	const servers = (source.value.mcpServers ?? {}) as ObjectMap;
	const legacy = Object.entries(servers).filter(([, entry]) => object(entry)
		&& Object.keys(entry).length > 0
		&& Object.keys(entry).every((key) => key === "disabled" || key === "protocolVersion")
		&& (entry.disabled === undefined || typeof entry.disabled === "boolean")
		&& (entry.protocolVersion === undefined || typeof entry.protocolVersion === "string"));
	if (legacy.length === 0) return false;
	const destination = readConfig(adapterPath);
	const nextServers: ObjectMap = Object.assign(Object.create(null), destination.value.mcpServers ?? {});
	for (const [name, entry] of legacy) {
		const existing = nextServers[name];
		if (existing !== undefined && !object(existing)) throw new Error("Invalid adapter override");
		for (const [key, value] of Object.entries(entry as ObjectMap)) {
			if (object(existing) && key in existing && !isDeepStrictEqual(existing[key], value)) throw new Error("Conflicting MCP overrides; review manually");
		}
		nextServers[name] = { ...(existing as ObjectMap ?? {}), ...(entry as ObjectMap) };
	}
	// Both files are validated before either changes. Save destination first: interruption
	// may leave a retryable duplicate, never delete the only copy of a user's setting.
	unchanged(source);
	unchanged(destination);
	writeFileSync(`${nativePath}.devspec-backup-${randomUUID()}`, source.text!, { flag: "wx", mode: 0o600 });
	saveConfig(destination, { ...destination.value, mcpServers: nextServers });
	const remaining = { ...servers };
	for (const [name] of legacy) delete remaining[name];
	saveConfig(source, { ...source.value, mcpServers: remaining });
	return true;
}

export function disableNativeDuplicates(path: string, endpoint: string, effectiveNames?: Set<string>): { hits: DevspecServerHit[]; changed: boolean } {
	const source = readConfig(path);
	const servers = (source.value.mcpServers ?? {}) as Record<string, { url?: unknown; enabled?: unknown }>;
	const hits = findDevspecServers(servers, path, endpoint).filter((hit) => !effectiveNames || effectiveNames.has(hit.name)).map((hit) => ({ ...hit, alreadyDisabled: servers[hit.name].enabled === false }));
	const next = { ...servers };
	for (const hit of hits) next[hit.name] = { ...next[hit.name], enabled: false };
	return { hits, changed: hits.length > 0 && saveConfig(source, { ...source.value, mcpServers: next }) };
}

export function disableEffectiveNativeDuplicates(paths: string[], endpoint: string) {
	const owners = new Map<string, string>();
	for (const path of paths) for (const name of Object.keys(readConfig(path).value.mcpServers as ObjectMap ?? {})) owners.set(name, path);
	let changed = false;
	const hits: DevspecServerHit[] = [];
	for (const path of paths) {
		const result = disableNativeDuplicates(path, endpoint, new Set([...owners].filter(([, owner]) => owner === path).map(([name]) => name)));
		hits.push(...result.hits); changed = result.changed || changed;
	}
	return { hits, changed };
}

export interface AdapterConfigApi {
	loadMcpConfig: (overridePath?: string, cwd?: string) => { mcpServers: Record<string, { url?: unknown; disabled?: unknown }> };
	writeProjectServerDisabledOverride: (overridePath: string | undefined, cwd: string, name: string, disabled: boolean) => { path: string; changed: boolean };
}
export function disableAdapterDuplicates(api: AdapterConfigApi, cwd: string, endpoint: string, overridePath?: string) {
	// Let the adapter own imports, precedence, custom config paths, JSONC and credential
	// handling. Do not maintain a second, incomplete implementation of its discovery.
	const config = api.loadMcpConfig(overridePath, cwd);
	const hits = findDevspecServers(config.mcpServers, "pi-mcp-adapter", endpoint);
	let changed = false;
	for (const hit of hits) {
		if (!hit.alreadyDisabled) {
			const path = join(cwd, ".pi", "mcp-adapter.json");
			try { if (lstatSync(path).isSymbolicLink()) throw new Error("Adapter override is a symlink"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			changed = api.writeProjectServerDisabledOverride(overridePath, cwd, hit.name, true).changed || changed;
		}
	}
	const verified = api.loadMcpConfig(overridePath, cwd);
	if (hits.some((hit) => verified.mcpServers[hit.name]?.disabled !== true)) throw new Error("Adapter did not apply duplicate override; review exclusive/in-memory config");
	return { hits, changed };
}
export function configPaths(agentDir: string, cwd: string, trusted: boolean) {
	return [agentDir, ...(trusted ? [join(cwd, ".pi")] : [])].map((dir) => ({ native: join(dir, "mcp.json"), adapter: join(dir, "mcp-adapter.json") }));
}
