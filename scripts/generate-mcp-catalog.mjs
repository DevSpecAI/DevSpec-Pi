#!/usr/bin/env node
/**
 * Generate extensions/generated/mcp-catalog.ts from the DevSpec MCP tool
 * surface (item 523f1512). This is the WIRE map, not the model surface.
 * The model sees the hot set in extensions/core/model-surface.ts (7de79db6).
 *
 * Source of truth: apps/web/lib/mcp/tool-definitions.ts in a DevSpecV2
 * checkout. This script dumps that contract (or reads a pre-dumped JSON)
 * and writes a checked-in catalog the embedded client speaks. A drift
 * test fails when the sibling checkout's verb list no longer matches.
 *
 * Usage:
 *   node scripts/generate-mcp-catalog.mjs --from /tmp/devspec-mcp-tools.json
 *   node scripts/generate-mcp-catalog.mjs --devspec-v2 /path/to/devspecv2
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = resolve(ROOT, "extensions/generated");
const OUT_TS = resolve(OUT_DIR, "mcp-catalog.ts");

/** Extension-internal pump/lifecycle verbs — the model must never see these. */
export const PUMP_VERBS = [
	"register_connection",
	"poll_connection",
	"heartbeat_connection",
	"send_heartbeat",
	"report_keepalive",
	"report_pickup",
	"report_complete",
	"get_connection_dispatch",
	"attach_connection",
	"detach_connection",
	"verify_agent_connection",
	"report_connection_check",
];

/**
 * Model-facing content channel. Conversational delivery is mechanical
 * (item cc9e8c43) — registering this would re-introduce the dual-writer class.
 */
export const NEVER_MODEL_VERBS = ["post_session_message"];

function parseArgs(argv) {
	const out = { from: null, devspecV2: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--from") out.from = argv[++i];
		else if (a === "--devspec-v2") out.devspecV2 = argv[++i];
	}
	return out;
}

function dumpFromV2(v2Root) {
	const script = `
import { getMcpAllTools } from ${JSON.stringify(`${v2Root.replace(/\\/g, "/")}/apps/web/lib/mcp/tool-definitions.ts`)};
const tools = getMcpAllTools();
process.stdout.write(JSON.stringify(tools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  inputSchema: t.inputSchema ?? { type: "object", properties: {} },
}))));
`;
	// The --tsconfig flag is not optional: apps/web owns the `@/*` path alias, and
	// without it tsx resolves `@/lib/...` against the monorepo root and dies on the
	// first aliased import. tests/catalog-drift.test.ts always passed it; this did
	// not, so the generator could not run at all and the catalog drifted silently.
	return execFileSync("npx", ["tsx", "--tsconfig=apps/web/tsconfig.json", "-e", script], {
		cwd: v2Root,
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
	});
}

function titleCase(name) {
	return name
		.split("_")
		.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

function firstSentence(text) {
	const trimmed = String(text ?? "").trim().replace(/\s+/g, " ");
	const cut = trimmed.search(/[.!?](?:\s|$)/);
	const sentence = cut >= 0 ? trimmed.slice(0, cut + 1) : trimmed;
	return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

function classify(name) {
	if (PUMP_VERBS.includes(name)) return "pump";
	if (NEVER_MODEL_VERBS.includes(name)) return "never_model";
	return "model";
}

function fingerprint(tools) {
	const h = createHash("sha256");
	for (const t of tools) {
		h.update(t.name);
		h.update("\0");
		h.update(JSON.stringify(t.inputSchema ?? {}));
		h.update("\n");
	}
	return h.digest("hex");
}

function descriptionFingerprint(tools) {
	const h = createHash("sha256");
	for (const t of tools) {
		h.update(t.name);
		h.update("\0");
		h.update(String(t.description ?? ""));
		h.update("\n");
	}
	return h.digest("hex");
}

function emitTs(tools) {
	const fp = fingerprint(tools);
	const descriptionFp = descriptionFingerprint(tools);
	const entries = tools.map((t) => ({
		name: t.name,
		label: `DevSpec: ${titleCase(t.name)}`,
		description: t.description ?? "",
		promptSnippet: firstSentence(t.description),
		inputSchema: t.inputSchema ?? { type: "object", properties: {} },
		kind: classify(t.name),
	}));
	const model = entries.filter((e) => e.kind === "model").map((e) => e.name);
	const pump = entries.filter((e) => e.kind === "pump").map((e) => e.name);
	const never = entries.filter((e) => e.kind === "never_model").map((e) => e.name);

	return `/* eslint-disable */
/**
 * GENERATED — do not edit by hand.
 * Source: DevSpecV2 apps/web/lib/mcp/tool-definitions.ts via scripts/generate-mcp-catalog.mjs
 * Schema fingerprint: ${fp}
 * Description fingerprint: ${descriptionFp}
 * Regenerated: ${new Date().toISOString()}
 */
export const MCP_CATALOG_FINGERPRINT = ${JSON.stringify(fp)};
export const MCP_CATALOG_DESCRIPTION_FINGERPRINT = ${JSON.stringify(descriptionFp)};
export const MCP_CATALOG_GENERATED_AT = ${JSON.stringify(new Date().toISOString())};

export type CatalogKind = "model" | "pump" | "never_model";

export interface CatalogEntry {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	inputSchema: Record<string, unknown>;
	kind: CatalogKind;
}

export const PUMP_VERBS = ${JSON.stringify(PUMP_VERBS, null, "\t")} as const;
export const NEVER_MODEL_VERBS = ${JSON.stringify(NEVER_MODEL_VERBS, null, "\t")} as const;
export const MODEL_VERB_NAMES = ${JSON.stringify(model, null, "\t")} as const;

export const MCP_CATALOG: CatalogEntry[] = ${JSON.stringify(entries, null, "\t")};

export const CATALOG_COUNTS = {
	total: ${entries.length},
	model: ${model.length},
	pump: ${pump.length},
	never_model: ${never.length},
} as const;
`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	let raw;
	if (args.from) {
		raw = readFileSync(resolve(args.from), "utf8");
	} else {
		const candidates = [
			args.devspecV2,
			process.env.DEVSPEC_V2_ROOT,
			resolve(ROOT, "../devspecv2"),
			resolve(ROOT, "../../devspecv2"),
		].filter(Boolean);
		const v2 = candidates.find((p) =>
			existsSync(resolve(p, "apps/web/lib/mcp/tool-definitions.ts")),
		);
		if (!v2) {
			throw new Error(
				"No DevSpecV2 checkout found. Pass --from <dump.json> or --devspec-v2 <path>.",
			);
		}
		raw = dumpFromV2(v2);
	}
	const tools = JSON.parse(raw);
	if (!Array.isArray(tools) || tools.length === 0) {
		throw new Error("catalog source produced no tools");
	}
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(OUT_TS, emitTs(tools));
	const kinds = { model: 0, pump: 0, never_model: 0 };
	for (const t of tools) kinds[classify(t.name)] += 1;
	process.stdout.write(
		`wrote ${OUT_TS} (${tools.length} verbs: ${kinds.model} model, ${kinds.pump} pump, ${kinds.never_model} never-model)\n`,
	);
}

main();
