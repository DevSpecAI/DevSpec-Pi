/** Actual Pi CLI, deterministic provider, disposable Git and localhost MCP only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'pi-commit-runtime-'));
const changed = process.argv.includes('--change-binding');
const repo = join(temp, 'repo'), wt = join(temp, 'linked worktree');
const project = '11111111-2222-4333-8444-555555555555';
const connection = '99999999-8888-4777-8666-555555555555';
const reports = [], unexpected = [];
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw); let result = {};
    if (req.url !== '/api/mcp') unexpected.push('wrong endpoint');
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'commit-fixture', version: '1' }, capabilities: { tools: {} } };
    else if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    else if (rpc.method === 'tools/list') result = { tools: [] };
    else if (rpc.method === 'tools/call') {
      const { name, arguments: args } = rpc.params;
      if (name !== 'report_commit_provenance') unexpected.push(name);
      assert.equal(req.headers.authorization, 'Bearer fixture-original-account');
      assert.equal(req.headers['x-devspec-connection-capability'], 'dvsc_fixture_original_capability_123456');
      reports.push(args); result = textResult({ recorded: true });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  } catch (error) { unexpected.push(String(error)); res.writeHead(500); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  mkdirSync(repo); git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  mkdirSync(join(repo, '.devspec')); writeFileSync(join(repo, '.devspec/project.json'), JSON.stringify({ project_id: project }));
  const commands = changed ? ['git commit --allow-empty -q -m root'] : [
    'git commit --allow-empty -q -m root',
    'git commit --amend --allow-empty -q -m amended',
    `git worktree add -q -b topic '${wt}'`,
    `cd '${wt}' && git commit --allow-empty -q -m worktree`,
    `git -C '${wt}' commit --allow-empty -q -m alternate`,
    'git merge --ff-only topic',
  ];
  const env = { ...process.env, HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'), PI_CODING_AGENT_DIR: join(temp, 'agent'),
    TMPDIR: temp, DEVSPEC_MCP_TOKEN: 'fixture-original-account', DEVSPEC_MCP_URL: `http://127.0.0.1:${server.address().port}/api/mcp`,
    COMMIT_PROBE_COMMANDS: JSON.stringify(commands), COMMIT_PROBE_CHANGE: changed ? '1' : '0', NODE_OPTIONS: '' };
  const out = await new Promise((resolve, reject) => {
    const child = spawn('pi', ['--mode', 'json', '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
      '-e', join(root, 'scripts/commit-observation-runtime-fixture.ts'), '-e', join(root, 'extensions/devspec-commit-ledger.ts'),
      '--provider', 'commit-observer-probe', '--model', 'scripted', '-p', 'Run the commit observation fixture.'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Pi fixture timed out: ${stderr.slice(-2000)}`)); }, 90_000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`Pi exit ${code}: ${stderr.slice(-3000)} ${stdout.slice(-1000)}`)); });
  });
  const events = out.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.some(event => event.type === 'extension_error'), false, 'extension event failures are not silent passes');
  assert(out.includes('COMMIT-OBSERVER-RUNTIME-PASS'), out.slice(-2000));
  assert.deepEqual(unexpected, []);
  assert.equal(reports.length, changed ? 0 : 4);
  if (changed) assert.equal(git(['show', '-s', '--format=%s', 'HEAD']), 'root', 'changing binding must never block Git');
  else {
    assert.equal(git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD'], wt), 'fast-forward really executed');
    assert.equal(new Set(reports.map(report => report.observation_id)).size, 4);
    assert.deepEqual(reports.map(report => git(['show', '-s', '--format=%s', report.commit_sha])), ['root', 'amended', 'worktree', 'alternate']);
    for (const report of reports) { assert.equal(report.connection_id, connection); assert.equal(report.pinned_project_id, project); }
  }
  console.log(JSON.stringify({ result: 'PASS', host: execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim(),
    pluginVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, pluginRoot: root,
    scenario: changed ? 'binding-changed-after-git' : 'root-amend-worktree-fast-forward', reports: reports.length, paidInference: 0, liveDevspecRecords: 0 }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
