/** Staging-only real TUI + real MCP + browser-operated question/owner command.
 * Explicit empty room and private directory required. Read phase.json; answer
 * the test card, send one LOCAL-FOLLOWUP message through the UI, observe Working,
 * release bg-0-release then bg-1-release, verify idle, then create finish.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToken, resolveEndpoint } from '../extensions/core/auth-store.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = process.env.HANDOFF_PROBE_ROOT, room = process.env.HANDOFF_LIVE_SESSION, provider = process.env.PI_BACKGROUND_EXTENSION;
assert(temp && isAbsolute(temp) && room && /^[a-f0-9-]{36}$/i.test(room), 'Explicit disposable room and absolute artifact directory required');
assert(provider && isAbsolute(provider) && existsSync(provider), 'Installed public background provider required');
const endpoint = await resolveEndpoint(); assert.equal(new URL(endpoint).origin, 'https://app.devspecstaging.com', 'Never run this test on production');
const auth = await resolveToken(); assert(auth, 'Host must already be authenticated');
const preempt = process.env.HANDOFF_LIVE_PREEMPT !== 'off';
const runtimePath = resolve(root, 'extensions/devspec-remote.ts');
const sourceHash = createHash('sha256').update(readFileSync(runtimePath)).digest('hex');
const hostVersion = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
const pluginVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const native = randomUUID(), session = join(temp, 'native.jsonl');
mkdirSync(join(temp, 'agent/devspec'), { recursive: true, mode: 0o700 });
assert(!existsSync(session), 'Use a fresh private directory');
writeFileSync(join(temp, 'agent/devspec/settings.json'), JSON.stringify({ autoBond: false, preemptOwner: preempt }), { mode: 0o600 });
writeFileSync(session, JSON.stringify({ type: 'session', version: 3, id: native, cwd: root, timestamp: new Date().toISOString() }) + '\n', { mode: 0o600 });
writeFileSync(join(temp, 'owner-release'), 'owner response is immediately ready');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const argv = ['pi', '--offline', '--session', session, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-builtin-tools',
  '-e', provider, '-e', runtimePath, '-e', resolve(root, 'scripts/live-question-delivery-fixture.ts'), '--provider', 'handoff-probe', '--model', 'scripted'];
const child = spawn('script', ['-q', '-f', '-e', '-c', argv.map(quote).join(' '), join(temp, 'terminal.typescript')], { detached: true, cwd: root,
  env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40', PI_CODING_AGENT_DIR: join(temp, 'agent'), TMPDIR: temp,
    DEVSPEC_MCP_TOKEN: auth.token, DEVSPEC_MCP_URL: endpoint, DEVSPEC_DEBUG_REMOTE: '1', HANDOFF_PROBE_ROOT: temp, HANDOFF_PROBE_BACKGROUND: '1',
    HANDOFF_PROBE_IGNORE_ABORT: '0', PI_BG_FEATURES: 'process', PI_BG_DOCK_SHORTCUT: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const send = message => child.stdin.write(`${message}\r`);
const until = async (predicate, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`TUI exited at ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${label}`);
};
const rows = () => { const text = readFileSync(session, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line)); };
const observed = () => rows().filter(row => row.customType === 'devspec-background-observation');
const terminals = () => new Set(observed().filter(row => row.data.task.state === 'completed').map(row => row.data.task.id));
const owners = () => rows().filter(row => row.type === 'message' && row.message?.role === 'user' && JSON.stringify(row.message.content).includes('LOCAL-FOLLOWUP'));
const phase = value => writeFileSync(join(temp, 'phase.json'), JSON.stringify({ phase: value, room, native, at: new Date().toISOString() }), { mode: 0o600 });
try {
  await until(() => existsSync(join(temp, 'tui-ready.json')), 'real TUI startup');
  assert.equal(JSON.parse(readFileSync(join(temp, 'tui-ready.json'), 'utf8')).mode, 'tui');
  send(`/devspec.remote --session ${room}`);
  // Status commands are public host controls; check actual attachment, not a
  // command response that could merely mean an error was displayed.
  await until(() => existsSync(join(temp, 'devspec-remote-debug.log')) && readFileSync(join(temp, 'devspec-remote-debug.log'), 'utf8').includes('canonical ingress synced'), 'bond and first poll');
  send('/probe-live-status');
  await until(() => existsSync(join(temp, 'live-status.json')), 'attachment metadata');
  const binding = JSON.parse(readFileSync(join(temp, 'live-status.json'), 'utf8'));
  assert(binding.connectionId && binding.sessionId === room, 'Exact test attachment required before any question/jobs');
  send('/probe-live-question');
  await until(() => existsSync(join(temp, 'question.json')), 'test question creation');
  phase('awaiting_browser_answer');
  await until(() => existsSync(join(temp, 'question-started')) && new Set(observed().map(row => row.data.task.id)).size === 2, 'browser answer and question foreground', 300000);
  phase('question_running_send_owner_message');
  await until(() => owners().length === 1, 'one browser owner command', 300000);
  await until(() => rows().some(row => row.message?.role === 'assistant' && row.message.stopReason === 'stop' && JSON.stringify(row.message.content).includes('PROBE-owner-finished')), 'owner answer');
  assert(!existsSync(join(temp, 'question-release')) || !preempt, 'Enabled preemption must not wait for a manual release');
  phase('owner_answered_background_running');
  await until(() => terminals().size === 1, 'first controlled background release', 300000);
  phase('one_background_running');
  await until(() => terminals().size === 2, 'second controlled background release', 300000);
  phase('both_terminal_verify_browser_and_sql');
  await until(() => existsSync(join(temp, 'finish')), 'finish after browser/SQL observations', 300000);
  assert.equal(owners().length, 1);
  assert.equal(rows().filter(row => row.message?.customType === 'background-task-notification').length, 0);
  assert.equal(createHash('sha256').update(readFileSync(runtimePath)).digest('hex'), sourceHash, 'Runtime changed during live verification');
  console.log(JSON.stringify({ result: 'PASS', actualHost: 'Pi interactive TUI', liveServer: true, hostVersion, pluginVersion, pluginPath: runtimePath,
    sourceHash, preempt, ownerCopies: owners().length, ownerPersistedAt: owners()[0].timestamp, backgroundNotifications: 0,
    connectionId: binding.connectionId, room, native, artifacts: temp }, null, 2));
} catch (error) { console.error(JSON.stringify({ result: 'FAIL', error: String(error), room, native, artifacts: temp })); process.exitCode = 1; }
finally {
  for (const index of [0, 1]) writeFileSync(join(temp, `bg-${index}-release`), 'cleanup');
  writeFileSync(join(temp, 'question-release'), 'cleanup');
  if (child.exitCode === null && child.signalCode === null) {
    send('/probe-live-end');
    await until(() => existsSync(join(temp, 'stopped.json')), 'confirmed test disconnect', 15000).catch(() => {
      console.error('Test disconnect unconfirmed; inspect only this test connection before reporting cleanup.'); process.exitCode = 1;
    });
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
}
