import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWithSetup } from '../../src/orchestration/validate.js';
import { taskExecution } from '../../src/domain/execution.js';

test('timeout records partial evidence with start identity and never enters repair', async () => {
  const events: string[] = []; let identity = '';
  await assert.rejects(validateWithSetup({
    commands: [{ executable: 'npm', args: ['test'] }], rules: false, digest: async () => 'same',
    started: (_, id) => { identity = id; events.push('start'); },
    execute: async command => { events.push('execute'); return { ...command, exitCode: 124, timedOut: true, output: 'one test passed' }; },
    record: result => { assert.equal(result.validationId, identity); assert.equal(result.output, 'one test passed'); events.push('result'); },
    recover: async () => { assert.fail('timeout must not trigger setup'); },
  }), /Validation timed out: npm test/);
  assert.deepEqual(events, ['start', 'execute', 'result']);
});
test('validation start and result form one timed execution entry; unfinished commands are interrupted', () => {
  const start = { sequence: 1, kind: 'validation-started', at: '2026-01-01T00:00:00Z', data: { validationId: 'one', executable: 'npm', args: ['test'], timeoutMs: 600000 } };
  const facts = { state: 'validating', updatedAt: start.at };
  const active = taskExecution(facts, [start]).entries[0]!;
  assert.equal(active.status, 'running'); assert.equal(active.summary, 'npm test'); assert.equal(active.timeoutMs, 600000);
  const done = taskExecution(facts, [start, { sequence: 2, kind: 'validation', at: '2026-01-01T00:00:02Z', data: { ...start.data, exitCode: 124, timedOut: true } }]).entries;
  assert.equal(done.length, 1); assert.equal(done[0]!.startedAt, start.at); assert.equal(done[0]!.status, 'failed');
  assert.match(done[0]!.findings[0]!, /timed out/);
  assert.equal(taskExecution({ ...facts, state: 'failed' }, [start]).entries[0]!.status, 'interrupted');
});
test('launch errors close the same validation identity before propagating', async () => {
  let startedId = ''; let failedId = '';
  await assert.rejects(validateWithSetup({
    commands: [{ executable: 'npm', args: ['test'] }], rules: false, digest: async () => 'same',
    started: (_, id) => { startedId = id; },
    execute: async () => { throw new Error('cancelled'); },
    failed: (_, id, error) => { failedId = id; assert.equal(error, 'cancelled'); },
    record: () => assert.fail('no fabricated result'),
    recover: async () => assert.fail('no recovery'),
  }), /cancelled/);
  assert.ok(startedId); assert.equal(startedId, failedId);
});
