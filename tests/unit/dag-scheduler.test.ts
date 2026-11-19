import test from 'node:test';
import assert from 'node:assert/strict';
import { readyItems, AgentSlots } from '../../src/orchestration/dag-scheduler.js';
import { covers, scopeAgent } from '../../src/domain/ownership.js';
import { Agent } from '../../src/domain/schemas.js';

test('scheduler respects dependencies, global capacity and per-agent capacity', () => {
  const nodes = [
    { id: 'a', dependsOn: [], agentId: 'dev', agentConcurrency: 1 },
    { id: 'b', dependsOn: [], agentId: 'dev', agentConcurrency: 1 },
    { id: 'c', dependsOn: [], agentId: 'qa', agentConcurrency: 1 },
    { id: 'd', dependsOn: ['a', 'b'], agentId: 'dev', agentConcurrency: 1 },
  ];
  assert.deepEqual(readyItems(nodes, new Set(), 2).map(n => n.id), ['a', 'c']);
  assert.deepEqual(readyItems(nodes, new Set(['a', 'c']), 2).map(n => n.id), ['b']);
  assert.deepEqual(readyItems(nodes, new Set(['a', 'b', 'c']), 2).map(n => n.id), ['d']);
  assert.deepEqual(readyItems(nodes, new Set(), 1).map(n => n.id), ['a']);
  assert.throws(() => readyItems([{ ...nodes[0]!, dependsOn: ['missing'] }], new Set(), 2), /schedulable/);
});
test('rolling selection counts running items and their agents without blocking independent free slots', () => {
  const nodes = [
    { id: 'slow', dependsOn: [], agentId: 'one', agentConcurrency: 1 },
    { id: 'same-agent', dependsOn: [], agentId: 'one', agentConcurrency: 1 },
    { id: 'fast', dependsOn: [], agentId: 'two', agentConcurrency: 1 },
    { id: 'dependent', dependsOn: ['fast'], agentId: 'two', agentConcurrency: 1 },
  ];
  assert.deepEqual(readyItems(nodes, new Set(['fast']), 2, new Set(['slow'])).map(n => n.id), ['dependent']);
  assert.deepEqual(readyItems(nodes, new Set(), 2, new Set(['slow', 'fast'])), []);
  assert.deepEqual(readyItems(nodes, new Set(), 2, new Set(['slow'])).map(n => n.id), ['fast']);
  assert.deepEqual(readyItems(nodes, new Set(['fast']), 1, new Set(['slow'])), []);
});
test('agent-slot queue cancels without acquiring a slot or blocking later calls', async () => {
  const slots = new AgentSlots(); const controller = new AbortController(); let release!: () => void;
  const first = slots.run('reviewer', 1, new AbortController().signal, () => new Promise<void>(r => { release = r; }));
  const second = slots.run('reviewer', 1, controller.signal, async () => { throw new Error('Must not run'); });
  controller.abort(); await assert.rejects(second, /cancelled/); release(); await first;
  assert.equal(await slots.run('reviewer', 1, new AbortController().signal, async () => 42), 42);
});
test('ownership can narrow exact/subtree grants but cannot expand or use unsupported globs', () => {
  assert.equal(covers('project:/src/**', 'project:/src/a.ts'), true);
  assert.equal(covers('project:/src/a.ts', 'project:/src/**'), false);
  assert.equal(covers('project:/src/**', 'project:/src-other/a.ts'), false);
  const agent = { ...Agent.parse({ schemaVersion: 1, id: 'dev', name: 'Dev', description: 'Dev', capabilities: ['implementation'], instructionsFile: 'dev.md', delegation: { canReceiveTasks: true, canDelegate: false }, permissions: { writePaths: ['project:/src/**'] } }), instructions: '', source: 'test' };
  assert.deepEqual(scopeAgent(agent, ['project:/src/a.ts']).permissions.writePaths, ['project:/src/a.ts']);
  assert.throws(() => scopeAgent(agent, ['project:/**']), /exceed/);
  assert.throws(() => scopeAgent(agent, ['project:/src/*.ts']), /exact paths/);
});
