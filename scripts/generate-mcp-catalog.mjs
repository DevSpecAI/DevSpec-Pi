#!/usr/bin/env node
/**
 * Generate extensions/generated/mcp-catalog.ts from the DevSpec MCP tool
 * surface (item 523f1512). This is the WIRE map, not the model surface.
 * The model sees all eligible concise tools via extensions/core/model-surface.ts.
 *
 * Source of truth: each tool's one definition in a DevSpecV2 checkout
 * (packages/core/src/mcp/tools, exposed as MCP tools by
 * apps/web/lib/mcp/tool-definitions.ts). This script dumps that contract (or reads a pre-dumped JSON)
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
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = resolve(ROOT, "extensions/generated");
const OUT_TS = resolve(OUT_DIR, "mcp-catalog.ts");

/** Extension-internal pump/lifecycle verbs — the model must never see these. */
export const PUMP_VERBS = [
	"register_connection",
	"poll_connection",
	"heartbeat_connection",
	"report_keepalive",
	"report_pickup",
	"report_complete",
	"get_connection_dispatch",
	"attach_connection",
	"detach_connection",
	"verify_agent_connection",
	"report_commit_provenance",
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
import { toDiscoveryTool } from ${JSON.stringify(`${v2Root.replace(/\\/g, "/")}/apps/web/lib/mcp/tool-discovery.ts`)};
import { getMcpTool } from ${JSON.stringify(`${v2Root.replace(/\\/g, "/")}/packages/core/src/mcp/tools/index.ts`)};
import { TOOL_CATALOG_VERSION, TOOL_SEARCH_DOCUMENTS } from ${JSON.stringify(`${v2Root.replace(/\\/g, "/")}/packages/core/src/mcp/tool-search-index.ts`)};
const tools = getMcpAllTools();
process.stdout.write(JSON.stringify({ toolSearch: { version: TOOL_CATALOG_VERSION, documents: TOOL_SEARCH_DOCUMENTS }, tools: tools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  searchIntent: getMcpTool(t.name)?.searchIntent ?? '',
  modelInputSchema: toDiscoveryTool(t).inputSchema,
  inputSchema: t.inputSchema ?? { type: "object", properties: {} },
})) }));
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

export function emitTs(source) {
	const { tools, toolSearch } = source;
	if (!Array.isArray(tools) || tools.length === 0) {
		throw new Error("catalog source produced no tools");
	}
	// The server owns searchable-corpus identity; Pi owns exposure. These differ:
	// verify_agent_connection and post_session_message are searchable on the server
	// but intentionally not model-facing here (item 454c24ff).
	if (!toolSearch || !Array.isArray(toolSearch.documents) || !toolSearch.documents.length) {
		throw new Error("catalog source must include the server's toolSearch version and documents; regenerate the dump from DevSpecV2");
	}
	const canonical = [...toolSearch.documents].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
		.map(({ id, name, description, intent }) => ({ id, name, description, intent }));
	const canonicalVersion = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
	if (toolSearch.version !== canonicalVersion) {
		throw new Error("server tool-search version does not cover the supplied documents");
	}
	for (const doc of canonical) {
		const tool = tools.find(tool => tool.name === doc.id);
		if (!tool || doc.name !== doc.id.replaceAll('_', ' ') || doc.description !== tool.description || doc.intent !== tool.searchIntent) {
			throw new Error(`server tool-search document differs from the wire tool: ${doc.id}`);
		}
	}
	for (const tool of tools) {
		if (classify(tool.name) === 'model' && (!tool.description || !tool.modelInputSchema || !tool.searchIntent)) {
			throw new Error(`Missing authored model guidance for ${tool.name}; regenerate from the current shared discovery contract`);
		}
	}
	const fp = fingerprint(tools);
	const descriptionFp = descriptionFingerprint(tools);
	const entries = tools.map((t) => ({
		name: t.name,
		label: `DevSpec: ${titleCase(t.name)}`,
		description: t.description ?? "",
		searchIntent: t.searchIntent ?? '',
		modelInputSchema: t.modelInputSchema ?? t.inputSchema ?? { type: "object", properties: {} },
		inputSchema: t.inputSchema ?? { type: "object", properties: {} },
		kind: classify(t.name),
	}));
	const model = entries.filter((e) => e.kind === "model").map((e) => e.name);
	const searchDocuments = entries.filter(e => e.kind === "model").map(e => ({ id: e.name, name: e.name.replaceAll('_', ' '), description: e.description, intent: e.searchIntent })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const searchVersion = toolSearch.version;
	const pump = entries.filter((e) => e.kind === "pump").map((e) => e.name);
	const never = entries.filter((e) => e.kind === "never_model").map((e) => e.name);

	return `/* eslint-disable */
/**
 * GENERATED — do not edit by hand.
 * Source: each tool's one definition in DevSpecV2 (packages/core/src/mcp/tools) via scripts/generate-mcp-catalog.mjs
 * Schema fingerprint: ${fp}
 * Description fingerprint: ${descriptionFp}
 * Regenerated: ${new Date().toISOString()}
 */
export const MCP_CATALOG_FINGERPRINT = ${JSON.stringify(fp)};
export const MCP_CATALOG_DESCRIPTION_FINGERPRINT = ${JSON.stringify(descriptionFp)};
export const MCP_CATALOG_GENERATED_AT = ${JSON.stringify(new Date().toISOString())};
export const TOOL_CATALOG_VERSION = ${JSON.stringify(searchVersion)};
export const TOOL_SEARCH_DOCUMENTS = ${JSON.stringify(searchDocuments, null, '\t')};

export type CatalogKind = "model" | "pump" | "never_model";

export interface CatalogEntry {
	name: string;
	label: string;
	description: string;
	searchIntent: string;
	inputSchema: Record<string, unknown>;
	modelInputSchema: Record<string, unknown>;
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
	const source = JSON.parse(raw);
	const output = emitTs(source);
	const { tools } = source;
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(OUT_TS, output);
	const kinds = { model: 0, pump: 0, never_model: 0 };
	for (const t of tools) kinds[classify(t.name)] += 1;
	process.stdout.write(
		`wrote ${OUT_TS} (${tools.length} verbs: ${kinds.model} model, ${kinds.pump} pump, ${kinds.never_model} never-model)\n`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
