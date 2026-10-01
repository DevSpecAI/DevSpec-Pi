/** Native Pi tool augmentation with a prior commit, localhost MCP, no real records. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), temp = mkdtempSync(join(tmpdir(), 'pi-commit-hints-')), repo = join(temp, 'repo');
const records = [], observations = [], errors = [];
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let text = ''; for await (const part of req) text += part;
    const rpc = JSON.parse(text); let result = {};
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'hint-fixture', version: '1' }, capabilities: { tools: {} } };
    else if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    else if (rpc.method === 'tools/list') result = { tools: [] };
    else if (rpc.method === 'tools/call') {
      const { name, arguments: args } = rpc.params;
      if (name === 'report_commit_provenance') { observations.push(args); result = { content: [{ type: 'text', text: '{"recorded":true}' }] }; }
      else if (name === 'record_implementation') { records.push(args); result = { content: [{ type: 'text', text: JSON.stringify({ id: args.action_item_id, lifecycle: 'implemented', agent_activity: 'finished' }) }] }; }
      else throw new Error(`Unexpected fixture call: ${name}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  mkdirSync(repo); for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) execFileSync('git', args, { cwd: repo });
  mkdirSync(join(repo, '.devspec')); writeFileSync(join(repo, '.devspec/project.json'), JSON.stringify({ project_id: '11111111-2222-4333-8444-555555555555' }));
  const env = { ...process.env, HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'), PI_CODING_AGENT_DIR: join(temp, 'agent'), TMPDIR: temp,
    DEVSPEC_MCP_TOKEN: 'fixture-only', DEVSPEC_MCP_URL: `http://127.0.0.1:${server.address().port}/api/mcp`, COMMIT_HINT_PROBE_CWD: repo, NODE_OPTIONS: '' };
  const output = await new Promise((resolve, reject) => {
    const child = spawn('pi', ['--mode', 'json', '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', join(root, 'scripts/commit-hint-runtime-fixture.ts'), '-e', join(root, 'extensions/devspec-commit-ledger.ts'), '-e', join(root, 'extensions/devspec-tools.ts'),
      '--provider', 'commit-hint-probe', '--model', 'scripted', '-p', 'Run the scoped commit-hint fixture.'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Fixture timeout: ${err.slice(-1000)}`)); }, 90_000);
    child.stdout.on('data', value => { out += value; }); child.stderr.on('data', value => { err += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Pi exit ${code}: ${err.slice(-2000)} ${out.slice(-1000)}`)); });
  });
  assert(output.includes('COMMIT-HINT-RUNTIME-PASS'), output.slice(-2000));
  assert.deepEqual(errors, []);
  assert.equal(observations.length, 1, 'the real commit must still be mechanically reported');
  assert.equal(records.length, 3, 'actual native recording calls must reach the fixture');
  assert.equal(Object.hasOwn(records[0], 'commit_sha'), false, 'report-only work must not inherit the sole prior commit');
  assert.equal(Object.hasOwn(records[0], 'commit_message'), false);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(records[1].commit_sha, sha.slice(0, 8), 'a local hit must not erase project-wide ambiguity');
  assert.equal(Object.hasOwn(records[1], 'commit_message'), false);
  assert.equal(records[2].commit_sha, sha);
  assert.match(records[2].commit_message, /prior task/);
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(),
    pluginVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, pluginRoot: root,
    realObservationRetained: true, omittedRemainedOmitted: true, shortHintUnchanged: true, explicitFullMessageCorroborated: true, paidInference: 0, liveRecords: 0 }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
