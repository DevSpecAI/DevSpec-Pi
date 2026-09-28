/** Actual installed Pi TUI/RPC + loopback MCP. No LLM requests or live records. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'pi-project-runtime-'));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const A = { id:id(1), name:'Agency Website', organization:{id:id(11),name:'Agency Org'} };
const B = { id:id(2), name:'Client Website', organization:{id:id(12),name:'Client Org'} };
const projects=[A,B], connections=new Map(), calls=[], streams=new Set();
const result = data => ({content:[{type:'text',text:JSON.stringify(data)}]});
const server=createServer(async(req,res)=>{
 if(req.method==='GET' && req.url.startsWith('/api/mcp/connection-stream')) {res.writeHead(200,{'Content-Type':'text/event-stream'});streams.add(res);res.write('event: wake\ndata: {}\n\n');res.on('close',()=>streams.delete(res));return;}
 if(req.method!=='POST'){res.writeHead(405);res.end();return;}
 try {
  let body='';for await(const chunk of req)body+=chunk;const rpc=JSON.parse(body);let out={};
  if(rpc.method==='initialize')out={protocolVersion:'2025-03-26',serverInfo:{name:'project-choice-probe',version:'1'},capabilities:{tools:{},resources:{}}};
  else if(rpc.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
  else if(rpc.method==='tools/list')out={tools:[]};
  else if(rpc.method==='resources/read')out={contents:[]};
  else if(rpc.method==='tools/call'){
   const {name,arguments:args={}}=rpc.params;calls.push({name,args});
   if(name==='list_projects')out=result({projects});
   else if(name==='register_connection'){
    const old=connections.get(args.local_id);
    const project=projects.find(p=>p.id===(old?.project.id ?? args.project_id ?? args.pinned_project_id));
    if(!project){const detail={code:'project_choice_required',error:'Choose a project',project_selection:{version:1,status:'choice_required',reason:'ambiguous_remote',candidates:projects}};out={...result(detail),structuredContent:detail,isError:true};}
    else {assert(!args.project_id||args.project_id===project.id,'wrong conversation override');const conn=old??{id:id(100+connections.size),project};connections.set(args.local_id,conn);out={...result({connection_id:conn.id,project_id:project.id,session_id:null,codename:'Project Probe',project_selection:{version:1,status:'resolved',source:old?'conversation':args.project_id?'explicit':'folder_pin',project}}),_meta:{devspec:{connection_capability:{version:1,value:'dvsc_fixture_only_12345678901234567890'}}}};}
   } else if(name==='poll_connection'){
    await new Promise(r=>setTimeout(r,80));out=result({connection_id:args.connection_id,session_id:null,changed:false,dispatches:[],dispatch_cursor:null,cursor_v2:null,system_notice_version:1,system_notice_cursor:null,system_notices:[],interaction_event_version:1,interaction_events:[],question_dismissal_event_version:1,question_dismissal_events:[]});
   } else if(name==='get_project_summary'){assert(projects.some(p=>p.id===args.project_id),'ordinary calls must have selected scope');out=result({project_id:args.project_id});}
   else out=result({success:true});
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:out}));
 }catch(error){console.error(error);res.writeHead(500);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 const env={...process.env,PROJECT_PROBE_ROOT:root,PROJECT_PROBE_TEMP:temp,PROJECT_PROBE_ENDPOINT:`http://127.0.0.1:${server.address().port}/api/mcp`,PROJECT_PROBE_A:A.id,PROJECT_PROBE_B:B.id};
 const child=spawn('python3',[join(root,'scripts/project-choice-pty.py')],{env,stdio:'inherit'});
 const code=await new Promise(r=>child.once('exit',r));assert.equal(code,0,'actual host UI probe');
 assert(!existsSync(join(temp,'unexpected-model')),'must not call a model');
 assert(calls.filter(c=>c.name==='register_connection').length>=4);
 const summaries=calls.filter(c=>c.name==='get_project_summary').map(c=>c.args.project_id);
 assert(summaries.includes(A.id)&&summaries.includes(B.id));
 console.log(JSON.stringify({result:'PASS',host:'installed Pi TUI and RPC',transport:'loopback fixture, not deployed E2E',...JSON.parse(readFileSync(join(temp,'evidence.json'),'utf8')),paidModelRequests:0,connections:connections.size,scopedReadCalls:summaries.length}));
} finally {for(const s of streams)s.end();await new Promise(r=>server.close(r));rmSync(temp,{recursive:true,force:true});}
