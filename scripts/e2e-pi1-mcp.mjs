/** Real Pi 1.x host + loopback MCP. No model requests, real credentials or user config.
 * node scripts/e2e-pi1-mcp.mjs
 * PI_MCP_ADAPTER_ENTRY=/path/to/pi-mcp-adapter/index.ts node scripts/e2e-pi1-mcp.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
const root=process.env.DEVSPEC_PI_TEST_ROOT ?? resolve(fileURLToPath(new URL('..',import.meta.url)));
const scenario=process.argv[2];
if(!scenario) {
  for(const name of ['fresh','claude-first','native','legacy','untrusted',...(process.env.PI_MCP_ADAPTER_ENTRY?['adapter']:[])]) {
    const result=spawnSync(process.execPath,[fileURLToPath(import.meta.url),name],{stdio:'inherit',env:process.env,timeout:60000});
    assert.equal(result.status,0,`${name}: ${result.error??'failed'}`);
  }
  if(!process.env.PI_MCP_ADAPTER_ENTRY) console.log('Adapter host scenario not run: set PI_MCP_ADAPTER_ENTRY to an installed adapter 4.x.');
  process.exit(0);
}
const temp=mkdtempSync(join(tmpdir(),'devspec-pi1-host-'));
const home=join(temp,'home'),cwd=join(temp,'project'),agentDir=join(home,'agent');
for(const dir of [home,cwd,agentDir,join(cwd,'.pi')]) mkdirSync(dir,{recursive:true});
process.env.HOME=home;process.env.USERPROFILE=home;process.env.PI_CODING_AGENT_DIR=agentDir;
delete process.env.DEVSPEC_MCP_TOKEN;delete process.env.DEVSPEC_ENV;
process.chdir(cwd);
const requests=[];
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let text=''; for await(const chunk of req)text+=chunk;
  const message=JSON.parse(text);requests.push({path:req.url,method:message.method});
  if(message.id===undefined){res.writeHead(202).end();return;}
  const result=message.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
    message.method==='tools/list'?{tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object',properties:{}}}]}:
    message.method==='tools/call'?{content:[{type:'text',text:'fixture-ok'}]}:{};
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
process.env.DEVSPEC_MCP_URL=origin+'/devspec';
const own={url:origin+'/devspec',exposure:'direct'},foreign={url:origin+'/foreign',exposure:'direct'};
const shared=JSON.stringify({mcpServers:{devspec:{...own,directTools:true},foreign:{...foreign,directTools:true}}});
writeFileSync(join(cwd,'.mcp.json'),shared);
if(['native','untrusted'].includes(scenario))writeFileSync(join(cwd,'.pi/mcp.json'),JSON.stringify({mcpServers:{devspec:own,foreign}}));
if(scenario==='legacy')writeFileSync(join(cwd,'.pi/mcp.json'),JSON.stringify({mcpServers:{devspec:{disabled:true},foreign:{protocolVersion:'auto'}}}));
if(scenario==='adapter') writeFileSync(join(agentDir,'mcp-adapter.json'),JSON.stringify({settings:{projectServers:'allow'}}));
let session;
try {
  const {createAgentSession,DefaultResourceLoader,SettingsManager,SessionManager,createMcpExtension,createToolSearchExtension,createCodemodeExtension,VERSION}=await import('@earendil-works/pi-coding-agent');
  assert.match(VERSION,/^1\./);
  const settings=SettingsManager.inMemory(process.env.DEVSPEC_PI_TEST_ROOT ? {packages:[root]} : {});settings.setProjectTrusted(scenario!=='untrusted');
  // Adapter first intentionally exercises upgrade ordering. No imports from its internals.
  const paths=[...(scenario==='adapter'?[process.env.PI_MCP_ADAPTER_ENTRY]:[]),...(process.env.DEVSPEC_PI_TEST_ROOT?[]:[join(root,'extensions/devspec-adapter-guard.ts')])];
  let hostApi;
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noSkills:true,noPromptTemplates:true,noThemes:true,
    additionalExtensionPaths:paths,extensionFactories:[
      {name:'mcp',builtin:true,replaceable:true,factory:createMcpExtension()},
      {name:'tool-search',builtin:true,replaceable:true,factory:createToolSearchExtension()},
      {name:'codemode',builtin:true,replaceable:true,factory:createCodemodeExtension()},
      (pi)=>{hostApi=pi;pi.registerCommand('fixture-ready',{description:'No-model fixture',handler:async()=>{}});},
    ]});
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors,[]);
  ({session}=await createAgentSession({cwd,agentDir,settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.inMemory()}));
  const errors=[];await session.bindExtensions({mode:'rpc',onError:e=>errors.push(e)});
  await session.prompt('/fixture-ready'); // commands do not call a model
  assert.deepEqual(errors,[]);
  if(process.env.DEVSPEC_PI_TEST_ROOT) assert.ok(session.getAllTools().some(t=>t.name==='get_action_item'),'Packaged native DevSpec tools must load');
  assert.equal(readFileSync(join(cwd,'.mcp.json'),'utf8'),shared);
  if(scenario==='native'){
    const deadline=Date.now()+10000;
    while(!session.getAllTools().some(t=>t.name==='mcp__foreign__echo')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
    assert.ok(session.getAllTools().some(t=>t.name==='mcp__foreign__echo'), JSON.stringify({tools:session.getAllTools().map(t=>t.name), requests, trusted:settings.isProjectTrusted(), errors, config:JSON.parse(readFileSync(join(cwd,'.pi/mcp.json')))}));
    assert.ok(!session.getAllTools().some(t=>t.name==='mcp__devspec__echo'));
    assert.equal(requests.filter(r=>r.path==='/devspec').length,0,'duplicate must not connect');
    assert.equal(JSON.parse(readFileSync(join(cwd,'.pi/mcp.json'))).mcpServers.devspec.enabled,false);
  }
  if(['fresh','claude-first'].includes(scenario)) {
    assert.equal(existsSync(join(cwd,'.pi/mcp.json')),false);
    assert.equal(existsSync(join(cwd,'.pi/mcp-adapter.json')),false);
    assert.equal(requests.length,0);
  }
  if(scenario==='untrusted') {
    assert.equal(JSON.parse(readFileSync(join(cwd,'.pi/mcp.json'))).mcpServers.devspec.enabled,undefined);
    assert.equal(requests.length,0);
  }
  if(scenario==='legacy') {
    assert.deepEqual(JSON.parse(readFileSync(join(cwd,'.pi/mcp.json'))),{mcpServers:{}});
    assert.equal(JSON.parse(readFileSync(join(cwd,'.pi/mcp-adapter.json'))).mcpServers.devspec.disabled,true);
  }
  if(scenario==='adapter') {
    assert.equal(JSON.parse(readFileSync(join(cwd,'.pi/mcp-adapter.json'))).mcpServers.devspec.disabled,true);
    let decision; hostApi.events.emit('pi-mcp-adapter:tool-approval-request',{serverName:'devspec',claim(fn){decision=fn();return true;}});
    assert.equal(decision,'deny');
    const request={version:1,tool:'echo',server:'foreign',args:{}};
    hostApi.events.emit('pi-mcp-adapter:runtime-tool-call:v1',request);
    const result=await request.result;
    assert.ok(result?.ok,JSON.stringify(result));
    assert.ok(requests.some(r=>r.path==='/foreign'&&r.method==='tools/call'));
    const denied={version:1,tool:'echo',server:'devspec',args:{}};
    hostApi.events.emit('pi-mcp-adapter:runtime-tool-call:v1',denied);
    await denied.result;
    assert.equal(requests.filter(r=>r.path==='/devspec'&&r.method==='tools/call').length,0);
  }
  console.log(`PASS Pi ${VERSION}: ${scenario}; shared bytes preserved; no model calls`);
} finally {
  session?.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(temp,{recursive:true,force:true});
}
process.exit(0);
