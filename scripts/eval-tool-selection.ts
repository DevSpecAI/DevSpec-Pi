/** Bounded real-model tool-selection check. All tools are inert fixture tools:
 * no DevSpec writes, shell, network tools, repository discovery or extensions.
 * Provider calls use the operator's normal ModelRuntime credentials, never logs.
 * node --experimental-strip-types scripts/eval-tool-selection.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { allModelFacingTools, searchRareModelTools } from '../extensions/core/model-surface.ts';
import { buildDevspecInstructions } from '../extensions/core/instructions.ts';
import { jsonSchemaToTypebox } from '../extensions/core/json-schema.ts';
import { projectedToolResult } from '../extensions/core/result.ts';

const RESOURCE = '11111111-1111-4111-8111-111111111111';
const MEMORY = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const cases = [
  { name: 'shared investigation', expected: 'create_resource', prompt: 'Please preserve this investigation as a shared reference for the next agent: the import timeout happens only when the remote server closes its idle connection; retries should reconnect rather than reuse that socket. Include the finding and a short reproduction checklist. This is documentation, not a request to implement a fix.' },
  { name: 'targeted runbook update', expected: 'update_resource', prompt: `Update our existing runbook ${RESOURCE}: the approved log-retention period is now 60 days instead of 30. Keep the other guidance intact.` },
  { name: 'replace changed decision', expected: 'supersede_memory', prompt: `We have explicitly changed decision ${MEMORY}. PostgreSQL now replaces SQLite for the shared service because concurrent writers are required. Preserve the old decision as history and make the replacement current.` },
  { name: 'release untouched work', expected: 'release_work_item', prompt: `Release my claim on task ${ITEM}. No files were changed and someone else can safely pick it up. Do not mark it implemented or failed.` },
  { name: 'repository document exception', expected: 'write', prompt: 'Update /sandbox/README.md to say the command is now npm start instead of npm run serve. This README is distributed with the package, so the change must be in that repository file, not a separate shared document. The covering work item is already claimed.' },
  { name: 'optional selection aid', expected: 'search_devspec_tools', prompt: 'Use the tool-selection search to find the operation for preserving a handoff for another agent. Report the recommendation, but do not create or change any record.' },
] as const;

async function main() {
  const runtime = await ModelRuntime.create();
  const available = await runtime.getAvailable();
  const output = resolve('.pi/evidence/tool-selection');
  await mkdir(output, { recursive: true });
  const reports: unknown[] = [];
  const providerIndex = process.argv.indexOf('--provider');
  const modelIndex = process.argv.indexOf('--model');
  if ((providerIndex >= 0) !== (modelIndex >= 0)) throw new Error('Specify both --provider and --model for a deliberate single-route retry');
  const routes = providerIndex >= 0 ? [{ provider: process.argv[providerIndex + 1]!, id: process.argv[modelIndex + 1]! }]
    : [{ provider: 'openai-codex', id: 'gpt-6-astra' }];
  const reportName = providerIndex < 0 ? 'report.json' : `report-${routes[0]!.provider}-${routes[0]!.id}`.replace(/[^a-z0-9.-]/gi, '-') + '.json';
  for (const route of routes) {
    const model = available.find(model => model.provider === route.provider && model.id === route.id);
    if (!model) throw new Error(`Configured model unavailable: ${route.provider}/${route.id}; no substitute selected`);
    for (const fixture of cases) {
      const calls: Array<{ name: string; args: unknown }> = [];
      const effects: string[] = [];
      const tools: ToolDefinition[] = allModelFacingTools().map(entry => ({
        name: entry.name, label: entry.name, description: entry.description,
        parameters: jsonSchemaToTypebox(entry.inputSchema),
        execute: async (_id, args) => {
          calls.push({ name: entry.name, args });
          let details: unknown = { results: [], items: [], memories: [], artifacts: [] };
          if (entry.name === 'get_resource') details = { id: RESOURCE, title: 'Operations runbook', body: 'Keep logs for 30 days.\nNever store credentials in logs.\nRestrict log access to the operations team.' };
          if (entry.name === 'get_memory') details = { id: MEMORY, title: 'Storage decision', body: 'Use SQLite for the shared service. This decision assumed only one writer.', state: 'decided' };
          if (entry.name === 'get_action_item') details = { id: ITEM, title: 'Update package documentation', intent: 'Keep distributed documentation current', agent_activity: 'implementing', acceptance_criteria: [] };
          if (entry.name === 'get_workflow_rules') details = { note: 'This fixture is an authorized documentation/record request. No repository implementation is requested except the explicitly claimed README change. Observation is not human sign-off.' };
          if (entry.name === 'search_devspec_tools') details = { mode: 'lexical', degraded: true, reason: 'Offline fixture: all eligible tools remain callable.', matches: searchRareModelTools(String((args as { query?: string }).query ?? ''), 3).map(tool => ({ name: tool.name, description: tool.description })) };
          const readOperation = /^(get_|search_|list_|preview_|generate_|validate_)/.test(entry.name) ||
            (entry.name.startsWith('manage_') && ['get', 'list'].includes(String((args as { action?: string }).action)));
          if (!readOperation) {
            effects.push(entry.name);
            details = { id: entry.name.includes('memory') ? MEMORY : RESOURCE, outcome: 'committed', created: entry.name === 'create_resource', updated: entry.name === 'update_resource', released: entry.name === 'release_work_item' };
          }
          const result = projectedToolResult(entry.name, { text: JSON.stringify(details), details, isError: false });
          return { ...result, ...(effects.length ? { terminate: true } : {}) };
        },
      }));
      tools.push({ name: 'read', label: 'Read', description: 'Read a repository file.', parameters: Type.Object({ path: Type.String() }), execute: async (_id, args) => { calls.push({ name: 'read', args }); return { content: [{ type: 'text', text: '# Package\nRun npm run serve to start.' }], details: undefined }; } });
      tools.push({ name: 'write', label: 'Write', description: 'Write or replace a repository file.', parameters: Type.Object({ path: Type.String(), content: Type.String() }), execute: async (_id, args) => { calls.push({ name: 'write', args }); effects.push('write'); return { content: [{ type: 'text', text: 'Fixture file written.' }], details: undefined, terminate: true }; } });
      const resourceLoader: ResourceLoader = {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => `You are a coding assistant working in a synthetic test project. Carry out the user's request with the supplied tools. The tools return fixture data and cannot affect real records. Be concise.\n${buildDevspecInstructions()}`,
        getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
      };
      const { session } = await createAgentSession({ cwd: process.cwd(), modelRuntime: runtime, model, thinkingLevel: 'low', resourceLoader, tools: tools.map(tool => tool.name), customTools: tools, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
      let turns = 0;
      const unsubscribe = session.subscribe(event => { if (event.type === 'turn_start' && ++turns > 6) void session.abort(); });
      const timeout = setTimeout(() => { void session.abort(); }, 75000);
      const started = performance.now();
      try {
        await session.prompt(fixture.prompt);
        const messages = session.messages.filter(message => message.role === 'assistant');
        const usage = messages.map(message => ({ model: message.model, provider: message.provider, usage: message.usage, stopReason: message.stopReason, error: message.errorMessage }));
        const primary = fixture.expected === 'search_devspec_tools' ? calls.some(call => call.name === fixture.expected) && effects.length === 0 : effects.length === 1 && effects[0] === fixture.expected;
        const report = { model: `${model.provider}/${model.id}`, case: fixture.name, expected: fixture.expected, passed: primary && !messages.some(message => message.stopReason === 'error'), latencyMs: Math.round(performance.now() - started), turns, calls, effects, usage };
        reports.push(report);
        console.log(JSON.stringify(report));
        await writeFile(resolve(output, reportName), JSON.stringify(reports, null, 2));
        // A provider error is infrastructure failure, not six tool-selection
        // failures. Stop this route instead of repeating the same failed call.
        if (messages.some(message => message.stopReason === 'error')) break;
      } finally { clearTimeout(timeout); unsubscribe(); session.dispose(); }
    }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Model check failed'); process.exitCode = 1 });
