import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

test('adapter sends model input with code intact while removing environment and provider secret values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adapter-redact-'));
  const binary = join(root, 'codex'); const cwd = join(root, 'project'); const capture = join(root, 'stdin.txt'); await mkdir(cwd);
  const agent = (await loadRegistry([builtinDirectory], Config.parse({ schemaVersion: 1 }))).find(a => a.id === 'general-developer')!;
  const adapter = new CodexAdapter(join(root, 'data'), binary);
  const previous = { ...process.env };
  process.env.DEVAGENTS_TEST_SECRET_TOKEN = 'fixture-environment-secret-value';
  process.env.DEVAGENTS_TEST_PROVIDER_KEY = 'fixture-provider-key-value';
  await writeFile(binary, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.160.1'); process.exit(0); }
if (process.argv.includes('login')) process.exit(0);
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(capture)}, input);
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ summary: 'done' }) } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
});
`, { mode: 0o700 });
  const code = 'const token: string = req.headers.authorization;\n  password: string;\n  apiKey = process.env.KEY;\nexport const secret = loadSecret();';
  const prompt = `Review this diff:\n${code}\nenv leak: fixture-environment-secret-value provider leak: fixture-provider-key-value sk-proj-abcdefghijklmnop`;
  try {
    const result = await adapter.execute({ runId: 'redact', phase: 'review', cwd, prompt, agent, provider: { id: 'openai', kind: 'openai', auth: 'api-key', apiKeyEnv: 'DEVAGENTS_TEST_PROVIDER_KEY' }, schema: {}, signal: new AbortController().signal, timeoutMs: 5000 }, () => {});
    assert.deepEqual(result.output, { summary: 'done' });
    const sent = await readFile(capture, 'utf8');
    assert.ok(sent.includes(code), 'code identifiers must reach the model unchanged');
    assert.doesNotMatch(sent, /fixture-environment-secret-value|fixture-provider-key-value|sk-proj-/);
    assert.match(sent, /env leak: \[REDACTED\] provider leak: \[REDACTED\] \[REDACTED\]/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    await rm(root, { recursive: true, force: true });
  }
});
