import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parsePollPayload } from "../extensions/core/remote-payload.ts";
import { parseStillToDiscussProjection, serializeStillToDiscussProjection } from "../extensions/core/still-to-discuss.ts";
import { canonicalPoll, stillToDiscussProjection, TEST_CONNECTION } from "./canonical-ingress-fixture.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const explicit = process.env.DEVSPEC_V2_ROOT?.trim();
const relative = "packages/core/src/discussion-points/session-note.ts";
const root = explicit ? resolve(explicit) : [resolve(here, "../../devspecv2"), resolve(here, "../../../devspecv2")]
	.find((candidate) => existsSync(resolve(candidate, relative)));

test("the real server projection producer feeds Pi without a copied authority-note fixture", (t) => {
	if (!root || !existsSync(resolve(root, relative))) {
		if (explicit) assert.fail(`DEVSPEC_V2_ROOT lacks the server projection producer: ${root}`);
		t.skip("paired DevSpecV2 checkout unavailable; set DEVSPEC_V2_ROOT for the cross-repo contract check");
		return;
	}
	// Execute the actual pure producer and its constants, not database imports.
	// AST selection fails loudly if the producer moves or gains new dependencies.
	const path = resolve(root, relative);
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const names = new Set(["STILL_TO_DISCUSS_PROJECTION_VERSION", "STILL_TO_DISCUSS_AUTHORITY_NOTE"]);
	const selected = source.statements.filter((node) =>
		ts.isFunctionDeclaration(node) && node.name?.text === "toStillToDiscussProjection" ||
		ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
			ts.isIdentifier(declaration.name) && names.has(declaration.name.text)));
	assert.equal(selected.length, 3, "server producer/constant shape changed; review the cross-host contract");
	const compiled = ts.transpileModule(selected.map((node) => node.getText(source)).join("\n"), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	}).outputText;
	const exported: Record<string, unknown> = {};
	runInNewContext(compiled, { exports: exported }, { timeout: 1000 });
	assert.equal(typeof exported.toStillToDiscussProjection, "function");
	const produce = exported.toStillToDiscussProjection as (snapshot: unknown) => unknown;

	for (const empty of [false, true]) {
		const rows = stillToDiscussProjection({ empty }).rows;
		if (!empty) rows.push({
			id: "20202020-2020-4020-8020-202020202020",
			title: "Point brought into this room",
			state: "open",
			preview: "A sitting uses the same advisory card shape as a point raised here.",
		});
		const snapshot = { rows, truncated: false };
		const wire = JSON.parse(JSON.stringify(produce(snapshot)));
		const parsed = parsePollPayload(canonicalPoll({ stillToDiscuss: wire }), TEST_CONNECTION);
		assert.equal(parsed.canonicalState, "valid");
		assert.ok(parsed.ownerBundle);
		assert.deepEqual(parsed.stillToDiscuss?.rows, snapshot.rows);
		assert.equal(parsed.advisoryRejections, undefined);
		const rendered = serializeStillToDiscussProjection(parsed.stillToDiscuss);
		assert.match(rendered, empty ? /no entries/ : /Investigate remaining CI/);
		if (!empty) assert.match(rendered, /Point brought into this room/);
		assert.throws(() => parseStillToDiscussProjection({ ...wire, version: 2 }), /expected 1/);
	}
});
