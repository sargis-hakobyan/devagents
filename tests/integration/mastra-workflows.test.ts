import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';

test('Mastra persists mode and plan approval across runtime recreation without replanning or duplicate commits', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  let runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const input = { projectId: 'fixture', request: 'Durable greeting' };
    const task = f.service.submit(input, 'durable'); await runner.idle();
    assert.equal((await runner.workflows.state(task.id))?.status, 'suspended');
    assert.equal(engine.calls.length, 0);
    await runner.stop();
    runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    assert.equal((await runner.workflows.state(task.id))?.status, 'suspended');
    f.service.mode(task.id, 'plan-approval'); await runner.idle();
    const pending = f.store.task(task.id);
    assert.equal(pending.state, 'awaiting_plan_approval');
    const approval = (await runner.workflows.state(task.id))?.steps?.approval;
    assert.ok(approval && !Array.isArray(approval)); assert.equal(approval.status, 'suspended');
    assert.equal(engine.calls.length, 1);
    await runner.stop();
    runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    f.store.recover(); await runner.recover(); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'awaiting_plan_approval');
    assert.throws(() => f.service.approve(task.id, pending.version - 1), /Task changed/);
    assert.equal(f.service.submit(input, 'durable').id, task.id);
    f.service.approve(task.id, pending.version);
    runner.enqueue(task.id); runner.enqueue(task.id); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed');
    const state = await runner.workflows.state(task.id);
    assert.equal(state?.status, 'success');
    assert.deepEqual(Object.keys(state!.steps!).filter(k => !k.startsWith('input')), ['mode', 'prepare-worktree', 'plan', 'approval', 'prepare-environment', 'execute-plan']);
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'review']);
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'commit-created').length, 1);
    assert.equal(JSON.stringify(state).includes('Durable greeting'), false, 'request text must not be duplicated into workflow snapshots');
  } finally { await runner.stop(); await f.cleanup(); }
});

test('approval arriving before workflow suspension is persisted is not lost', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  const propose = f.service.proposePlan.bind(f.service);
  f.service.proposePlan = async (...args) => {
    const pending = await propose(...args);
    f.service.approve(pending.id, pending.version);
    return pending;
  };
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Fast approval', mode: 'plan-approval' }, 'fast');
    await runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed');
    assert.equal(engine.calls.filter(c => c.phase === 'planning').length, 1);
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('cancelled persisted approval is cancelled in Mastra without executing the plan', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  let runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Cancel approval', mode: 'plan-approval' }, 'cancel-wait');
    await runner.idle(); await runner.stop();
    runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    f.service.cancel(task.id); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'cancelled');
    assert.equal((await runner.workflows.state(task.id))?.status, 'canceled');
    assert.equal(engine.calls.length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('a workflow persistence failure during a mode wait is recorded without an unhandled worker rejection', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  runner.workflows.run = async () => { throw new Error('Workflow storage unavailable'); };
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Mode wait' }, 'storage-failure');
    await runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed');
    assert.match(f.store.task(task.id).outcome!.error!, /Workflow storage unavailable/);
    assert.equal(engine.calls.length, 0);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('Mastra snapshots redact engine errors and never retry a failed side-effecting step', async () => {
  const f = await fixture(); const engine = new FakeEngine(); let calls = 0;
  engine.execute = async () => { calls++; throw new Error('Provider failed: fixture-secret-value'); };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Failure', mode: 'autonomous' }, 'error');
    await runner.idle();
    assert.equal(calls, 1);
    assert.match(f.store.task(task.id).outcome!.error!, /Provider failed: \[REDACTED\]/);
    const state = await runner.workflows.state(task.id);
    assert.equal(state?.status, 'failed');
    assert.equal(JSON.stringify(state).includes('fixture-secret-value'), false);
    await runner.stop();
    assert.equal((await readFile(join(f.dataDir, 'workflows.db'))).includes(Buffer.from('fixture-secret-value')), false);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('legacy approved tasks without a Mastra snapshot execute without generating a new plan', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  // Persist a plan with the production planner, then remove only its framework DB to simulate
  // upgrading an installation whose domain task predates the Mastra runtime.
  let runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Legacy approval', mode: 'plan-approval' }, 'legacy');
    await runner.idle(); const pending = f.store.task(task.id); await runner.stop();
    const { rm } = await import('node:fs/promises');
    await rm(join(f.dataDir, 'workflows.db'));
    runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    await runner.recover(); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'awaiting_plan_approval');
    assert.equal((await runner.workflows.state(task.id))?.status, 'suspended');
    f.service.approve(task.id, pending.version); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'completed');
    assert.equal(engine.calls.filter(c => c.phase === 'planning').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('an abrupt process death preserves workflow evidence without replaying implementation after recovery', async () => {
  const f = await fixture();
  const task = f.service.submit({ projectId: 'fixture', request: 'Interrupted task', mode: 'autonomous' }, 'crash-workflow');
  const child = fork('tests/fixtures/workflow-crash.ts', [f.dataDir, task.id], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let runner: TaskRunner | undefined;
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(30000) });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal(f.store.task(task.id).state, 'running');
    assert.deepEqual(f.store.recover(), [task.id]);
    const engine = new FakeEngine(); runner = new TaskRunner(f.service, engine, new FixtureValidator());
    f.service.attachRunner(runner); await runner.recover(); await runner.idle();
    assert.equal(f.store.task(task.id).state, 'failed');
    assert.equal((await runner.workflows.state(task.id))?.status, 'canceled');
    assert.equal(engine.calls.length, 0);
    assert.equal(f.store.evidence(task.id).some(e => e.kind === 'commit-created'), false);
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'workflow-started').length, 1);
    assert.ok(f.store.evidence(task.id).some(e => e.kind === 'workflow-reconciled'), 'interrupted child workflows must also be reconciled');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await runner?.stop(); await f.cleanup();
  }
});
