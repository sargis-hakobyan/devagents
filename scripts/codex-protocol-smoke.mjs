import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../dist/engines/codex/adapter.js';
import { loadRegistry, builtinDirectory } from '../dist/agents/registry.js';
import { Config } from '../dist/domain/schemas.js';

// Real pinned Codex runtime, deterministic loopback model responses, no paid credentials.
const root = await mkdtemp(join(tmpdir(), 'devagents-protocol-'));
const project = join(root, 'project');
let calls = []; let requests = []; let index = 0; const progress = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { res.writeHead(400); res.end('{}'); return; }
  requests.push(body);
  const input = calls[index++];
  const item = input ? { id: `call_${index}`, call_id: `call_${index}`, type: 'custom_tool_call', name: 'exec', namespace: 'functions', input } : {
    id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Protocol fixture completed' }), annotations: [] }],
  };
  const response = { id: `resp_${index}`, object: 'response', created_at: 1, status: 'completed', model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const wrapper = join(root, 'codex-fixture');
  // Production does not accept a custom endpoint. Only this test wrapper supplies it.
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" != "exec" ]; then exec codex "$@"; fi\nshift\nexec codex exec -c 'model_provider="fixture"' -c 'model_providers.fixture={name="Fixture",base_url="${endpoint}",wire_api="responses",requires_openai_auth=false,supports_websockets=false}' -c 'features.enable_request_compression=false' "$@"\n`, { mode: 0o700 });
  await mkdir(project); await mkdir(join(project, '.git'));
  await writeFile(join(project, '.env'), 'fake-project-secret');
  const secret = join(root, 'outside-secret'); await writeFile(secret, 'fake-service-secret');
  const agents = await loadRegistry([builtinDirectory], Config.parse({ schemaVersion: 1 }));
  process.env.DEVAGENTS_PROTOCOL_KEY = 'fixture-only-not-a-real-key';
  const engine = new CodexAdapter(join(root, 'data'), wrapper);
  const base = { cwd: project, prompt: 'Complete the isolated protocol fixture.', provider: { id: 'openai', kind: 'openai', auth: 'api-key', apiKeyEnv: 'DEVAGENTS_PROTOCOL_KEY' }, schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }, signal: new AbortController().signal, timeoutMs: 30000 };
  const patch = text => `text(await tools.apply_patch(${JSON.stringify(text)}));`;
  const code = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.throws(()=>fs.readFileSync(${JSON.stringify(secret)}));assert.throws(()=>fs.readFileSync('.env'));try{fs.writeFileSync(${JSON.stringify(secret)},'bad');}catch{}assert.throws(()=>fs.writeFileSync('.git/config','bad'));assert.equal(process.env.CODEX_API_KEY,undefined);const socket=require('node:net').connect({host:'127.0.0.1',port:${server.address().port}});socket.once('connect',()=>{throw new Error('Tool network escape');});socket.once('error',()=>fs.writeFileSync('result.txt','verified\\n'));socket.setTimeout(3000,()=>{socket.destroy();fs.writeFileSync('result.txt','verified\\n');});`;
  const command = `${JSON.stringify(process.execPath)} -e '${code.replaceAll("'", "'\\''")}'`;
  calls = [
    `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:1000,yield_time_ms:10000}));`,
    patch('*** Begin Patch\n*** Update File: result.txt\n@@\n-verified\n+patched\n*** End Patch'),
    patch(`*** Begin Patch\n*** Update File: ${secret}\n@@\n-fake-service-secret\n+bad\n*** End Patch`),
  ];
  const result = await engine.execute({ ...base, runId: 'implementation', phase: 'implementation', agent: agents.find(a => a.id === 'general-developer') }, event => progress.push(event));
  assert.equal(result.output.summary, 'Protocol fixture completed');
  assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'patched\n');
  assert.equal(await readFile(secret, 'utf8'), 'fake-service-secret');
  const offeredNames = () => requests[0].input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools).flatMap(namespace => namespace.tools.flatMap(tool => [tool.name, ...[...tool.description.matchAll(/### `([^`]+)`/g)].map(match => match[1])]));
  assert.ok(offeredNames().includes('exec_command')); assert.doesNotMatch(offeredNames().join(','), /spawn_agent|web_search|mcp__|image_gen/);
  index = 0; requests = []; calls = [patch('*** Begin Patch\n*** Update File: result.txt\n@@\n-patched\n+bad\n*** End Patch')];
  await engine.execute({ ...base, runId: 'review', phase: 'review', agent: agents.find(a => a.id === 'code-reviewer') }, event => progress.push(event));
  assert.equal(await readFile(join(project, 'result.txt'), 'utf8'), 'patched\n');
  assert.doesNotMatch(offeredNames().join(','), /exec_command|spawn_agent/);
  console.log('PASS: real Codex JSONL/structured output, scoped shell and patch execution, outside/secret/Git denials, blocked command networking, no delegated/network tools, and read-only review.');
} catch (error) {
  console.error('Runtime fixture diagnostics:', JSON.stringify(progress).slice(-12000));
  throw error;
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
