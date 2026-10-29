import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAdapter } from '../../src/engines/codex/adapter.js';
import { Config } from '../../src/domain/schemas.js';
import { loadRegistry, builtinDirectory } from '../../src/agents/registry.js';

test('adapter rejects unavailable authentication and malformed/failed runtime results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adapter-test-'));
  const binary = join(root, 'codex'); const cwd = join(root, 'project'); await mkdir(cwd);
  const agent = (await loadRegistry([builtinDirectory], Config.parse({ schemaVersion: 1 })))[0]!;
  const adapter = new CodexAdapter(join(root, 'data'), binary);
  const shim = async (body: string) => writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.160.1');process.exit(0);} ${body}\n`, { mode: 0o700 });
  const request = { runId: 'test', phase: 'implementation' as const, cwd, prompt: 'Fixture', agent, provider: { id: 'openai', kind: 'openai' as const, auth: 'login' as const }, schema: {}, signal: new AbortController().signal, timeoutMs: 2000 };
  try {
    await assert.rejects(adapter.preflight(request.provider), /Unable to launch/);
    await writeFile(binary, `#!${process.execPath}\nconsole.log('codex-cli unsupported');\n`, { mode: 0o700 });
    await assert.rejects(adapter.preflight(request.provider), /requires Codex CLI/);
    await shim('process.exit(1);'); await assert.rejects(adapter.preflight(request.provider), /Authenticate/);
    await shim(`if(process.argv.includes('login'))process.exit(0);console.log('not-json');`);
    await assert.rejects(adapter.execute(request, () => {}), /malformed JSONL/);
    await shim(`if(process.argv.includes('login'))process.exit(0);console.log(JSON.stringify({type:'turn.failed'}));`);
    await assert.rejects(adapter.execute(request, () => {}), /did not complete/);
    await shim(`if(process.argv.includes('login'))process.exit(0);console.log(JSON.stringify({type:'turn.completed'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'not-json'}}));`);
    await assert.rejects(adapter.execute(request, () => {}), /structured final output/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
