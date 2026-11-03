import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers.js';
import { createApi } from '../../src/api/server.js';
import { taskExecution, type Execution, type ExecutionEvent } from '../../src/domain/execution.js';

test('execution endpoint keeps real attempts, concurrent actors and scoped repair findings beyond log pagination', async () => {
  const f = await fixture(); const server = createApi(f.service, 'synthetic-execution-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Execution fixture', mode: 'autonomous' }, 'execution');
    const record = (kind: string, data: object) => f.store.record(task.id, kind, data);
    const start = (runId: string, phase: string, agentId: string, workItemId: string) => record('run-started', { runId, phase, agentId, workItemId });
    const end = (runId: string, output: object = {}) => record('run-completed', { runId, output });
    start('front', 'implementation', 'frontend', 'frontend'); start('back', 'implementation', 'backend', 'backend');
    end('back', { summary: 'Backend written' }); end('front', { summary: 'Frontend written' });
    for (let i = 0; i < 1005; i++) record('progress', { runId: 'front', kind: 'output', data: { text: 'not-in-execution' } });
    start('review', 'review', 'reviewer', 'backend');
    end('review', { summary: 'Please fix login', approved: false, findings: ['Persist SSO login time', '<img src=x onerror=alert(1)> fixture-secret-value'], extra: 'x'.repeat(30000) });
    start('unrelated', 'implementation', 'frontend', 'frontend'); end('unrelated');
    start('repair', 'implementation', 'backend', 'backend'); end('repair', { summary: 'Recorded SSO login' });
    record('validation', { workItemId: 'backend', executable: 'node', args: ['--test'], exitCode: 0, output: 'not-in-execution' });
    start('review2', 'review', 'reviewer', 'backend'); end('review2', { summary: 'Verified', approved: true, findings: [] });
    record('validation', { workItemId: '@integration', executable: 'node', args: ['--test'], exitCode: 0, truncated: true });
    start('interrupted', 'implementation', 'backend', '@integration');
    f.service.cancel(task.id);
    assert.equal((await fetch(`${origin}/tasks/${task.id}/execution`)).status, 401);
    const response = await fetch(`${origin}/tasks/${task.id}/execution`, { headers: { authorization: 'Bearer synthetic-execution-token' } });
    assert.equal(response.status, 200); const body = await response.text(); const result = JSON.parse(body) as Execution;
    assert.ok(!body.includes('not-in-execution')); assert.ok(!body.includes('fixture-secret-value')); assert.ok(body.length < 12000);
    const entries = result.entries;
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
