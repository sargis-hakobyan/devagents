import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, validPlan } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';

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

test('stale generations and cross-task callbacks cannot write task state or accepted evidence', async () => {
  const f = await fixture();
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Owned task' }, 'owned');
    const other = f.service.submit({ projectId: 'fixture', request: 'Other task' }, 'other');
    const old = f.store.claimDispatch('first')!;
    let resume!: () => void; const paused = new Promise<void>(r => { resume = r; });
    const late = f.store.withDispatch(old, async () => { await paused; f.store.record(task.id, 'late', {}); });
    f.store.recoverDispatch(task.id);
    const current = f.store.claimDispatch('second')!;
    const rejection = assert.rejects(late, /no longer owns/); resume(); await rejection;
    assert.throws(() => f.store.withDispatch(old, () => f.store.checkpoint(task.id, task.version, {}, 'stale')), /no longer owns/);
    f.store.withDispatch(current, () => {
      assert.throws(() => f.store.record(other.id, 'wrong-task', {}), /identity/);
      f.store.record(task.id, 'accepted', {});
    });
    assert.deepEqual(f.store.evidence(task.id).map(e => e.kind), ['accepted']);
    assert.equal(f.store.evidence(other.id).length, 0);
    f.store.finishDispatch(current);
  } finally { await f.cleanup(); }
});

test('startup recovers queued work and claims without effects but quarantines interrupted execution', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const queued = f.service.submit({ projectId: 'fixture', request: 'Never started', mode: 'autonomous' }, 'never-started');
  const old = f.store.claimDispatch('dead-service')!; assert.equal(old.taskId, queued.id);
  const interrupted = f.service.submit({ projectId: 'fixture', request: 'Interrupted', mode: 'autonomous' }, 'interrupted');
  f.store.record(interrupted.id, 'worktree-intent', { owner: interrupted.id });
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), undefined, { startPaused: true }); f.service.attachRunner(runner);
  try {
    await runner.recover(); await runner.idle();
    assert.equal(f.store.task(queued.id).state, 'completed');
    assert.equal(f.store.evidence(queued.id).filter(e => e.kind === 'commit-created').length, 1);
    assert.equal(f.store.task(interrupted.id).state, 'failed');
    assert.match(f.store.dispatch(interrupted.id)!.blocker!, /termination is unverified/);
    assert.equal(engine.calls.some(c => c.cwd.endsWith(interrupted.id)), false);
    await assert.rejects(f.service.compactionPreview(interrupted.id), /prior workers/);
    assert.throws(() => f.service.run(interrupted.id), /interrupted execution/);
    for (let i = 0; i < 20; i++) runner.enqueue(queued.id);
    await runner.idle();
    assert.equal(f.store.evidence(queued.id).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('failed startup reconciliation cannot release queued work into execution', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const queued = f.service.submit({ projectId: 'fixture', request: 'Retain queued work', mode: 'autonomous' }, 'recovery-failure');
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), undefined, { startPaused: true }); f.service.attachRunner(runner);
  runner.workflows.state = async () => { throw new Error('Fixture workflow storage unavailable'); };
  try {
    await assert.rejects(runner.recover(), /storage unavailable/); await runner.idle();
    assert.ok(runner.executionFailure); assert.equal(engine.calls.length, 0);
    assert.deepEqual(f.store.pendingDispatches(), [queued.id]);
    assert.equal(f.store.dispatch(queued.id)!.owner, null);
    assert.throws(() => runner.enqueue(queued.id), /Execution halted/);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('startup admission keeps compute queued until credentials are ready while mode waits still persist', async () => {
  const f = await fixture(); const engine = new FakeEngine(); let ready = false;
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), undefined, { admission: () => ready ? undefined : 'Waiting for vault unlock' });
  f.service.attachRunner(runner);
  try {
    const compute = f.service.submit({ projectId: 'fixture', request: 'Queued until ready', mode: 'autonomous' }, 'compute');
    const waiting = f.service.submit({ projectId: 'fixture', request: 'Choose mode' }, 'mode');
    await runner.idle();
    assert.equal(engine.calls.length, 0); assert.equal(f.store.dispatch(compute.id)!.owner, null);
    assert.equal((await runner.workflows.state(waiting.id))?.status, 'suspended');
    assert.equal(runner.taskScheduling(compute.id).reason, 'Waiting for vault unlock');
    ready = true; runner.enqueue(compute.id); await runner.idle();
    assert.equal(f.store.task(compute.id).state, 'completed');
    assert.equal(f.store.evidence(compute.id).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});
