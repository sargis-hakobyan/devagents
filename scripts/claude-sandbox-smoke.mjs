// Offline fixture: mock inference, real MCP tools and OS sandbox. Never sends a model request.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeAdapter } from '../dist/engines/claude/adapter.js';
import { loadRegistry, builtinDirectory } from '../dist/agents/registry.js';
import { Config } from '../dist/domain/schemas.js';
import { engineHealth } from '../dist/engines/health.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const root=await mkdtemp('/tmp/claude-fixture-'); const cwd=join(root,'project');const data=join(root,'data');await mkdir(cwd);await mkdir(data);await writeFile(join(cwd,'hello.txt'),'hello');await writeFile(join(root,'escape'),'outside-sentinel');
delete process.env.DEVAGENTS_CREDENTIAL_RUNTIME;
process.env.ANTHROPIC_API_KEY='synthetic-claude-container-key';
let phase='implementation';
const adapter=new ClaudeAdapter(data,{query: async function*({options}) {
  const server=options.mcpServers.devagents; const [ct,st]=InMemoryTransport.createLinkedPair(); const client=new Client({name:'fixture',version:'1'});await server.instance.connect(st);await client.connect(ct);
  try {
    const read=await client.callTool({name:'workspace',arguments:{action:'read',path:'hello.txt'}});assert.match(JSON.stringify(read),/hello/);assert.notEqual(read.isError,true,JSON.stringify(read));
    const write=await client.callTool({name:'workspace',arguments:{action:'write',path:'test.txt',content:'fixture'}});assert.equal(Boolean(write.isError),phase==='review',JSON.stringify(write));
    const outside=await client.callTool({name:'command',arguments:{executable:'node',args:['-e',`require('fs').writeFileSync(${JSON.stringify(join(root,'escape'))},'bad')`]}});assert.equal(await readFile(join(root,'escape'),'utf8'),'outside-sentinel');
    const credential=await client.callTool({name:'command',arguments:{executable:'node',args:['-e',"console.log(process.env.ANTHROPIC_API_KEY || 'absent')"]}});assert.match(JSON.stringify(credential),/absent/);
  } catch(error) {console.error('Offline fixture assertion:',error);throw error;} finally {await client.close();await server.instance.close();}
  yield {type:'result',subtype:'success',is_error:false,structured_output:{summary:'fixture'},usage:{input_tokens:10,output_tokens:5}};
}});
try {
 const health=await engineHealth(data);assert.equal(health.engines.find(e=>e.id==='claude-code').installed,true);
 const agent=(await loadRegistry([builtinDirectory],Config.parse({schemaVersion:1}))).find(a=>a.id==='general-developer');
 const request={runId:'fixture',phase:'implementation',cwd,agent,provider:{id:'anthropic',kind:'anthropic',auth:'login'},prompt:'Fixture',schema:{type:'object'},signal:new AbortController().signal,timeoutMs:30000};
 await adapter.execute(request,()=>{});assert.equal(await readFile(join(cwd,'test.txt'),'utf8'),'fixture');
 phase='review';await adapter.execute({...request,runId:'review',phase},()=>{});assert.equal(await readFile(join(root,'escape'),'utf8'),'outside-sentinel');
 console.log('Claude runtime and sandbox fixture passed; no model request made.');
} finally {await rm(root,{recursive:true,force:true});}
