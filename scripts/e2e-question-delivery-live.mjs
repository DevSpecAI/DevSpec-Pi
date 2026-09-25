/** Staging-only real Pi RPC + real MCP + browser-operated question/command.
 * RPC acknowledgements synchronize test controls; an empty room need not emit
 * a canonical data window. Interactive TUI proof is the separate repro script.
 * Explicit room/root required. Answer the card, send one LOCAL-FOLLOWUP message,
 * release bg-0-release then bg-1-release, verify idle, then create finish.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { resolveToken, resolveEndpoint } from '../extensions/core/auth-store.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = process.env.HANDOFF_PROBE_ROOT, room = process.env.HANDOFF_LIVE_SESSION, provider = process.env.PI_BACKGROUND_EXTENSION;
assert(temp && isAbsolute(temp) && room && /^[a-f0-9-]{36}$/i.test(room), 'Explicit disposable room and absolute artifact directory required');
assert(provider && isAbsolute(provider) && existsSync(provider), 'Installed public background provider required');
const endpoint = await resolveEndpoint(); assert.equal(new URL(endpoint).origin, 'https://app.devspecstaging.com', 'Never run on production');
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
const events = [], failures = [];
const child = spawn('pi', ['--mode', 'rpc', '--offline', '--session', session, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-builtin-tools',
  '-e', provider, '-e', runtimePath, '-e', resolve(root, 'scripts/live-question-delivery-fixture.ts'), '--provider', 'handoff-probe', '--model', 'scripted'], {
  cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, 'agent'), TMPDIR: temp,
    DEVSPEC_MCP_TOKEN: auth.token, DEVSPEC_MCP_URL: endpoint, DEVSPEC_DEBUG_REMOTE: '1', HANDOFF_PROBE_ROOT: temp, HANDOFF_PROBE_BACKGROUND: '1',
    HANDOFF_PROBE_IGNORE_ABORT: '0', PI_BG_FEATURES: 'process', PI_BG_DOCK_SHORTCUT: 'off' }, stdio: ['pipe', 'pipe', 'pipe'] });
let pending = ''; const decoder = new StringDecoder('utf8');
child.stdout.on('data', chunk => {
  pending += decoder.write(chunk); let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try { const event = JSON.parse(line); events.push({ at: Date.now(), type: event.type, id: event.id, success: event.success });
      if (event.type === 'extension_error') failures.push('extension failed');
    } catch { failures.push('non-JSON host output'); }
  }
});
child.stderr.on('data', () => {});
const send = (id, message) => child.stdin.write(JSON.stringify({ id, type: 'prompt', message }) + '\n');
const until = async (predicate, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (failures.length || child.exitCode !== null || child.signalCode !== null) throw new Error(`Host failed at ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${label}`);
};
const command = async (id, message) => {
  send(id, message); await until(() => events.some(event => event.id === id), `command ${id}`);
  assert(events.find(event => event.id === id)?.success, `Command ${id} failed`);
};
const rows = () => { const text = readFileSync(session, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line)); };
const observed = () => rows().filter(row => row.customType === 'devspec-background-observation');
const terminals = () => new Set(observed().filter(row => row.data.task.state === 'completed').map(row => row.data.task.id));
const owners = () => rows().filter(row => row.type === 'message' && row.message?.role === 'user' && JSON.stringify(row.message.content).includes('LOCAL-FOLLOWUP'));
const phase = value => writeFileSync(join(temp, 'phase.json'), JSON.stringify({ phase: value, room, native, at: new Date().toISOString() }), { mode: 0o600 });
let attached = false;
try {
  await command('bond', `/devspec.remote --session ${room}`);
  await command('status', '/probe-live-status');
  const binding = JSON.parse(readFileSync(join(temp, 'live-status.json'), 'utf8'));
  assert(binding.connectionId && binding.sessionId === room && binding.mode === 'rpc', 'Exact test attachment required before any question/jobs'); attached = true;
  await command('question', '/probe-live-question');
  assert(existsSync(join(temp, 'question.json')), 'Question not confirmed');
  phase('awaiting_browser_answer');
  await until(() => existsSync(join(temp, 'question-started')) && new Set(observed().map(row => row.data.task.id)).size === 2, 'browser answer and question foreground', 300000);
  phase('question_running_send_owner_message');
  await until(() => owners().length === 1, 'one browser owner command', 300000);
  await until(() => rows().some(row => row.message?.role === 'assistant' && row.message.stopReason === 'stop' && JSON.stringify(row.message.content).includes('PROBE-owner-finished')), 'owner answer');
  assert(!existsSync(join(temp, 'question-release')) || !preempt, 'Preemption must not wait for manual release');
  phase('owner_answered_background_running');
  await until(() => terminals().size === 1, 'first controlled background release', 300000); phase('one_background_running');
  await until(() => terminals().size === 2, 'second controlled background release', 300000); phase('both_terminal_verify_browser_and_sql');
  await until(() => existsSync(join(temp, 'finish')), 'finish after browser/SQL observations', 300000);
  assert.equal(owners().length, 1);
  assert.equal(rows().filter(row => row.message?.customType === 'background-task-notification').length, 0);
  assert.equal(createHash('sha256').update(readFileSync(runtimePath)).digest('hex'), sourceHash, 'Runtime changed during verification');
  console.log(JSON.stringify({ result: 'PASS', actualHost: 'Pi RPC', liveServer: true, hostVersion, pluginVersion, pluginPath: runtimePath,
    sourceHash, preempt, ownerCopies: owners().length, ownerPersistedAt: owners()[0].timestamp, backgroundNotifications: 0,
    connectionId: binding.connectionId, room, native, artifacts: temp }, null, 2));
} catch (error) { console.error(JSON.stringify({ result: 'FAIL', error: String(error), room, native, artifacts: temp })); process.exitCode = 1; }
finally {
  for (const index of [0, 1]) writeFileSync(join(temp, `bg-${index}-release`), 'cleanup');
  writeFileSync(join(temp, 'question-release'), 'cleanup');
  if (child.exitCode === null && child.signalCode === null) {
    if (attached) await command('end', '/probe-live-end').catch(() => { console.error('Test disconnect unconfirmed; inspect this connection.'); process.exitCode = 1; });
    child.stdin.end();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  writeFileSync(join(temp, 'host-metadata.json'), JSON.stringify(events, null, 2), { mode: 0o600 });
}
