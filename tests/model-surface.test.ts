import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { setBond } from '../extensions/core/bond-state.ts';
import { buildDevspecInstructions } from '../extensions/core/instructions.ts';
import { jsonSchemaToTypebox } from '../extensions/core/json-schema.ts';
import { ROOM_READ_TOOL } from '../extensions/core/room-reader.ts';
import {
  ACTIVATION_ONLY_VERBS, DIRECTED_QUESTION_TOOL_NAME, HOT_SET_VERBS, PLAN_TOOL_NAME, POLL_TOOL_NAME,
  SCOPE_KEY_SET, scopeKeysForTool, TOOL_LOADER_NAME,
  allModelFacingTools, estimatePrefixTokens, estimatePlanToolChars, isCallableModelVerb,
  catalogEntry, modelFacingSurface, searchRareModelTools, slimCatalogEntry, slimSchema, withDirectedQuestionToolActive, withPlanToolActive, withPollToolActive,
} from '../extensions/core/model-surface.ts';
import registerDevspecTools, { initialActiveTools, modelFacingCatalog, stampKnownScope } from '../extensions/devspec-tools.ts';
import { MODEL_VERB_NAMES, NEVER_MODEL_VERBS, PUMP_VERBS } from '../extensions/generated/mcp-catalog.ts';
import { SERVE_REQUEST_TOOL } from '../extensions/core/request-chain.ts';

test('every eligible safe operation starts available; there is no deferred subset', () => {
  const initial = initialActiveTools(['read', 'custom_tool', ...MODEL_VERB_NAMES]);
  for (const name of MODEL_VERB_NAMES) assert.equal(initial.includes(name), !ACTIVATION_ONLY_VERBS.has(name), name);
  assert.ok(initial.includes('read') && initial.includes('custom_tool') && initial.includes(ROOM_READ_TOOL));
  assert.equal(initial.length, new Set(initial).size);
  for (const name of ['create_resource', 'update_resource', 'supersede_memory', 'release_work_item', 'search_sessions', 'reserve_work_items']) assert.ok(initial.includes(name), name);
});

test('all and only safe generated model verbs are registered once', async () => {
  const definitions: any[] = [];
  const handlers = new Map<string, (...args: any[]) => void>();
  let active = ['read'];
  let changes = 0;
  const pi = {
    registerTool(def: any) { definitions.push(def); active.push(def.name); },
    on(name: string, handler: any) { handlers.set(name, handler); },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { active = [...names]; changes++; },
  } as unknown as ExtensionAPI;
  setBond(null);
  registerDevspecTools(pi);
  // + the room reader and serve_request host tools (item 7a4d04fd).
  assert.equal(definitions.length, MODEL_VERB_NAMES.length + 2);
  assert.equal(definitions.filter(def => def.name === TOOL_LOADER_NAME).length, 1);
  assert.equal(definitions.filter(def => def.name === SERVE_REQUEST_TOOL).length, 1);
  assert.deepEqual(allModelFacingTools().map(entry => entry.name), [...MODEL_VERB_NAMES]);
  assert.deepEqual(modelFacingCatalog().map(entry => entry.name), [...MODEL_VERB_NAMES]);
  for (const name of [...PUMP_VERBS, ...NEVER_MODEL_VERBS]) {
    assert.equal(isCallableModelVerb(name), false);
    assert.ok(!definitions.some(def => def.name === name));
  }
  for (const def of definitions.filter(def => MODEL_VERB_NAMES.includes(def.name))) {
    assert.equal(def.promptSnippet, undefined, 'do not duplicate the full guidance in the system prompt');
  }
  handlers.get('session_start')?.();
  assert.ok(!active.includes(SERVE_REQUEST_TOOL), 'serve_request is shown only while a turn carries several requests');
  const before = [...active];
  const result = await definitions.find(def => def.name === TOOL_LOADER_NAME).execute('call', { query: 'create_resource' });
  assert.deepEqual(result.details.matches.map((hit: any) => hit.name), ['create_resource']);
  assert.deepEqual(active, before);
  assert.equal(changes, 1, 'search must not activate/reorder tools or rewrite the prefix');
});

test('model schemas omit host identity without clipping authored guidance', () => {
  for (const entry of allModelFacingTools()) {
    const props = (entry.inputSchema.properties ?? {}) as Record<string, unknown>;
    for (const key of scopeKeysForTool(entry.name)) assert.ok(!(key in props), `${entry.name}.${key}`);
    for (const key of SCOPE_KEY_SET) assert.ok(!(entry.inputSchema.required as string[] | undefined)?.includes(key));
    assert.equal(entry.description, catalogEntry(entry.name)!.description, 'the one description survives exactly');
    assert.ok(entry.description.trim(), entry.name);
  }
  const artifact = allModelFacingTools().find(entry => entry.name === 'update_resource')!;
  assert.ok((artifact.inputSchema.properties as any).body_edits.description.trim(), 'parameter text survives the projection');
  const search = allModelFacingTools().find(entry => entry.name === TOOL_LOADER_NAME)!;
  assert.equal((search.inputSchema.properties as any).available_tools, undefined);
  assert.equal((search.inputSchema.properties as any).catalog_version, undefined);
});

