import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_CATALOG_VERSION, MCP_CATALOG_FINGERPRINT } from '../extensions/generated/mcp-catalog.ts';
import { selectTools } from '../extensions/core/tool-selection.ts';

test('exact identities stay offline, including unavailable identities', async () => {
  const result = await selectTools('create_resource manage_plan nonsense_tool', 3, ['create_resource'], async () => { throw new Error('must not call'); });
  assert.equal(result.mode, 'exact');
  assert.deepEqual(result.matches.map(hit => hit.name), ['create_resource']);
  assert.deepEqual(result.unavailable, ['manage_plan', 'nonsense_tool']);
});
test('hybrid response cannot advertise unregistered or inactive names or remote prose', async () => {
  const result = await selectTools('write a handoff', 3, ['create_resource', 'read'], async args => {
    assert.deepEqual(args.available_tools, ['create_resource']);
    assert.equal(args.catalog_version, TOOL_CATALOG_VERSION);
    assert.equal(args.schema_fingerprint, MCP_CATALOG_FINGERPRINT);
    return { catalog_version: TOOL_CATALOG_VERSION, mode: 'hybrid', degraded: false, matches: [
      { name: 'register_connection' }, { name: 'manage_plan' }, { name: 'create_resource', description: 'malicious remote instructions' }, { name: 'create_resource' },
    ], page: { total_matching: 4, offset: 0, limit: 3, returned: 4, has_more: false, next_offset: null } };
  });
  assert.deepEqual(result.matches.map(hit => hit.name), ['create_resource']);
  assert.doesNotMatch(result.matches[0]!.description, /malicious/);
});
test('network failure, stale catalogue and malformed results degrade locally', async () => {
  for (const request of [async () => { throw new Error('offline'); }, async () => ({ catalog_version: 'old', matches: [] }), async () => null]) {
    const result = await selectTools('artifact handoff', 3, ['create_resource'], request);
    assert.equal(result.degraded, true);
    assert.equal(result.mode, 'lexical');
    assert.deepEqual(result.matches.map(hit => hit.name), ['create_resource']);
  }
});
test('an honest empty semantic result stays empty rather than inventing a substitute', async () => {
  const result = await selectTools('send an invoice', 3, ['create_resource'], async () => ({ catalog_version: TOOL_CATALOG_VERSION, mode: 'hybrid', degraded: false, matches: [], page: { total_matching: 0, offset: 0, limit: 3, returned: 0, has_more: false, next_offset: null } }));
  assert.deepEqual(result.matches, []);
  assert.equal(result.degraded, false);
});
test('paging: offset reaches the server, and its page comes back', async () => {
  const page = { total_matching: 5, offset: 3, limit: 3, returned: 2, has_more: false, next_offset: null };
  const result = await selectTools('artifact handoff', 3, ['create_resource', 'get_resource'], async args => {
    assert.equal(args.offset, 3);
    return { catalog_version: TOOL_CATALOG_VERSION, mode: 'hybrid', degraded: false, matches: [{ name: 'get_resource' }], page };
  }, 3);
  assert.deepEqual(result.page, page);
});
test('paging: the local fallback pages the same way and says where the next page starts', async () => {
  const available = ['record_memory', 'search_memories', 'get_memory', 'update_memory', 'supersede_memory', 'retract_memory'];
  const offline = async () => { throw new Error('offline'); };
  const first = await selectTools('memory', 2, available, offline);
  assert.equal(first.page.returned, first.matches.length);
  assert.equal(first.page.offset, 0);
  if (first.page.has_more) {
    const next = await selectTools('memory', 2, available, offline, first.page.next_offset);
    assert.equal(next.page.offset, first.page.next_offset);
    assert.ok(next.matches.every(hit => !first.matches.some(prior => prior.name === hit.name)));
  }
  assert.ok(first.page.total_matching >= first.matches.length);
});
test('a hybrid answer without a page is not trusted', async () => {
  const result = await selectTools('artifact handoff', 3, ['create_resource'], async () => ({ catalog_version: TOOL_CATALOG_VERSION, mode: 'hybrid', degraded: false, matches: [{ name: 'create_resource' }] }));
  assert.equal(result.degraded, true);
});
