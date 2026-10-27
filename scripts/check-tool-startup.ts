/** Disposable real Pi SDK startup, no model calls or DevSpec writes. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import registerTools from '../extensions/devspec-tools.ts';
import { ACTIVATION_ONLY_VERBS, TOOL_LOADER_NAME } from '../extensions/core/model-surface.ts';
import { MODEL_VERB_NAMES, PUMP_VERBS, NEVER_MODEL_VERBS } from '../extensions/generated/mcp-catalog.ts';

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'devspec-tool-startup-'));
  try {
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel('openai-codex', 'gpt-6-astra');
    if (!model) throw new Error('Test model metadata unavailable; no model request is made');
    const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [registerTools] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model, settingsManager: settings, resourceLoader: loader, noTools: true, sessionManager: SessionManager.inMemory(directory) });
    try {
      // Match Pi's print/RPC entry point: construction registers tools;
      // binding emits session_start and applies the host activation policy.
      await session.bindExtensions({ mode: 'print' });
      const active = session.getActiveToolNames();
      for (const name of MODEL_VERB_NAMES) assert.equal(active.includes(name), !ACTIVATION_ONLY_VERBS.has(name), name);
      for (const name of [...PUMP_VERBS, ...NEVER_MODEL_VERBS]) assert.ok(!active.includes(name), name);
      assert.equal(active.filter(name => name === TOOL_LOADER_NAME).length, 1);
      assert.equal(active.length, new Set(active).size);
      console.log(JSON.stringify({ passed: true, activeTools: active.length, modelRequests: 0, contextBoundUnavailable: [...ACTIVATION_ONLY_VERBS], extension: 'actual devspec-tools registration' }));
    } finally { session.dispose(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Startup check failed'); process.exitCode = 1 });
