/** Actual disposable Pi RPC: question retirement and deferred-retry fairness.
 * node scripts/e2e-question-handoff.mjs [--retry-starvation] [--preempt-off]
 * Loopback MCP/scripted provider only; no live room, paid model or manual ACK.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { canonicalPoll } from '../tests/canonical-ingress-fixture.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fairness = process.argv.includes('--retry-starvation');
const preempt = !process.argv.includes('--preempt-off');
const temp = mkdtempSync(join(tmpdir(), 'pi-question-handoff-'));
mkdirSync(join(temp, 'agent/devspec'), { recursive: true, mode: 0o700 });
writeFileSync(join(temp, 'agent/devspec/settings.json'), JSON.stringify({ autoBond: false, preemptOwner: preempt }));
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const native = uid(1), conn = uid(2), room = uid(3), attachment = uid(4), attempt = uid(5);
const now = new Date().toISOString();
const identity = { connection_id: conn, agent_name: 'Pi', codename: 'Probe', label: 'Pi · Probe' };
const session = join(temp, 'session.jsonl');
writeFileSync(session, JSON.stringify({ type: 'session', version: 3, id: native, cwd: temp, timestamp: now })+'\n', { mode: 0o600 });
const event = { kind: 'devspec.interaction_event', version: 1, event_id: uid(6), response_id: uid(7), question_id: uid(8), origin_connection_id: conn, source_session_id: room, response_kind: 'text', answer: 'QUESTION-PROBE', answered_at: now, claim_token: uid(9), lease_expires_at: new Date(Date.now()+600000).toISOString() };
const calls = [], events = [], errors = [], streams = new Set();
let enable = false, offered = false, ownerWaiting = false, ownerOffered = false, acked = false, phase = 'startup', child;
const response = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const base = () => ({ connection_id: conn, session_id: room, attached_at: now, speech_attachment_id: attachment, changed: false, cursor_v2: null, dispatch_cursor: null, dispatches: [], system_notice_version: 2, system_notice_cursor: null, system_notices: [] });
const contract = { kind: 'devspec.product.remote_ingress_contract', schema_version: 1, contract_version: '1.5.0', policy: { policy_version: '2026-09-18.1' } };
function poll(args) {
  const result = { ...base(), ...(args.interaction_event_version === 1 ? { interaction_event_version: 1, interaction_events: [], question_dismissal_event_version: 1, question_dismissal_events: [] } : {}) };
  if (args.interaction_event_ack) { acked = true; return result; }
  if (ownerWaiting && !ownerOffered) {
    ownerOffered = true;
    const value = canonicalPoll({ body: 'FAIR-OWNER-PICKUP', connectionId: conn, addresseeLabel: identity.label, senderStyleNegotiated: args.sender_style_version === 1, context: { human_context: [], agent_context: [], ai_context: [], system_context: [] } });
    value.addressed_to = identity; value.ingress.connection = identity;
    for (const command of value.ingress.commands) command.addressee = identity;
    return { ...result, ...value };
  }
  if (enable && !offered && args.interaction_event_version === 1) { offered = true; result.interaction_events = [event]; }
  return result;
}
const server = createServer(async (req,res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(res); res.write('event: wake\ndata: {}\n\n'); res.on('close',()=>streams.delete(res)); return; }
  try {
    let body=''; for await (const b of req) body+=b;
    const rpc=JSON.parse(body); let result={};
    if (rpc.method==='initialize') result={ protocolVersion:'2025-03-26',serverInfo:{name:'handoff-probe',version:'1'},capabilities:{tools:{},resources:{}} };
    else if (rpc.method==='notifications/initialized') {res.writeHead(202);res.end();return;}
    else if (rpc.method==='resources/read') result={contents:[{uri:rpc.params.uri,mimeType:'application/json',text:JSON.stringify(contract)}]};
    else if (rpc.method==='tools/list') result={tools:[]};
    else if (rpc.method==='tools/call') {
      const {name,arguments:args={}}=rpc.params;
      calls.push({at:new Date().toISOString(),phase,name,busy:args.busy??null,progress:typeof args.progress_marker==='number'||typeof args.progress_marker==='string',exact:args.attempt_id===attempt,interactionStart:args.interaction_event_id===event.event_id && !args.speech_scope,ack:!!args.interaction_event_ack,reason:args.reason??null,postPhase:args.phase??null,sourceSpeech:!!args.assistant_source_id});
      if(name==='register_connection') result={...response({...base(),project_id:uid(10),codename:'Probe'}),_meta:{devspec:{connection_capability:{version:1,value:'dvsc_fixture_only_12345678901234567890'}}}};
      else if(name==='attach_connection') result=response(base());
      else if(name==='poll_connection') result=response(poll(args));
      else if(name==='report_pickup' && args.speech_scope) result=response({attempt_id:attempt,expected_session_id:room,expected_attached_at:now,expected_attachment_id:attachment});
      else if(name==='report_pickup') result=response(fairness ? {outcome:'blocked_by_activity'} : {outcome:'started',phase:'working',idempotent:false,attempt_id:attempt,source_session_id:room});
      else if(name==='get_session_transcript') result=response({session:{id:room,title:'Handoff probe'},messages:[]});
      else if(name==='post_session_message') result=response({connection_id:conn,session_id:room,phase:args.phase??'answer',turn_kind:args.turn_kind,assistant_source_id:args.assistant_source_id,message_id:uid(100+calls.length),delivery:{status:'stored',message_id:uid(100+calls.length)}});
      else result=response({success:true});
    }
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  } catch(e) {errors.push(String(e));res.writeHead(500);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${server.address().port}/api/mcp`;
const wake=()=>{for(const s of streams)s.write('event: wake\ndata: {}\n\n');};
const until=async(pred,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){if(pred())return;if(errors.length)throw Error(errors.join('; '));if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(`child exited at ${label}`);await new Promise(r=>setTimeout(r,25));}throw Error(`timeout: ${label}`);};
const send=(id,message,extra={})=>child.stdin.write(JSON.stringify({id,type:'prompt',message,...extra})+'\n');
const sourceHash=createHash('sha256').update(readFileSync(resolve(root,'extensions/devspec-remote.ts'))).digest('hex');
try {
  child=spawn('pi',['--mode','rpc','--offline','--session',session,'--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-builtin-tools','-e',resolve(root,'extensions/devspec-remote.ts'),'-e',resolve(root,'scripts/question-handoff-runtime-fixture.ts'),'--provider','handoff-probe','--model','scripted'],{cwd:temp,env:{...process.env,PI_CODING_AGENT_DIR:join(temp,'agent'),TMPDIR:temp,DEVSPEC_MCP_TOKEN:'fixture-only-not-real',DEVSPEC_MCP_URL:endpoint,DEVSPEC_DEBUG_REMOTE:'1',HANDOFF_PROBE_ROOT:temp,HANDOFF_PROBE_FAIRNESS:fairness?'1':'0'},stdio:['pipe','pipe','pipe']});
  let pending='';const decoder=new StringDecoder('utf8');
  child.stdout.on('data',b=>{pending+=decoder.write(b);let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const e=JSON.parse(line);events.push({at:new Date().toISOString(),type:e.type,id:e.id,success:e.success,role:e.message?.role,customType:e.message?.customType,stopReason:e.message?.stopReason,toolName:e.toolName});if(e.type==='extension_error')errors.push(String(e.error));}catch{errors.push('non-JSON stdout');}}});
  child.stderr.on('data',b=>{const text=String(b);if(!text.includes('ExperimentalWarning')&&!text.includes('trace-warnings'))errors.push(text.slice(0,500));});
  send('bond',`/devspec.remote --session ${room}`);
  await until(()=>events.some(e=>e.id==='bond'&&e.success),'bond');
  await until(()=>calls.some(c=>c.name==='poll_connection'),'first poll');
  phase='question';enable=true;wake();
  if (fairness) {
    await until(()=>calls.some(c=>c.name==='report_pickup'&&c.interactionStart),'first deferred exact start');
    phase='owner';ownerWaiting=true;wake();
    await until(()=>events.some(e=>e.type==='agent_settled'),'owner delivered despite deferred question',5000);
    assert.equal(events.filter(e=>e.type==='agent_start').length,1);
    assert.equal(ownerOffered,true);
    const nativeRows=readFileSync(session,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.equal(nativeRows.filter(row=>row.type==='message'&&row.message?.role==='user'&&JSON.stringify(row.message.content).includes('FAIR-OWNER-PICKUP')).length,1);
    assert.equal(acked,false,'a blocked question was never applied or ACKed');
    assert.equal(events.some(e=>e.customType==='devspec-directed-question-answer'),false);
    assert.equal(calls.filter(c=>c.sourceSpeech).length,1);
  } else {
    await until(()=>existsSync(join(temp,'question-started'))&&acked,'exact question applied and ACKed');
    send('local','LOCAL-FOLLOWUP',{streamingBehavior:'steer'});
    await until(()=>events.some(e=>e.id==='local'&&e.success),'local queued');
    phase='handoff';writeFileSync(join(temp,'question-release'),'release');
    await until(()=>existsSync(join(temp,'owner-started')),'local user reached real provider');
    phase='owner'; const start=calls.length; wake();
    await until(()=>calls.slice(start).some(c=>c.name==='poll_connection'),'owner poll');
    assert(calls.some(c=>c.name==='report_complete'&&c.exact),'prior exact continuation completes at the boundary');
    assert(calls.slice(start).filter(c=>c.name==='poll_connection').every(c=>c.busy===true&&c.progress),'normal Working fields must be present during new user work');
    phase='settle';writeFileSync(join(temp,'owner-release'),'release');
    await until(()=>events.some(e=>e.type==='agent_settled'),'settled');
    phase='after-settle';send('next','LOCAL-FOLLOWUP next independent turn');
    await until(()=>events.filter(e=>e.type==='agent_settled').length>=2,'new run settled');
    await until(()=>calls.some(c=>c.phase==='after-settle'&&c.name==='heartbeat_connection'&&c.busy===true),'normal presence on later run');
    assert.equal(calls.filter(c=>c.phase==='after-settle'&&c.name==='report_keepalive'&&c.exact).length,0);
    assert.equal(calls.filter(c=>c.sourceSpeech).length,4,'all actual speech remains on its one source-identified writer');
  }
  assert.deepEqual(errors,[]);
  const summary={result:'PASS',scenario:fairness?'retry_fairness':'question_retirement',hostVersion:execFileSync('pi',['--version'],{encoding:'utf8'}).trim(),pluginVersion:JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version,sourceHash,preempt,debugEnabled:true,liveServer:false,paidModels:0,artifacts:temp};
  writeFileSync(join(temp,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
} catch(e) {console.error(JSON.stringify({result:'FAIL',error:String(e),artifacts:temp,lastCalls:calls.slice(-15),lastEvents:events.slice(-15),errors},null,2));process.exitCode=1;}
finally {
  writeFileSync(join(temp,'transport-metadata.json'),JSON.stringify(calls,null,2));writeFileSync(join(temp,'host-metadata.json'),JSON.stringify(events,null,2));
  if(child&&child.exitCode===null&&child.signalCode===null){child.stdin.end();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}
  for(const s of streams)s.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));
}
