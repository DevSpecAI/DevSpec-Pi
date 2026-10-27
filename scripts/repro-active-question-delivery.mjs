/** Before/after actual-TUI probe with real PostgreSQL delivery/handoff functions.
 * Default reproduces the pinned pre-fix body (live-matched 2026-09-25).
 * --fixed qualifies the new handoff; add --preempt-off [--quiet-ms=100000],
 * --nonsettling-abort, or --background (requires PI_BACKGROUND_EXTENSION).
 * Remaining MCP transport/model are fixtures: no deployed-server claim.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPoll, IDS } from '../tests/canonical-ingress-fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const serverRoot = process.env.DEVSPEC_V2_ROOT;
assert(serverRoot, 'Explicit paired server checkout required');
const fixed = process.argv.includes('--fixed');
const preempt = !process.argv.includes('--preempt-off');
const nonsettling = process.argv.includes('--nonsettling-abort');
const permanentStall = process.argv.includes('--permanent-stall');
const background = process.argv.includes('--background');
const quietMs = Number(process.argv.find(arg => arg.startsWith('--quiet-ms='))?.split('=')[1] ?? 0);
const capability = 'dvsc_fixture_only_12345678901234567890';
const capabilityHash = createHash('sha256').update(capability).digest('hex');
const parseOfferRequest = fixed ? (await import(resolve(serverRoot, 'apps/web/lib/mcp/command-offer.ts'))).parseCommandOfferRequest : null;
if (background) assert(process.env.PI_BACKGROUND_EXTENSION && existsSync(process.env.PI_BACKGROUND_EXTENSION), 'Public provider entrypoint required');
if (permanentStall) assert(fixed && preempt && !background, 'Permanent-stall limit probe requires --fixed, preempt on, and no background jobs');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const extensionTreeHash = () => {
  const hash = createHash('sha256');
  const visit = dir => { for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name); if (entry.isDirectory()) visit(path); else if (entry.isFile()) hash.update(path.slice(root.length)).update(readFileSync(path));
  } }; visit(resolve(root, 'extensions')); return hash.digest('hex');
};
const runtimePath = resolve(root, 'extensions/devspec-remote.ts');
const runtimeHashAtStart = digest(runtimePath), treeHashAtStart = extensionTreeHash();
const fixtureHashAtStart = digest(resolve(root, 'scripts/active-question-delivery-fixture.ts'));
const pluginVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const hostVersion = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
const migrationHashAtStart = fixed ? digest(resolve(serverRoot, 'supabase/migrations/985_active_question_command_handoff.sql')) : null;
const temp = mkdtempSync(join(tmpdir(), 'pi-active-question-tui-'));
const pgRoot = '/usr/lib/postgresql';
const versions = readdirSync(pgRoot).sort((a, b) => Number(a) - Number(b));
const pgBin = join(pgRoot, versions.at(-1), 'bin');
const data = join(temp, 'pgdata');
const pgArgs = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', temp, '-U', 'postgres', '-d', 'fixture'];
const sql = query => execFileSync(join(pgBin, 'psql'), [...pgArgs, '-Atc', query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = uid(1), conn = IDS.connection, room = uid(3), attachment = uid(4), attempt = uid(5), token = uid(11);
const now = new Date().toISOString();
const identity = { connection_id: conn, agent_name: 'Pi', codename: 'Amber Hawk', label: 'Pi · Amber Hawk' };
const session = join(temp, 'native.jsonl');
const source = readFileSync(resolve(serverRoot, 'supabase/migrations/904_question_dismissal_continuation.sql'), 'utf8');
const definition = source.match(/CREATE OR REPLACE FUNCTION public\.open_agent_command_delivery\([\s\S]*?AS\s+(\$\w*\$)([\s\S]*?)\1;/i);
assert(definition, 'Production delivery function must be extracted exactly');
const deliveryBodyMd5 = createHash('md5').update(definition[2]).digest('hex');
// Rechecked against Development pg_proc before this reproduction (2026-09-25).
assert.equal(deliveryBodyMd5, process.env.EXPECTED_DELIVERY_BODY_MD5 ?? '8473c268b759542166c1b38a8fc43426', 'Fixture must match the live delivery body');
const event = { kind: 'devspec.interaction_event', version: 1, event_id: uid(6), response_id: uid(7), question_id: uid(8), origin_connection_id: conn,
  source_session_id: room, response_kind: 'text', answer: 'QUESTION-PROBE', answered_at: now, claim_token: uid(9), lease_expires_at: new Date(Date.now() + 600000).toISOString() };
const calls = [], failures = [], streams = new Set();
let child, pgStarted = false, enabled = false, questionOffered = false, acked = false, ownerWaiting = false, ownerOffered = false;
const response = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const base = () => ({ connection_id: conn, project_id: IDS.project, session_id: room, attached_at: now, speech_attachment_id: attachment,
  changed: false, cursor_v2: null, dispatch_cursor: null, dispatches: [], system_notice_version: 2, system_notice_cursor: null, system_notices: [],
});
const open = args => JSON.parse(sql(fixed && args.command_offer_version === 1
  ? `select public.open_agent_command_delivery_ready_v1('${IDS.project}','${conn}','${room}','${IDS.command}','${IDS.owner}','${token}','${capabilityHash}','${attachment}',${args.command_handoff_ready ? `'${JSON.stringify(args.command_handoff_ready)}'::jsonb` : 'null'})`
  : `select public.open_agent_command_delivery('${IDS.project}','${conn}','${room}','${IDS.command}','${IDS.owner}','${token}')`));
function poll(args) {
  if (fixed) parseOfferRequest(args, { callerConnectionId: conn, callerConnectionCapabilityHash: capabilityHash }, conn);
  const result = { ...base(), ...(args.interaction_event_version === 1 ? { interaction_event_version: 1, interaction_events: [], question_dismissal_event_version: 1, question_dismissal_events: [] } : {}),
    ...(fixed && args.command_offer_version === 1 ? { command_offer_version: 1, command_offer: null, command_handoff_stale: false } : {}) };
  if (args.interaction_event_ack) {
    assert.equal(args.interaction_event_ack.event_id, event.event_id); assert.equal(args.interaction_event_ack.claim_token, event.claim_token);
    acked = true;
    sql(`update public.session_agent_question_answer_events set acknowledged_at=clock_timestamp(),ack_claim_token='${event.claim_token}' where id='${event.event_id}'`);
    return result;
  }
  if (ownerWaiting && !ownerOffered) {
    const receipt = open(args);
    calls.push({ at: Date.now(), name: 'delivery_admission', outcome: receipt?.outcome ?? 'opened', ready: Boolean(args.command_handoff_ready) });
    if (receipt?.outcome === 'blocked_by_interaction' || receipt?.outcome === 'handoff_stale') {
      if (!fixed) return result;
      return { ...result, ...canonicalPoll({ wakeKind: 'advisory_update', senderStyleNegotiated: args.sender_style_version === 1 }),
        command_handoff_stale: receipt.outcome === 'handoff_stale', command_offer: receipt.blocking_attempt_id ? {
          version: 1, connection_id: conn, source_session_id: room, attachment_id: attachment, source_message_id: IDS.command,
          blocking_attempt_id: receipt.blocking_attempt_id, attachments: [],
        } : null };
    }
    assert(receipt?.id && receipt.turn_id);
    ownerOffered = true;
    const payload = canonicalPoll({ body: 'LOCAL-FOLLOWUP via authorized UI command', senderStyleNegotiated: args.sender_style_version === 1,
      context: { human_context: [], agent_context: [], ai_context: [], system_context: [] } });
    const command = payload.ingress.commands[0];
    command.delivery = { provenance_ref: receipt.id, turn_id: receipt.turn_id, primary_provenance_ref: receipt.primary_delivery_id, is_primary: receipt.is_primary };
    return { ...result, ...payload };
  }
  if (enabled && !questionOffered && args.interaction_event_version === 1) { questionOffered = true; result.interaction_events = [event]; }
  return result;
}
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(res); res.write('event: wake\ndata: {}\n\n'); res.on('close', () => streams.delete(res)); return; }
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body); let result = {};
    if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'active-question-repro', version: '1' }, capabilities: { tools: {}, resources: {} } };
    else if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
    else if (rpc.method === 'tools/list') result = { tools: [] };
    else if (rpc.method === 'resources/read') result = { contents: [{ uri: rpc.params.uri, mimeType: 'application/json', text: JSON.stringify({ kind: 'devspec.product.remote_ingress_contract', schema_version: 1, contract_version: '1.5.0', policy: { policy_version: '2026-09-18.1' } }) }] };
    else if (rpc.method === 'tools/call') {
      const { name, arguments: args = {} } = rpc.params;
      calls.push({ at: Date.now(), name, exactQuestion: args.attempt_id === attempt, ack: Boolean(args.interaction_event_ack), sourceSpeech: Boolean(args.assistant_source_id) });
      if (args.command_offer_version === 1) assert.equal(req.headers['x-devspec-connection-capability'], capability);
      if (name === 'register_connection') result = { ...response({ ...base(), codename: identity.codename }), _meta: { devspec: { connection_capability: { version: 1, value: capability } } } };
      else if (name === 'attach_connection') result = response(base());
      else if (name === 'poll_connection') result = response(poll(args));
      else if (name === 'report_pickup' && args.speech_scope) result = response({ attempt_id: attempt, expected_session_id: room, expected_attached_at: now, expected_attachment_id: attachment });
      else if (name === 'report_pickup' && args.interaction_event_id === event.event_id) {
        sql(`insert into public.agent_connection_activity(attempt_id,connection_id,project_id,session_id,interaction_event_id,interaction_response_id,interaction_claim_token,phase,opened_at,started_at,lease_expires_at)
          values('${attempt}','${conn}','${IDS.project}','${room}','${event.event_id}','${event.response_id}','${event.claim_token}','working',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes') on conflict do nothing`);
        result = response({ outcome: 'started', phase: 'working', idempotent: false, attempt_id: attempt, source_session_id: room });
      } else if (name === 'report_complete') {
        if (args.attempt_id === attempt) {
          assert.equal(args.interaction_event_id, event.event_id);
          assert.equal(args.interaction_claim_token, event.claim_token);
          sql(`do $$begin perform 1 from public.agent_connections where id='${conn}' for update;
            if exists(select 1 from public.agent_connection_activity where attempt_id='${attempt}' and phase in ('pending','working')) then
              perform private.terminalize_interaction_attempt_v1('${conn}','${attempt}','${event.claim_token}','done','turn_end',clock_timestamp(),false);
            end if; end$$;`);
        } else if (args.command_turn_id) {
          assert(/^[0-9a-f-]{36}$/i.test(args.command_turn_id));
          sql(`select public.complete_agent_activity_command_turn('${conn}',
            (select attempt_id from public.agent_connection_activity where connection_id='${conn}' and source_message_id='${IDS.command}' and phase in ('pending','working') order by opened_at desc limit 1),
            '${args.command_turn_id}','turn_end')`);
        }
        result = response({ connection_id: conn, attempt_id: args.attempt_id, command_turn_id: args.command_turn_id, command_message_id: args.command_message_id, phase: 'done' });
      } else if (name === 'get_session_transcript') result = response({ session: { id: room, title: 'Active question reproduction' }, messages: [] });
      else if (name === 'post_session_message') result = response({ connection_id: conn, session_id: room, phase: args.phase ?? 'answer', turn_kind: args.turn_kind,
        assistant_source_id: args.assistant_source_id, message_id: uid(100), delivery: { status: 'stored', message_id: uid(100) } });
      else result = response({ success: true });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  } catch (error) { failures.push(String(error)); res.writeHead(500); res.end(); }
});
const wake = () => { for (const stream of streams) stream.write('event: wake\ndata: {}\n\n'); };
const until = async (predicate, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (failures.length) throw new Error(`${label}: ${failures.join('; ')}`);
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`TUI exited at ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`timeout: ${label}`);
};
const entries = () => { const text = readFileSync(session, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line)); };
const ownerEntries = () => entries().filter(row => row.type === 'message' && row.message?.role === 'user' && JSON.stringify(row.message.content).includes('LOCAL-FOLLOWUP via authorized UI command'));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
try {
  execFileSync(join(pgBin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
  execFileSync(join(pgBin, 'pg_ctl'), ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-k ${temp} -c listen_addresses=''`, '-w', 'start'], { stdio: 'ignore' }); pgStarted = true;
  execFileSync(join(pgBin, 'createdb'), ['-h', temp, '-U', 'postgres', 'fixture']);
  sql(`create schema private; create schema extensions; create role anon; create role authenticated; create role service_role;
    create type public.assistant_message_status as enum ('streaming','awaiting_input','completed','error');
    create table public.api_tokens(id uuid primary key,user_id uuid,revoked_at timestamptz);
    create table public.agent_connection_capabilities(connection_id uuid,capability_hash text);
    create table public.session_agent_question_answer_events(id uuid primary key,origin_connection_id uuid,source_session_id uuid,acknowledged_at timestamptz,ack_claim_token uuid,claimed_at timestamptz,claim_token uuid,lease_expires_at timestamptz);
    create table public.session_agent_question_dismissal_events(like public.session_agent_question_answer_events including all);
    create table public.agent_connections(id uuid primary key,project_id uuid,owner_user_id uuid,command_authority text,current_command_turn_id uuid,
      session_id uuid,token_id uuid,ended_at timestamptz,current_command_message_id uuid,current_command_user_id uuid,current_command_at timestamptz,
      speech_attachment_id uuid,busy boolean,busy_at timestamptz,pending boolean,active_turn_message_id uuid);
    create table public.agent_connection_activity(attempt_id uuid primary key default gen_random_uuid(),connection_id uuid,project_id uuid,session_id uuid,source_message_id uuid,
      interaction_event_id uuid,interaction_response_id uuid,question_dismissal_event_id uuid,question_dismissal_question_id uuid,
      interaction_claim_token uuid,question_dismissal_claim_token uuid,phase text,opened_at timestamptz,started_at timestamptz,lease_expires_at timestamptz,terminal_at timestamptz,terminal_reason text);
    create table public.sessions(id uuid primary key,created_by uuid,access text,project_id uuid);
    create table public.session_participants(session_id uuid,user_id uuid,left_at timestamptz);
    create table public.session_messages(id uuid primary key,session_id uuid,role text,message_type text,user_id uuid,target_connection_id uuid,deleted boolean,
      agent_connection_id uuid,agent_activity_attempt_id uuid,content text,response_status public.assistant_message_status,needs_input jsonb,finalized_at timestamptz,completes_turn boolean,last_heartbeat_at timestamptz);
    create table public.agent_command_deliveries(id uuid primary key default gen_random_uuid(),project_id uuid,connection_id uuid,source_session_id uuid,
      source_message_id uuid,requested_by_user_id uuid,connection_owner_user_id uuid,authority_mode text,authority_kind text,turn_id uuid,is_primary boolean,delivered_at timestamptz,closed_at timestamptz);
    create function private.get_project_role_for(uuid,uuid) returns text language sql as $$select 'maintainer'::text$$;
    create function public.assert_current_command_authority(uuid,uuid,uuid) returns void language plpgsql as $$begin
      if $1 <> '${conn}' or $2 <> '${IDS.project}' or $3 <> '${IDS.owner}' then raise exception 'fixture authority mismatch'; end if; end$$;
    insert into public.api_tokens values('${token}','${IDS.owner}',null);
    insert into public.agent_connection_capabilities values('${conn}','${capabilityHash}');
    insert into public.agent_connections(id,project_id,owner_user_id,command_authority,session_id,token_id,speech_attachment_id,busy,busy_at)
      values('${conn}','${IDS.project}','${IDS.owner}','owner','${room}','${token}','${attachment}',true,clock_timestamp());
    insert into public.sessions values('${room}','${IDS.owner}','private','${IDS.project}');
    insert into public.session_messages(id,session_id,role,message_type,user_id,target_connection_id,deleted)
      values('${IDS.command}','${room}','user','local_agent_dispatch','${IDS.owner}','${conn}',false);
    insert into public.session_agent_question_answer_events(id,origin_connection_id,source_session_id,claim_token,lease_expires_at)
      values('${event.event_id}','${conn}','${room}','${event.claim_token}',clock_timestamp()+interval '10 minutes');`);
  for (const name of ['terminalize_question_dismissal_attempt_v1', 'terminalize_interaction_attempt_v1', 'guard_interaction_activity_arbitration_v1']) {
    const body = source.match(new RegExp(`CREATE OR REPLACE FUNCTION private\\.${name}\\([\\s\\S]*?AS\\s+(\\$\\w*\\$)[\\s\\S]*?\\1;`, 'i'))?.[0];
    assert(body, `Missing production function ${name}`); sql(body);
  }
  sql(`create trigger interaction_guard before insert or update on public.agent_connection_activity for each row execute function private.guard_interaction_activity_arbitration_v1()`);
  sql(definition[0]);
  execFileSync(join(pgBin, 'psql'), [...pgArgs, '-f', resolve(serverRoot, 'supabase/migrations/730_harden_terminal_attempt_projection_release.sql')], { stdio: 'pipe' });
  if (fixed) execFileSync(join(pgBin, 'psql'), [...pgArgs, '-f', resolve(serverRoot, 'supabase/migrations/985_active_question_command_handoff.sql')], { stdio: 'pipe' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  mkdirSync(join(temp, 'agent/devspec'), { recursive: true, mode: 0o700 });
  writeFileSync(join(temp, 'agent/devspec/settings.json'), JSON.stringify({ autoBond: false, preemptOwner: preempt }));
  writeFileSync(session, JSON.stringify({ type: 'session', version: 3, id: native, cwd: temp, timestamp: now }) + '\n', { mode: 0o600 });
  const argv = ['pi', '--offline', '--session', session, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-builtin-tools',
    ...(background ? ['-e', process.env.PI_BACKGROUND_EXTENSION] : []),
    '-e', resolve(root, 'extensions/devspec-remote.ts'), '-e', resolve(root, 'scripts/active-question-delivery-fixture.ts'), '--provider', 'handoff-probe', '--model', 'scripted'];
  child = spawn('script', ['-q', '-f', '-e', '-c', argv.map(quote).join(' '), join(temp, 'terminal.typescript')], { detached: true, cwd: temp,
    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40', PI_CODING_AGENT_DIR: join(temp, 'agent'), TMPDIR: temp,
      DEVSPEC_MCP_TOKEN: 'fixture-only-not-real', DEVSPEC_MCP_URL: `http://127.0.0.1:${server.address().port}/api/mcp`, DEVSPEC_DEBUG_REMOTE: '1', HANDOFF_PROBE_ROOT: temp,
      HANDOFF_PROBE_BACKGROUND: background ? '1' : '0', HANDOFF_PROBE_IGNORE_ABORT: nonsettling ? '1' : '0', HANDOFF_PROBE_PERMANENT_STALL: permanentStall ? '1' : '0', PI_BG_FEATURES: 'process', PI_BG_DOCK_SHORTCUT: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  await until(() => existsSync(join(temp, 'tui-ready.json')), 'actual TUI startup');
  assert.equal(JSON.parse(readFileSync(join(temp, 'tui-ready.json'), 'utf8')).mode, 'tui');
  child.stdin.write(`/devspec.remote --session ${room}\r`);
  await until(() => calls.some(call => call.name === 'poll_connection'), 'TUI bond');
  enabled = true; wake();
  await until(() => existsSync(join(temp, 'question-started')) && acked, 'exact question applied and ACKed');
  const terminalJobs = () => new Set(entries().filter(row => row.customType === 'devspec-background-observation' && row.data.task.state === 'completed').map(row => row.data.task.id));
  const debugText = () => readFileSync(join(temp, 'devspec-remote-debug.log'), 'utf8');
  const abortCount = () => (debugText().match(/preempt: aborting exact question for validated command availability/g) ?? []).length;
  writeFileSync(join(temp, 'owner-release'), 'ready for the eventual owner response');
  const waitingAt = Date.now(); let releasedAt = null; ownerWaiting = true; wake();
  if (permanentStall) {
    await until(() => existsSync(join(temp, 'injected-permanent-stall')) && debugText().includes('command offer preempt settled=false'), 'constructed noncooperative fault', 15000);
    assert.equal(ownerEntries().length, 0);
    assert.equal(abortCount(), 1);
    assert.equal(calls.some(call => call.name === 'delivery_admission' && call.ready), false);
    assert.equal(sql('select count(*) from public.agent_command_deliveries'), '0');
    assert.equal(extensionTreeHash(), treeHashAtStart);
    const summary = { result: 'LIMIT_CONFIRMED', scope: 'general stuck-runtime recovery is NOT implemented by the bounded handoff fix',
      fault: 'tool deliberately never resolves after observing native abort', actualHost: 'Pi interactive TUI in PTY', hostVersion, pluginVersion,
      sourceHash: runtimeHashAtStart, ownerCopies: 0, aborts: 1, falseReadiness: false, liveServer: false, artifacts: temp };
    writeFileSync(join(temp, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
  } else {
  if (!fixed || !preempt) {
    for (let lap = 0; lap < 5; lap++) {
      const count = calls.filter(call => call.outcome === 'blocked_by_interaction').length;
      wake(); await until(() => calls.filter(call => call.outcome === 'blocked_by_interaction').length > count, 'owner input held while prior work runs');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (quietMs > 0) await new Promise(resolve => setTimeout(resolve, quietMs));
    assert.equal(ownerEntries().length, 0); assert.equal(ownerOffered, false); assert.equal(abortCount(), 0);
    assert.equal(sql('select count(*) from public.agent_command_deliveries'), '0');
    assert.equal(sql(`select phase from public.agent_connection_activity where attempt_id='${attempt}'`), 'working');
    releasedAt = Date.now(); writeFileSync(join(temp, 'question-release'), 'finish prior question work');
    if (!background) await until(() => calls.some(call => call.name === 'report_complete' && call.exactQuestion), 'question settles');
    if (!fixed) wake(); // the repair must wake itself at the native idle boundary
  } else if (nonsettling) {
    await until(() => debugText().includes('command offer preempt settled=false'), 'nonsettling abort honestly deferred', 15000);
    for (let lap = 0; lap < 3; lap++) { wake(); await new Promise(resolve => setTimeout(resolve, 150)); }
    assert.equal(ownerEntries().length, 0); assert.equal(abortCount(), 1);
    assert.equal(calls.some(call => call.name === 'delivery_admission' && call.ready), false, 'no false readiness after timeout');
    releasedAt = Date.now(); writeFileSync(join(temp, 'question-release'), 'original quiet tool finally completes');
  }
  await until(() => ownerEntries().length === 1, 'same owner command persisted without another input');
  await until(() => existsSync(join(temp, 'provider-metadata.jsonl')) && readFileSync(join(temp, 'provider-metadata.jsonl'), 'utf8').includes('"phase":"owner"'), 'owner handled');
  await until(() => entries().some(row => row.type === 'message' && row.message?.role === 'assistant' && row.message.stopReason === 'stop'
    && JSON.stringify(row.message.content).includes('PROBE-owner-finished')), 'actual owner answer finalized in native transcript');
  const ownerLatencyMs = Date.now() - waitingAt;
  const afterReleaseMs = releasedAt === null ? null : Date.now() - releasedAt;
  if (fixed) assert((afterReleaseMs ?? ownerLatencyMs) < 12000, 'one bounded native handoff cycle, no extra user wake');
  if (fixed && preempt) {
    assert.equal(abortCount(), 1);
    if (!nonsettling) assert.equal(existsSync(join(temp, 'question-release')), false, 'preemption must not wait for unrelated work to finish');
  }
  if (background) {
    await until(() => debugText().includes('pendingBg=2'), 'both owned jobs retained');
    const before = sql(`select started_at from public.agent_connection_activity where source_message_id='${IDS.command}' and phase='working'`);
    assert(before, 'real background work retains the new exact activity');
    writeFileSync(join(temp, 'bg-0-release'), 'release first');
    await until(() => terminalJobs().size === 1, 'first job terminal');
    assert.equal(sql(`select started_at from public.agent_connection_activity where source_message_id='${IDS.command}' and phase='working'`), before);
    writeFileSync(join(temp, 'bg-1-release'), 'release second');
    await until(() => terminalJobs().size === 2, 'second job terminal');
    await until(() => sql(`select phase from public.agent_connection_activity where source_message_id='${IDS.command}'`) === 'done', 'last job exact completion');
  }
  assert.equal(ownerEntries().length, 1);
  assert.equal(extensionTreeHash(), treeHashAtStart, 'Runtime files changed during the TUI run; rerun for valid source evidence');
  assert.equal(digest(resolve(root, 'scripts/active-question-delivery-fixture.ts')), fixtureHashAtStart, 'Provider fixture changed during the run');
  if (fixed) assert.equal(digest(resolve(serverRoot, 'supabase/migrations/985_active_question_command_handoff.sql')), migrationHashAtStart, 'SQL changed during the run');
  const summary = { result: fixed ? 'PASS' : 'REPRODUCED', boundary: fixed ? 'validated availability then exact native-ready handoff' : 'server delivery admission, before native preemption', actualHost: 'Pi interactive TUI in PTY',
    hostVersion, pluginVersion, pluginPath: runtimePath, sourceHash: runtimeHashAtStart, extensionTreeHash: treeHashAtStart, fixtureHash: fixtureHashAtStart,
    migrationHash: migrationHashAtStart,
    deliveryBodyMd5, preempt, nonsettling, background, quietMs, debugEnabled: true, ownerLatencyMs, afterReleaseMs, aborts: abortCount(), blockedPolls: calls.filter(call => call.outcome === 'blocked_by_interaction').length,
    ownerCopies: ownerEntries().length, liveServer: false, realPostgresDeliveryFunction: true, paidModelRequests: 0, artifacts: temp };
  writeFileSync(join(temp, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
  }
} catch (error) { console.error(JSON.stringify({ result: 'FAIL', error: String(error), artifacts: temp, calls: calls.slice(-12), failures }, null, 2)); process.exitCode = 1; }
finally {
  for (const index of [0, 1]) writeFileSync(join(temp, `bg-${index}-release`), 'cleanup');
  writeFileSync(join(temp, 'transport-metadata.json'), JSON.stringify(calls, null, 2));
  if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  if (permanentStall && existsSync(join(temp, 'tui-ready.json'))) {
    // Kill only this known test child, whose injected promise cannot settle.
    const pid = JSON.parse(readFileSync(join(temp, 'tui-ready.json'), 'utf8')).pid;
    try {
      if (Number.isSafeInteger(pid) && pid > 1 && readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(session)) process.kill(pid, 'SIGKILL');
    } catch { /* already exited */ }
  }
  for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (pgStarted) execFileSync(join(pgBin, 'pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
}
