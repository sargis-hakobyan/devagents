import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers.js';
import { createApi } from '../../src/api/server.js';
import { taskExecution, type Execution, type ExecutionEvent } from '../../src/domain/execution.js';

test('execution endpoint keeps real attempts, concurrent actors and scoped repair findings beyond log pagination', async () => {
  const f = await fixture(); const server = await createApi(f.service, 'synthetic-execution-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Execution fixture', mode: 'autonomous' }, 'execution');
    const record = async (kind: string, data: object) => await f.store.record(task.id, kind, data);
    const start = async (runId: string, phase: string, agentId: string, workItemId: string) => await record('run-started', { runId, phase, agentId, workItemId, engine: agentId === 'frontend' ? 'codex' : 'claude-code' });
    const end = async (runId: string, output: object = {}) => await record('run-completed', { runId, output });
    await start('front', 'implementation', 'frontend', 'frontend'); await start('back', 'implementation', 'backend', 'backend');
    await end('back', { summary: 'Backend written' }); await end('front', { summary: 'Frontend written' });
    for (let i = 0; i < 1005; i++) await record('progress', { runId: 'front', kind: 'output', data: { text: 'not-in-execution' } });
    await start('review', 'review', 'reviewer', 'backend');
    await end('review', { summary: 'Please fix login', approved: false, findings: ['Persist SSO login time', '<img src=x onerror=alert(1)> fixture-secret-value'], extra: 'x'.repeat(30000) });
    await start('unrelated', 'implementation', 'frontend', 'frontend'); await end('unrelated');
    await start('repair', 'implementation', 'backend', 'backend'); await end('repair', { summary: 'Recorded SSO login' });
    await record('validation', { workItemId: 'backend', executable: 'node', args: ['--test'], exitCode: 0, output: 'not-in-execution' });
    await start('review2', 'review', 'reviewer', 'backend'); await end('review2', { summary: 'Verified', approved: true, findings: [] });
    await record('validation', { workItemId: '@integration', executable: 'node', args: ['--test'], exitCode: 0, truncated: true });
    await start('interrupted', 'implementation', 'backend', '@integration');
    await f.service.cancel(task.id);
    assert.equal((await fetch(`${origin}/tasks/${task.id}/execution`)).status, 401);
    const response = await fetch(`${origin}/tasks/${task.id}/execution`, { headers: { authorization: 'Bearer synthetic-execution-token' } });
    assert.equal(response.status, 200); const body = await response.text(); const result = JSON.parse(body) as Execution;
    assert.ok(!body.includes('not-in-execution')); assert.ok(!body.includes('fixture-secret-value')); assert.ok(body.length < 12000);
    const entries = result.entries;
    assert.equal(entries[0]!.engine, 'codex');
    assert.equal(entries[1]!.engine, 'claude-code');
    assert.equal(entries.find(e => e.kind === 'validation')!.engine, undefined);
    assert.deepEqual(entries.filter(e => e.kind === 'agent').map(e => e.id), ['run-front', 'run-back', 'run-review', 'run-unrelated', 'run-repair', 'run-review2', 'run-interrupted']);
    assert.deepEqual(entries[0]!.parallelWith, ['run-back']);
    assert.equal(entries[2]!.status, 'changes-requested');
    assert.equal(entries[3]!.follows.length, 0); // a frontend retry cannot claim to fix a backend review
    assert.equal(entries[4]!.attempt, 2); assert.equal(entries[4]!.follows[0]!.id, 'run-review');
    assert.match(entries[4]!.follows[0]!.reason, /SSO/);
    assert.equal(entries.at(-3)!.status, 'approved');
    assert.equal(entries.at(-2)!.status, 'failed');
    assert.match(entries.at(-1)!.follows[0]!.reason, /output truncated/);
    assert.equal(entries.at(-1)!.status, 'interrupted'); assert.equal(entries.at(-1)!.finishedAt, null);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('validation recovery clears only the recovered command; QA findings and real actor names survive', () => {
  const events: ExecutionEvent[] = []; const add = (kind: string, data: Record<string, unknown>) => events.push({ sequence: events.length + 1, at: '2026-11-03T10:00:00Z', kind, data });
  const validation = (executable: string, exitCode: number) => add('validation', { executable, args: [], exitCode, workItemId: '@integration' });
  validation('tests', 1); validation('types', 2); validation('tests', 0);
  add('run-started', { runId: 'fix', phase: 'implementation', agentId: 'backend', workItemId: '@integration' });
  add('run-completed', { runId: 'fix', summary: 'Fixed types' });
  add('run-started', { runId: 'qa', phase: 'qa', agentId: 'qa' });
  add('run-completed', { runId: 'qa', summary: 'Checked' });
  add('qa-result', { state: 'failed', feedback: 'Keyboard navigation fails' });
  add('run-started', { runId: 'fix-qa', phase: 'implementation', agentId: 'frontend' });
  add('run-failed', { runId: 'fix-qa', error: 'Worker stopped' });
  const result = taskExecution({ state: 'failed', updatedAt: '2026-11-03T10:01:00Z', agents: [{ id: 'backend', name: 'Backend Developer' }] }, events);
  assert.equal(result.entries[3]!.actor, 'Backend Developer');
  assert.equal(result.entries[3]!.follows.length, 1); assert.match(result.entries[3]!.follows[0]!.reason, /types/);
  assert.equal(result.entries[4]!.status, 'changes-requested'); assert.equal(result.entries[5]!.follows[0]!.id, 'run-qa');
  assert.equal(result.entries[5]!.status, 'failed');
  assert.deepEqual(taskExecution({ state: 'planning', updatedAt: '' }, []).entries, []);
});


test('execution engine prefers the recorded run, falls back to the frozen roster and never guesses a missing engine', () => {
  const events: ExecutionEvent[] = ['recorded', 'snapshot', 'missing'].map((id, i) => ({
    sequence: i + 1, at: '2026-11-04T10:00:00Z', kind: 'run-started',
    data: { runId: id, agentId: id, phase: 'implementation', ...(id === 'recorded' ? { engine: 'claude-code' } : {}) },
  }));
  const result = taskExecution({ state: 'running', updatedAt: '', team: { members: [
    { id: 'recorded', name: 'Recorded', engine: 'codex' }, { id: 'snapshot', name: 'Snapshot', engine: 'codex' },
  ] } }, events);
  assert.deepEqual(result.entries.map(e => e.engine), ['claude-code', 'codex', undefined]);
});
