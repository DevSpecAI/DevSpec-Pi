import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { callDevspec, resetClientCache, setLaneClientFactoryForTests } from "../extensions/core/client.ts";
import { LOADED_CLIENT_VERSIONS, versionReportFromManifest, withClientVersions } from "../extensions/core/client-versions.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
afterEach(() => { setLaneClientFactoryForTests(null); resetClientCache(); });

test("the report identifies this loaded plugin and the host SDK separately", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.equal(LOADED_CLIENT_VERSIONS.plugin_version, manifest.version);
	assert.equal(LOADED_CLIENT_VERSIONS.host_version, PI_VERSION);
	assert.ok(Object.isFrozen(LOADED_CLIENT_VERSIONS));
});

test("unknown/foreign manifests and absent host versions are not guessed", () => {
	assert.deepEqual(versionReportFromManifest({ name: "foreign-package", version: "9.0.0" }, "1.0.0"), {});
	assert.deepEqual(versionReportFromManifest({ name: "@devspecai/pi-plugin", version: "" }, "1.0.0"), {});
	assert.deepEqual(versionReportFromManifest({ name: "@devspecai/pi-plugin", version: "1.0.0" }, undefined), { plugin_version: "1.0.0" });
	assert.deepEqual(versionReportFromManifest({ name: "@devspec/pi-plugin", version: "1.0.0" }, undefined), { plugin_version: "1.0.0" });
});

test("normal register and attach calls carry the executing artifact report on both lanes", async () => {
	const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
	setLaneClientFactoryForTests(async () => ({
		callTool: async request => { calls.push(request); return { content: [{ type: "text", text: "ok" }] }; },
		readResource: async () => ({ contents: [] }),
		close: async () => {},
	}));
	for (const lane of ["pump", "work"] as const) {
		for (const name of ["register_connection", "attach_connection"]) {
			const args = { local_id: "local", connection_id: "connection", session_id: "room", plugin_version: "spoof", host_version: "spoof" };
			await callDevspec("fixture-token", name, args, { lane });
			assert.equal(args.plugin_version, "spoof", "caller object remains untouched");
		}
	}
	assert.equal(calls.length, 4);
	for (const request of calls) {
		assert.equal(request.arguments?.plugin_version, LOADED_CLIENT_VERSIONS.plugin_version);
		assert.equal(request.arguments?.host_version, PI_VERSION);
		assert.equal(request.arguments?.connection_id, "connection");
	}
});

test("other tools remain byte/argument-stable, and unknown reporting strips guessed caller fields", () => {
	const args = { connection_id: "c", content: "unchanged" };
	assert.equal(withClientVersions("post_session_message", args), args);
	assert.deepEqual(withClientVersions("register_connection", { ...args, plugin_version: "guess", host_version: "guess" }, {}), args);
});

test("an installed artifact resolves its own manifest and retains the loaded version after an in-place update", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "devspec-pi-version-"));
	try {
		mkdirSync(join(fixture, "extensions/core"), { recursive: true });
		symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "junction");
		const manifest = { name: "@devspecai/pi-plugin", version: "1.2.3", type: "module" };
		writeFileSync(join(fixture, "package.json"), JSON.stringify(manifest));
		const module = join(fixture, "extensions/core/client-versions.ts");
		writeFileSync(module, readFileSync(join(root, "extensions/core/client-versions.ts"), "utf8"));
		const loaded = await import(pathToFileURL(module).href);
		assert.equal(loaded.LOADED_CLIENT_VERSIONS.plugin_version, "1.2.3");
		writeFileSync(join(fixture, "package.json"), JSON.stringify({ ...manifest, version: "9.9.9" }));
		assert.equal(loaded.withClientVersions("attach_connection", {}).plugin_version, "1.2.3");
	} finally { rmSync(fixture, { recursive: true, force: true }); }
});
