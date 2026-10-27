import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyOverlay, disableNativeDuplicates, readConfig, saveConfig, configPaths, disableAdapterDuplicates, disableEffectiveNativeDuplicates } from "../extensions/core/mcp-config-guard.ts";
const endpoint="https://api.devspec.ai/api/mcp";
function fixture(t: TestContext) {
  const dir=mkdtempSync(join(tmpdir(),"pi1-mcp-config-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const native=join(dir,"mcp.json"), adapter=join(dir,"mcp-adapter.json");
  const put=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value));
  const get=(path:string)=>JSON.parse(readFileSync(path,"utf8"));
  return {dir,native,adapter,put,get};
}
test("mixed native and legacy config migrates only sparse overrides, preserves credentials and backs up",t=>{
  const f=fixture(t);
  const native={url:endpoint,headers:{Authorization:"fixture"},toolExposure:{other:"hidden"}};
  f.put(f.native,{autoEnableCodemode:false,mcpServers:{real:native,devspec:{disabled:true},foreign:{protocolVersion:"auto"}}});
  f.put(f.adapter,{settings:{scriptMode:false},mcpServers:{foreign:{url:"https://example.com/mcp"}}});
  assert.equal(migrateLegacyOverlay(f.native,f.adapter),true);
  assert.deepEqual(f.get(f.native),{autoEnableCodemode:false,mcpServers:{real:native}});
  assert.deepEqual(f.get(f.adapter),{settings:{scriptMode:false},mcpServers:{devspec:{disabled:true},foreign:{url:"https://example.com/mcp",protocolVersion:"auto"}}});
  assert.equal(readdirSync(f.dir).filter(n=>n.includes("devspec-backup")).length,1);
  assert.equal(migrateLegacyOverlay(f.native,f.adapter),false);
});
test("special server names are preserved as data, not object prototype setters",t=>{
  const f=fixture(t);
  f.put(f.native,{mcpServers:JSON.parse('{"__proto__":{"disabled":true},"constructor":{"disabled":true}}')});
  assert.equal(migrateLegacyOverlay(f.native,f.adapter),true);
  const servers=f.get(f.adapter).mcpServers;
  assert.equal(Object.hasOwn(servers,'__proto__'),true);
  assert.deepEqual(servers.__proto__,{disabled:true});
  assert.deepEqual(servers.constructor,{disabled:true});
});
test("conflicting or malformed destination never removes the original",t=>{
  const f=fixture(t); f.put(f.native,{mcpServers:{devspec:{disabled:true}}});
  const original=readFileSync(f.native,"utf8");
  for(const value of ['{"broken":',JSON.stringify({mcpServers:{devspec:{disabled:false}}})]) {
    writeFileSync(f.adapter,value);
    assert.throws(()=>migrateLegacyOverlay(f.native,f.adapter));
    assert.equal(readFileSync(f.native,"utf8"),original); assert.equal(readFileSync(f.adapter,"utf8"),value);
  }
});
test("native suppression changes only enabled and is idempotent; names do not identify DevSpec",t=>{
  const f=fixture(t);
  const own={url:endpoint,headers:{Authorization:"fixture"},exposure:"deferred"};
  const foreign={url:"https://example.com/mcp"};
  f.put(f.native,{mcpServers:{custom:own,devspec:foreign}});
  assert.equal(disableNativeDuplicates(f.native,endpoint).changed,true);
  assert.deepEqual(f.get(f.native).mcpServers,{custom:{...own,enabled:false},devspec:foreign});
  assert.equal(disableNativeDuplicates(f.native,endpoint).changed,false);
});
test("project foreign definition overrides same-name global DevSpec without being suppressed",t=>{
  const f=fixture(t);
  const global=join(f.dir,'global.json');
  f.put(global,{mcpServers:{same:{url:endpoint}}});
  f.put(f.native,{mcpServers:{same:{url:'https://foreign.example/mcp'}}});
  const result=disableEffectiveNativeDuplicates([global,f.native],endpoint);
  assert.deepEqual(result,{hits:[],changed:false});
  assert.equal(f.get(f.native).mcpServers.same.enabled,undefined);
  assert.equal(f.get(global).mcpServers.same.enabled,undefined);
});
test("unknown sparse settings are not guessed or discarded",t=>{
  const f=fixture(t); const config={mcpServers:{other:{somethingNew:true}}}; f.put(f.native,config);
  assert.equal(migrateLegacyOverlay(f.native,f.adapter),false); assert.deepEqual(f.get(f.native),config);
});
test("symlinked configs are not rewritten, including destinations",t=>{
  const f=fixture(t); const shared=join(f.dir,"shared.json"); f.put(shared,{mcpServers:{devspec:{url:endpoint}}});
  symlinkSync(shared,f.native); assert.throws(()=>disableNativeDuplicates(f.native,endpoint));
  assert.equal(f.get(shared).mcpServers.devspec.enabled,undefined);
});
test("concurrent changes are refused",t=>{
  const f=fixture(t); f.put(f.native,{}); const before=readConfig(f.native);
  f.put(f.native,{concurrent:true}); assert.throws(()=>saveConfig(before,{mcpServers:{}}));
  assert.deepEqual(f.get(f.native),{concurrent:true});
});
test("untrusted config paths exclude the project",()=>{
  assert.deepEqual(configPaths("/agent","/project",false),[{native:"/agent/mcp.json",adapter:"/agent/mcp-adapter.json"}]);
});
test("adapter owns effective discovery and receives the configured override path",()=>{
  const calls:unknown[]=[];
  let disabled = false;
  const result=disableAdapterDuplicates({
    loadMcpConfig:(override,cwd)=>{calls.push([override,cwd]);return {mcpServers:{imported:{url:endpoint,disabled},foreign:{url:"https://example.com/mcp"},off:{url:endpoint,disabled:true}}};},
    writeProjectServerDisabledOverride:(override,cwd,name,value)=>{calls.push([override,cwd,name,value]);disabled=value;return {path:"override",changed:true};},
  },"/cwd",endpoint,"custom.json");
  assert.equal(result.changed,true);
  assert.deepEqual(calls,[["custom.json","/cwd"],["custom.json","/cwd","imported",true],["custom.json","/cwd"]]);
});
