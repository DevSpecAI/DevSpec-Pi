import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { emitTs } from '../scripts/generate-mcp-catalog.mjs';

const tool = (name: string) => ({ name, description: `Use ${name}. Preserve all guidance.`, searchIntent: `intent for ${name}`, inputSchema: { type: 'object' }, modelInputSchema: { type: 'object' } });
function fixture() {
  const tools = ['create_resource', 'verify_agent_connection', 'post_session_message', 'poll_connection'].map(tool);
  // The host pump is not in the server's searchable corpus. Two server-searchable
  // verbs are excluded by Pi: exposure is not a compatibility identity.
  const documents = tools.filter(t => t.name !== 'poll_connection').map(t => ({ id: t.name, name: t.name.replaceAll('_', ' '), description: t.description, intent: t.searchIntent })).sort((a, b) => a.id < b.id ? -1 : 1);
  const version = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
  return { tools, toolSearch: { version, documents } };
}

test('generator preserves the canonical server identity independently of local exposure', async () => {
  const source = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'devspec-catalog-generation-'));
  try {
    const path = join(dir, 'catalog.ts');
    await writeFile(path, emitTs(source));
    const generated = await import(pathToFileURL(path).href);
    assert.equal(generated.TOOL_CATALOG_VERSION, source.toolSearch.version);
    assert.deepEqual(generated.MODEL_VERB_NAMES, ['create_resource']);
    assert.deepEqual(generated.TOOL_SEARCH_DOCUMENTS.map((d: { id: string }) => d.id), ['create_resource']);
    assert.equal(generated.MCP_CATALOG.find((t: { name: string }) => t.name === 'verify_agent_connection').kind, 'pump');
    assert.equal(generated.MCP_CATALOG.find((t: { name: string }) => t.name === 'post_session_message').kind, 'never_model');
    assert.notEqual(createHash('sha256').update(JSON.stringify(generated.TOOL_SEARCH_DOCUMENTS)).digest('hex'), generated.TOOL_CATALOG_VERSION);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('generator refuses missing or internally inconsistent canonical identity', () => {
  const source = fixture();
  assert.throws(() => emitTs({ tools: source.tools }), /server's toolSearch version and documents/);
  assert.throws(() => emitTs({ ...source, toolSearch: { ...source.toolSearch, version: 'not-the-hash' } }), /does not cover/);
  const drifted = { ...source, tools: source.tools.map(t => t.name === 'create_resource' ? { ...t, description: 'Different guidance' } : t) };
  assert.throws(() => emitTs(drifted), /differs from the wire tool: create_resource/);
});
