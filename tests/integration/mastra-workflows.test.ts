import test from 'node:test';
import assert from 'node:assert/strict';
import { PgSession } from '../../src/persistence/pg-session.js';
import { WorkspaceManager } from '../../src/workspace/git.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fixture, validPlan } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';

test('Mastra persists mode and plan approval across runtime recreation without replanning or duplicate commits', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  let runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const input = { projectId: 'fixture', request: 'Durable greeting' };
    const task = await f.service.submit(input, 'durable'); await runner.idle();
    assert.equal((await runner.workflows.state(task.id))?.status, 'suspended');
    assert.equal(engine.calls.length, 0);
    await runner.stop();
    runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    assert.equal((await runner.workflows.state(task.id))?.status, 'suspended');
    await f.service.mode(task.id, 'plan-approval'); await runner.idle();
    const pending = await f.store.task(task.id);
    assert.equal(pending.state, 'awaiting_plan_approval');
    const approval = (await runner.workflows.state(task.id))?.steps?.approval;
    assert.ok(approval && !Array.isArray(approval)); assert.equal(approval.status, 'suspended');
    assert.equal(engine.calls.length, 1);
    await runner.stop();
    runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    await f.store.recover(); await runner.recover(); await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'awaiting_plan_approval');
    await assert.rejects(async () => await f.service.approve(task.id, pending.version - 1), /Task changed/);
    assert.equal((await f.service.submit(input, 'durable')).id, task.id);
    await f.service.approve(task.id, pending.version);
    await runner.enqueue(task.id); await runner.enqueue(task.id); await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'completed');
    const state = await runner.workflows.state(task.id);
    assert.equal(state?.status, 'success');
    assert.deepEqual(new Set(Object.keys(state!.steps!).filter(k => !k.startsWith('input'))), new Set(['mode', 'prepare-worktree', 'plan', 'approval', 'prepare-environment', 'execute-plan']));
    assert.deepEqual(engine.calls.map(c => c.phase), ['planning', 'implementation', 'qa', 'review']);
    assert.equal((await f.store.evidence(task.id)).filter(e => e.kind === 'commit-created').length, 1);
    assert.equal(JSON.stringify(state).includes('Durable greeting'), false, 'request text must not be duplicated into workflow snapshots');
  } finally { await runner.stop(); await f.cleanup(); }
});

test('approval arriving before workflow suspension is persisted is not lost', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  const propose = f.service.proposePlan.bind(f.service);
  f.service.proposePlan = async (...args) => {
    const pending = await propose(...args);
    await f.service.approve(pending.id, pending.version);
    return pending;
  };
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Fast approval', mode: 'plan-approval' }, 'fast');
    await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'completed');
    assert.equal(engine.calls.filter(c => c.phase === 'planning').length, 1);
    assert.equal((await f.store.evidence(task.id)).filter(e => e.kind === 'commit-created').length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('cancelled persisted approval is cancelled in Mastra without executing the plan', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  let runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Cancel approval', mode: 'plan-approval' }, 'cancel-wait');
    await runner.idle(); await runner.stop();
    runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
    await f.service.cancel(task.id); await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'cancelled');
    assert.equal((await runner.workflows.state(task.id))?.status, 'canceled');
    assert.equal(engine.calls.length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('a workflow persistence failure during a mode wait is recorded without an unhandled worker rejection', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  runner.workflows.run = async () => { throw new Error('Workflow storage unavailable'); };
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Mode wait' }, 'storage-failure');
    await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'failed');
    assert.match((await f.store.task(task.id)).outcome!.error!, /Workflow storage unavailable/);
    assert.equal(engine.calls.length, 0);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('Mastra snapshots redact engine errors and never retry a failed side-effecting step', async () => {
  const f = await fixture(); const engine = new FakeEngine(); let calls = 0;
  engine.execute = async () => { calls++; throw new Error('Provider failed: fixture-secret-value'); };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Failure', mode: 'autonomous' }, 'error');
    await runner.idle();
    assert.equal(calls, 1);
    assert.match((await f.store.task(task.id)).outcome!.error!, /Provider failed: \[REDACTED\]/);
    const state = await runner.workflows.state(task.id);
    assert.equal(state?.status, 'failed');
    assert.equal(JSON.stringify(state).includes('fixture-secret-value'), false);
    await runner.stop();
    const db = await PgSession.open(f.store.legacyPath);
    try { assert.equal(JSON.stringify(await db.prepare('SELECT snapshot FROM mastra_workflow_snapshot').all()).includes('fixture-secret-value'), false); } finally { await db.close(); }
  } finally { await runner.stop(); await f.cleanup(); }
});

test('legacy approved tasks without a Mastra snapshot execute without generating a new plan', async () => {
  const f = await fixture(); const engine = new FakeEngine();
  const task = await f.service.submit({ projectId: 'fixture', request: 'Legacy approval', mode: 'plan-approval' }, 'legacy');
  const workspace = await new WorkspaceManager(f.dataDir).create(await f.store.project('fixture'), task.id, task.request);
  const agents = await f.service.agents('fixture');
  await f.store.checkpoint(task.id, task.version, { workspace, agents }, 'Historical workspace and roster');
  const plan = validPlan();
  plan.items[0]!.branch = workspace.branch;
  await f.service.proposePlan(task.id, plan, agents);
  const pending = await f.store.task(task.id);
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    await runner.recover(); await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'awaiting_plan_approval');
    assert.equal((await runner.workflows.state(task.id))?.status, 'suspended');
    await f.service.approve(task.id, pending.version); await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'completed');
    assert.equal(engine.calls.filter(c => c.phase === 'planning').length, 0);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('an abrupt process death preserves workflow evidence without replaying implementation after recovery', async () => {
  const f = await fixture();
  const task = await f.service.submit({ projectId: 'fixture', request: 'Interrupted task', mode: 'autonomous' }, 'crash-workflow');
  const child = fork('tests/fixtures/workflow-crash.ts', [f.dataDir, task.id], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let runner: TaskRunner | undefined;
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(30000) });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.equal((await f.store.task(task.id)).state, 'running');
    assert.deepEqual(await f.store.recover(), [task.id]);
    const engine = new FakeEngine(); runner = new TaskRunner(f.service, engine, new FixtureValidator());
    f.service.attachRunner(runner); await runner.recover(); await runner.idle();
    assert.equal((await f.store.task(task.id)).state, 'failed');
    assert.equal((await runner.workflows.state(task.id))?.status, 'canceled');
    assert.equal(engine.calls.length, 0);
    assert.equal((await f.store.evidence(task.id)).some(e => e.kind === 'commit-created'), false);
    assert.equal((await f.store.evidence(task.id)).filter(e => e.kind === 'workflow-started').length, 1);
    assert.ok((await f.store.evidence(task.id)).some(e => e.kind === 'workflow-reconciled'), 'interrupted child workflows must also be reconciled');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await runner?.stop(); await f.cleanup();
  }
});
