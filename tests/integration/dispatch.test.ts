import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, validPlan } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';

test('dispatch survives reopening and duplicate submissions retain one queue request', async () => {
  const f = await fixture(); const second = new Store(join(f.dataDir, 'test.db'));
  try {
    const input = { projectId: 'fixture', request: 'Queued work' };
    const task = f.service.submit(input, 'queued');
    assert.equal(f.service.submit(input, 'queued').id, task.id);
    f.store.requestDispatch(task.id); f.store.requestDispatch(task.id);
    assert.equal(second.dispatch(task.id)!.requested, 1);
    const claim = second.claimDispatch('second')!;
    assert.equal(claim.taskId, task.id);
    assert.equal(f.store.claimDispatch('first'), undefined);
    second.finishDispatch(claim);
    assert.equal(f.store.claimDispatch('first'), undefined);
  } finally { second.close(); await f.cleanup(); }
});

test('an approval requested during a claim remains pending after that claim finishes', async () => {
  const f = await fixture();
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Approval', mode: 'plan-approval' }, 'approval');
    const claim = f.store.claimDispatch('worker')!;
    const planned = await f.service.proposePlan(task.id, validPlan());
    f.service.approve(task.id, planned.version);
    f.store.finishDispatch(claim);
    const continuation = f.store.claimDispatch('worker')!;
    assert.equal(continuation.taskId, task.id);
    assert.ok(continuation.sequence > claim.sequence);
    assert.ok(continuation.generation > claim.generation);
    assert.throws(() => f.store.finishDispatch(claim), /ownership/);
    f.store.finishDispatch(continuation);
    assert.deepEqual(f.store.pendingDispatches(), []);
  } finally { await f.cleanup(); }
});

test('submission failure rolls back the task, idempotency identity and queue together', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.store.createTask({ projectId: 'fixture', request: 'Atomic' }, 'atomic', () => { throw new Error('Snapshot failed'); }), /Snapshot failed/);
    assert.deepEqual(f.store.tasks(), []);
    assert.deepEqual(f.store.pendingDispatches(), []);
    const task = f.service.submit({ projectId: 'fixture', request: 'Atomic' }, 'atomic');
    assert.deepEqual(f.store.pendingDispatches(), [task.id]);
  } finally { await f.cleanup(); }
});
