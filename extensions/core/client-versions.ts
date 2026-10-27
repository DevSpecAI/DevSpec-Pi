import { readFileSync } from "node:fs";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/;
export type ClientVersionReport = Readonly<{ plugin_version?: string; host_version?: string }>;

/** Only our own executing package is a plugin-version source. */
export function versionReportFromManifest(manifest: unknown, hostVersion: unknown): ClientVersionReport {
	if (!manifest || typeof manifest !== "object") return {};
	const value = manifest as { name?: unknown; version?: unknown };
	if ((value.name !== "@devspecai/pi-plugin" && value.name !== "@devspec/pi-plugin") || typeof value.version !== "string" || !LABEL.test(value.version)) return {};
	return Object.freeze({
		plugin_version: value.version,
		...(typeof hostVersion === "string" && LABEL.test(hostVersion) ? { host_version: hostVersion } : {}),
	});
}

function readLoadedReport(): ClientVersionReport {
	try {
		return versionReportFromManifest(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")), PI_VERSION);
	} catch {
		// An unreadable artifact is unknown, never the host's or cwd's package.
		return {};
	}
}

// Capture at module load. Reading the file on every call would make old loaded
// code advertise a newer checkout's version after an in-place update (debdc8a7).
export const LOADED_CLIENT_VERSIONS = readLoadedReport();

/**
 * The header every DevSpec request carries to say which plugin made it (ADR
 * "Protecting intent" §14; decision bab58fed; server side 2295e089):
 * `x-devspec-plugin: pi/<version>`. It identifies the plugin for the
 * no-plugin notice, agent health and "update your plugin" messages; it is not
 * authority, which the server always checks itself.
 */
export const PLUGIN_HEADER = "x-devspec-plugin";
/** This plugin's id in that header, shared by every DevSpec plugin's `<id>/<version>` contract. */
export const PLUGIN_ID = "pi";

/**
 * The identifying header for this loaded artifact. The version is the one the
 * running code was loaded with, read from this package's own manifest. When it
 * cannot be read, no version is invented: the header is left off and DevSpec
 * treats the call as it treats any unidentified client.
 */
export function pluginHeaders(report: ClientVersionReport = LOADED_CLIENT_VERSIONS): Readonly<Record<string, string>> {
	return report.plugin_version ? { [PLUGIN_HEADER]: `${PLUGIN_ID}/${report.plugin_version}` } : {};
}

export function withClientVersions(name: string, args: Record<string, unknown>, report = LOADED_CLIENT_VERSIONS): Record<string, unknown> {
	if (name !== "register_connection" && name !== "attach_connection") return args;
	const { plugin_version: _plugin, host_version: _host, ...rest } = args;
	return { ...rest, ...report };
}