test('scope removal preserves complete operational sentences and constraints', () => {
  const schema = slimSchema({ type: 'object', properties: {
    title: { type: 'string', description: 'First sentence. Necessary second sentence.' },
    git_remote: { type: 'string' },
    nested: { type: 'object', properties: { project_id: { type: 'string' }, ok: { type: 'string' } }, required: ['project_id', 'ok'] },
  }, required: ['title', 'git_remote'] });
  assert.equal((schema.properties as any).title.description, 'First sentence. Necessary second sentence.');
  assert.deepEqual(schema.required, ['title']);
  assert.deepEqual((schema.properties as any).nested.required, ['ok']);
});

test('connection tools stay independently activated and capability identity is absent', () => {
  const initial = ['read', ...HOT_SET_VERBS, TOOL_LOADER_NAME];
  for (const [name, activate] of [[PLAN_TOOL_NAME, withPlanToolActive], [POLL_TOOL_NAME, withPollToolActive], [DIRECTED_QUESTION_TOOL_NAME, withDirectedQuestionToolActive]] as const) {
    const active = activate(initial, true);
    assert.equal(active.at(-1), name);
    assert.deepEqual(activate(active, true), active);
    assert.deepEqual(activate(active, false), initial);
    const props = allModelFacingTools().find(entry => entry.name === name)!.inputSchema.properties as Record<string, unknown>;
    for (const key of ['project_id', 'connection_id', 'session_id', 'local_session_id']) assert.equal(props[key], undefined);
    assert.ok(props.expected_revision);
  }
  assert.ok(estimatePlanToolChars() > 1000);
});

test('exact search recommends active tools, never substitutes or widens availability', () => {
  assert.deepEqual(searchRareModelTools('record_memory create_resource').map(entry => entry.name), ['record_memory', 'create_resource']);
  assert.deepEqual(searchRareModelTools('get_implementation_contract'), []);
  assert.deepEqual(searchRareModelTools('register_connection'), []);
  assert.deepEqual(searchRareModelTools('manage_plan'), []);
  assert.deepEqual(searchRareModelTools('manage_plan', 3, ['manage_plan']).map(entry => entry.name), ['manage_plan']);
  assert.deepEqual(searchRareModelTools('create_resource', 3, ['get_resource']), []);
  assert.deepEqual(searchRareModelTools('send an invoice'), []);
});

test('offline retrieval is deterministic, includes prior hot tools and returns guidance', () => {
  for (const query of ['artifact handoff', 'decision memory', 'database tables', 'session transcript']) {
    assert.deepEqual(searchRareModelTools(query), searchRareModelTools(query));
    assert.ok(searchRareModelTools(query).length > 0);
  }
  assert.ok(searchRareModelTools('decision memory', 10).some(entry => entry.name === 'record_memory'));
});

test('runtime schemas retain validation and optional transcript target', () => {
  const entry = allModelFacingTools().find(entry => entry.name === 'update_memory')!;
  const schema = jsonSchemaToTypebox(entry.inputSchema);
  assert.equal(Value.Check(schema, { id: 'test', state: 'decided' }), true);
  assert.equal(Value.Check(schema, { id: 'test', state: 'nonsense' }), false);
  const transcript = allModelFacingTools().find(entry => entry.name === 'get_session_transcript')!;
  assert.ok((transcript.inputSchema.properties as any).session_id);
  assert.ok(!(transcript.inputSchema.required as string[] | undefined)?.includes('session_id'));
});

test('host scope stamping preserves only model-owned read targets', () => {
  setBond({ connectionId: 'conn', sessionId: 'room', codename: 'Test' });
  const stamped = stampKnownScope({ title: 'test', project_id: 'injected', git_remote: 'injected', session_id: 'wrong', local_session_id: 'injected' }, 'create_action_item');
  assert.deepEqual(stamped, { title: 'test', session_id: 'room', connection_id: 'conn' });
  assert.equal(stampKnownScope({ session_id: 'other' }, 'get_session_transcript').session_id, 'other');
  assert.equal(stampKnownScope({}, 'get_session_transcript').session_id, 'room');
  for (const name of ACTIVATION_ONLY_VERBS) assert.deepEqual(stampKnownScope({ action: 'list', project_id: 'bad', session_id: 'bad', connection_id: 'bad' }, name), { action: 'list' });
  setBond(null);
});

test('long authored guidance survives the native projection without a prose ration', () => {
  const guidance = 'Useful first sentence. Necessary second sentence, with examples.\n'.repeat(100);
  const base = allModelFacingTools()[0]!;
  const entry = slimCatalogEntry({ ...base, description: guidance, modelInputSchema: { type: 'object', properties: { detail: { type: 'string', description: guidance, maxLength: 42 } } } });
  assert.equal(entry.description, guidance);
  assert.equal((entry.inputSchema.properties as any).detail.description, guidance);
  assert.equal((entry.inputSchema.properties as any).detail.maxLength, 42);
});

test('reports the complete surface footprint without an arbitrary prefix quota', () => {
  assert.deepEqual(modelFacingSurface().map(entry => entry.name), [...HOT_SET_VERBS]);
  const estimate = estimatePrefixTokens(buildDevspecInstructions());
  assert.ok(Number.isFinite(estimate) && estimate > 0);
});
