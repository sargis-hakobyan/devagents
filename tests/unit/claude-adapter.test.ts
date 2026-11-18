import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter, claudeUsage, type ClaudeQuery } from '../../src/engines/claude/adapter.js';
import { Config } from '../../src/domain/schemas.js';
import { builtinDirectory, loadRegistry } from '../../src/agents/registry.js';

const result = (overrides: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: { summary: 'fixture' }, usage: { input_tokens: 10, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, output_tokens: 5 }, ...overrides }) as SDKMessage;
test('Claude tools are sandboxed, credentials stay out of tool environments, and reviews cannot write', { skip: !process.env.DEVAGENTS_TEST_CODEX_BINARY }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-test-')); const cwd = join(root, 'project'); const data = join(root, 'data');
  await mkdir(cwd); await mkdir(data); await writeFile(join(cwd, 'hello.txt'), 'hello'); await writeFile(join(root, 'escaped'), 'outside-sentinel');
  const oldKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-secret';
  const agent = (await loadRegistry([builtinDirectory], Config.parse({ schemaVersion: 1 }))).find(a => a.id === 'general-developer')!;
  let phase = 'implementation';
  const fakeQuery: ClaudeQuery = async function* ({ options, prompt }) {
    assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []); assert.equal(options.permissionMode, 'dontAsk');
    assert.equal(options.strictMcpConfig, true); assert.equal(options.env!.ANTHROPIC_API_KEY, 'fixture-anthropic-secret');
    assert.notEqual(options.cwd, cwd); assert.equal(options.model, 'fixture-claude-model'); assert.equal(options.effort, 'medium');
    for await (const message of prompt) assert.equal(message.type, 'user');
    const server = options.mcpServers!.devagents!; assert.equal(server.type, 'sdk'); if (server.type !== 'sdk') throw Error();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'fixture', version: '1' });
    await server.instance.connect(serverTransport); await client.connect(clientTransport);
    try {
      const read = await client.callTool({ name: 'workspace', arguments: { action: 'read', path: 'hello.txt' } });
      assert.match(JSON.stringify(read), /hello/); assert.notEqual(read.isError, true);
      const denied = await client.callTool({ name: 'workspace', arguments: { action: 'read', path: '../outside' } }); assert.equal(denied.isError, true);
      const write = await client.callTool({ name: 'workspace', arguments: { action: 'write', path: 'new.txt', content: 'new' } });
      assert.equal(Boolean(write.isError), phase === 'review');
      const command = await client.callTool({ name: 'command', arguments: { executable: process.execPath, args: ['-e', "console.log(process.env.ANTHROPIC_API_KEY || 'absent')"] } });
      assert.match(JSON.stringify(command), /absent/); assert.doesNotMatch(JSON.stringify(command), /fixture-anthropic-secret/);
      const outside = await client.callTool({ name: 'command', arguments: { executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(root, 'escaped'))},'bad')`] } });
      assert.equal(await readFile(join(root, 'escaped'), 'utf8'), 'outside-sentinel');
    } finally { await client.close(); await server.instance.close(); }
    yield result();
  };
  const adapter = new ClaudeAdapter(data, { query: fakeQuery, sandboxBinary: process.env.DEVAGENTS_TEST_CODEX_BINARY! });
  const request = { runId: 'fixture', phase: 'implementation' as const, cwd, agent: { ...agent, model: 'fixture-claude-model' }, provider: { id: 'anthropic', kind: 'anthropic' as const, auth: 'login' as const }, prompt: 'Fixture', schema: { type: 'object' }, signal: new AbortController().signal, timeoutMs: 30000 };
  try {
    const first = await adapter.execute(request, () => {}); assert.deepEqual(first.usage, { input_tokens: 20, cached_input_tokens: 7, output_tokens: 5 });
    assert.equal(await readFile(join(cwd, 'new.txt'), 'utf8'), 'new');
    phase = 'review'; await adapter.execute({ ...request, runId: 'review', phase: 'review' }, () => {});
    assert.ok(agent.permissions.writePaths.length, 'review must not mutate the member permissions');
    assert.equal(await readFile(join(root, 'escaped'), 'utf8'), 'outside-sentinel');
    const failed = new ClaudeAdapter(data, { sandboxBinary: process.env.DEVAGENTS_TEST_CODEX_BINARY!, query: async function* () { yield result({ subtype: 'error_max_turns', errors: ['Fixture limit'] }); } });
    await assert.rejects(failed.execute(request, () => {}), { code: 'engine_failed' });
    const secretFailure = new ClaudeAdapter(data, { sandboxBinary: process.env.DEVAGENTS_TEST_CODEX_BINARY!, query: async function* () { throw new Error('Authentication failed: fixture-anthropic-secret'); } });
    await assert.rejects(secretFailure.execute(request, () => {}), e => e instanceof Error && /Authentication failed/.test(e.message) && !e.message.includes('fixture-anthropic-secret'));
    const abort = new AbortController(); abort.abort(); await assert.rejects(adapter.execute({ ...request, signal: abort.signal }, () => {}), { code: 'cancelled' });
  } finally { if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey; await rm(root, { recursive: true, force: true }); }
});
test('Claude usage includes cache creation and cache reads without counting output twice', () => {
  assert.deepEqual(claudeUsage({ input_tokens: 10, output_tokens: 3 }), { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 });
});
