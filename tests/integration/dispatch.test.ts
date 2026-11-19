import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, validPlan } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';

test('dispatch survives reopening and duplicate submissions retain one queue request', async () => {
  const f = await fixture(); const second = await Store.open(join(f.dataDir, 'test.db'));
  try {
    const input = { projectId: 'fixture', request: 'Queued work' };
    const task = await f.service.submit(input, 'queued');
    assert.equal((await f.service.submit(input, 'queued')).id, task.id);
    await f.store.requestDispatch(task.id); await f.store.requestDispatch(task.id);
    assert.equal((await second.dispatch(task.id))!.requested, 1);
    const claim = (await second.claimDispatch('second'))!;
    assert.equal(claim.taskId, task.id);
    assert.equal(await f.store.claimDispatch('first'), undefined);
    await second.finishDispatch(claim);
    assert.equal(await f.store.claimDispatch('first'), undefined);
  } finally { await second.close(); await f.cleanup(); }
});

test('an approval requested during a claim remains pending after that claim finishes', async () => {
  const f = await fixture();
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Approval', mode: 'plan-approval' }, 'approval');
    const claim = (await f.store.claimDispatch('worker'))!;
    const planned = await f.service.proposePlan(task.id, validPlan());
    await f.service.approve(task.id, planned.version);
    await f.store.finishDispatch(claim);
    const continuation = (await f.store.claimDispatch('worker'))!;
    assert.equal(continuation.taskId, task.id);
    assert.ok(continuation.sequence > claim.sequence);
    assert.ok(continuation.generation > claim.generation);
    await assert.rejects(async () => await f.store.finishDispatch(claim), /ownership/);
    await f.store.finishDispatch(continuation);
    assert.deepEqual(await f.store.pendingDispatches(), []);
  } finally { await f.cleanup(); }
});

test('submission failure rolls back the task, idempotency identity and queue together', async () => {
  const f = await fixture();
  try {
    await assert.rejects(async () => await f.store.createTask({ projectId: 'fixture', request: 'Atomic' }, 'atomic', () => { throw new Error('Snapshot failed'); }), /Snapshot failed/);
    assert.deepEqual(await f.store.tasks(), []);
    assert.deepEqual(await f.store.pendingDispatches(), []);
    const task = await f.service.submit({ projectId: 'fixture', request: 'Atomic' }, 'atomic');
    assert.deepEqual(await f.store.pendingDispatches(), [task.id]);
  } finally { await f.cleanup(); }
});

test('stale generations and cross-task callbacks cannot write task state or accepted evidence', async () => {
  const f = await fixture();
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Owned task' }, 'owned');
    const other = await f.service.submit({ projectId: 'fixture', request: 'Other task' }, 'other');
    const old = (await f.store.claimDispatch('first'))!;
    let resume!: () => void; const paused = new Promise<void>(r => { resume = r; });
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const late = f.store.withDispatch(old, async () => {
      entered(); await paused; await f.store.record(task.id, 'late', {});
    });
    const rejection = assert.rejects(late, /no longer owns/);
    await running;
    await f.store.recoverDispatch(task.id);
    const current = (await f.store.claimDispatch('second'))!;
    resume(); await rejection;
    await assert.rejects(async () => await f.store.withDispatch(old, async () => await f.store.checkpoint(task.id, task.version, {}, 'stale')), /no longer owns/);
    await f.store.withDispatch(current, async () => {
      await assert.rejects(async () => await f.store.record(other.id, 'wrong-task', {}), /identity/);
      await f.store.record(task.id, 'accepted', {});
    });
    assert.deepEqual((await f.store.evidence(task.id)).map(e => e.kind), ['accepted']);
    assert.equal((await f.store.evidence(other.id)).length, 0);
    await f.store.finishDispatch(current);
  } finally { await f.cleanup(); }
});

test('startup recovers queued work and claims without effects but quarantines interrupted execution', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const queued = await f.service.submit({ projectId: 'fixture', request: 'Never started', mode: 'autonomous' }, 'never-started');
  const old = (await f.store.claimDispatch('dead-service'))!; assert.equal(old.taskId, queued.id);
  const interrupted = await f.service.submit({ projectId: 'fixture', request: 'Interrupted', mode: 'autonomous' }, 'interrupted');
  await f.store.record(interrupted.id, 'worktree-intent', { owner: interrupted.id });
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), undefined, { startPaused: true }); f.service.attachRunner(runner);
  try {
    await runner.recover(); await runner.idle();
    assert.equal((await f.store.task(queued.id)).state, 'completed');
    assert.equal((await f.store.evidence(queued.id)).filter(e => e.kind === 'commit-created').length, 1);
    assert.equal((await f.store.task(interrupted.id)).state, 'failed');
    assert.match((await f.store.dispatch(interrupted.id))!.blocker!, /termination is unverified/);
    assert.equal(engine.calls.some(c => c.cwd.endsWith(interrupted.id)), false);
    await assert.rejects(f.service.compactionPreview(interrupted.id), /prior workers/);
    await assert.rejects(async () => await f.service.run(interrupted.id), /interrupted execution/);
    for (let i = 0; i < 20; i++) await runner.enqueue(queued.id);
    await runner.idle();
    assert.equal((await f.store.evidence(queued.id)).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('failed startup reconciliation cannot release queued work into execution', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const queued = await f.service.submit({ projectId: 'fixture', request: 'Retain queued work', mode: 'autonomous' }, 'recovery-failure');
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), undefined, { startPaused: true }); f.service.attachRunner(runner);
  runner.workflows.state = async () => { throw new Error('Fixture workflow storage unavailable'); };
  try {
    await assert.rejects(runner.recover(), /storage unavailable/); await runner.idle();
    assert.ok(runner.executionFailure); assert.equal(engine.calls.length, 0);
    assert.deepEqual(await f.store.pendingDispatches(), [queued.id]);
    assert.equal((await f.store.dispatch(queued.id))!.owner, null);
    await assert.rejects(async () => await runner.enqueue(queued.id), /Execution halted/);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('startup admission keeps compute queued until credentials are ready while mode waits still persist', async () => {
  const f = await fixture(); const engine = new FakeEngine(); let ready = false;
  const runner = new TaskRunner(f.service, engine, new FixtureValidator(), undefined, { admission: () => ready ? undefined : 'Waiting for vault unlock' });
  f.service.attachRunner(runner);
  try {
    const compute = await f.service.submit({ projectId: 'fixture', request: 'Queued until ready', mode: 'autonomous' }, 'compute');
    const waiting = await f.service.submit({ projectId: 'fixture', request: 'Choose mode' }, 'mode');
    await runner.idle();
    assert.equal(engine.calls.length, 0); assert.equal((await f.store.dispatch(compute.id))!.owner, null);
    assert.equal((await runner.workflows.state(waiting.id))?.status, 'suspended');
    assert.equal((await runner.taskScheduling(compute.id)).reason, 'Waiting for vault unlock');
    ready = true; await runner.enqueue(compute.id); await runner.idle();
    assert.equal((await f.store.task(compute.id)).state, 'completed');
    assert.equal((await f.store.evidence(compute.id)).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});
