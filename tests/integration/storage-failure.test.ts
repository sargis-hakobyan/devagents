import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';

test('PostgreSQL transaction rollback after a write failure preserves the original error and task rows', async () => {
  const f = await fixture();
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Existing task' }, 'existing');
    await assert.rejects(async () => await f.store.createTask({ projectId: 'fixture', request: 'New task' }, 'failed-write', async () => {
      await f.store.record(task.id, 'before-failure', {});
      await f.store.savePullRequest('missing-task', { state: 'open' } as Parameters<typeof f.store.savePullRequest>[1]);
      return undefined;
    }), { code: 'P2003' });
    assert.equal((await f.store.evidenceOf(task.id, ['before-failure'])).length, 0);
    assert.equal((await f.store.tasks()).length, 1);
    assert.equal((await f.store.task(task.id)).request, 'Existing task');
  } finally { await f.cleanup(); }
});

test('a failed final checkpoint halts execution without an unhandled runner rejection or deleting tasks', async () => {
  const f = await fixture(); const engine = new FakeEngine({ limitations: ['Browser unavailable'] });
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  const checkpoint = f.store.checkpoint.bind(f.store); const transition = f.store.transition.bind(f.store);
  f.store.checkpoint = async (...args) => { if (args[2].outcome) throw new Error('SQLITE_FULL: database or disk is full'); return checkpoint(...args); };
  f.store.transition = async (...args) => { if (args[2] === 'failed') throw new Error('SQLITE_FULL: database or disk is full'); return transition(...args); };
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Keep history', mode: 'autonomous' }, 'checkpoint-full');
    await runner.idle();
    assert.match(runner.executionFailure!.message, /SQLITE_FULL/);
    assert.equal(runner.executionFailure!.taskId, task.id);
    assert.equal(await runner.isDrained(task.id), true);
    assert.equal((await f.store.tasks()).length, 1);
    assert.equal((await f.store.task(task.id)).outcome?.commit, undefined);
    await assert.rejects(async () => await f.service.submit({ projectId: 'fixture', request: 'Do not enqueue' }, 'halted'), /Execution halted/);
    assert.equal((await f.store.tasks()).length, 1);
    assert.equal((await f.service.storageStatus()).executionFailure!.taskId, task.id);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('low disk guard runs inside the Mastra prepare step without invoking a model or spending repairs', async () => {
  const f = await fixture(); f.service.config.minFreeDiskBytes = Number.MAX_SAFE_INTEGER;
  const engine = new FakeEngine(); const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'No disk', mode: 'autonomous' }, 'low-space');
    await runner.idle();
    const result = await f.store.task(task.id);
    assert.equal(result.state, 'failed'); assert.equal(result.outcome!.repairCycles, 0);
    assert.match(result.outcome!.error!, /Insufficient disk space/);
    assert.equal(engine.calls.length, 0);
    assert.equal((await runner.workflows.state(task.id))?.status, 'failed');
  } finally { await runner.stop(); await f.cleanup(); }
});

test('cancelled tasks cannot compact until the Mastra hook and its process cleanup have drained', async () => {
  const f = await fixture(); const engine = new FakeEngine(); const execute = engine.execute.bind(engine);
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const shutdown = new Promise<void>(resolve => { release = resolve; });
  engine.execute = async request => {
    if (request.phase !== 'implementation') return execute(request);
    entered();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => { void shutdown.then(() => reject(new Error('Fixture process stopped'))); };
      if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true });
    });
    throw new Error('Unreachable');
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Delayed shutdown', mode: 'autonomous' }, 'drain');
    await Promise.race([started, runner.idle().then(() => { throw new Error('Task ended before implementation'); })]);
    await f.service.cancel(task.id);
    assert.equal((await f.store.task(task.id)).state, 'cancelled');
    assert.equal(runner.workflows.isDrained(task.id), false);
    await assert.rejects(f.service.compactionPreview(task.id), /draining/);
    release(); await runner.idle();
    assert.equal(await runner.isDrained(task.id), true);
    assert.equal((await f.service.compactionPreview(task.id)).candidates.length, 0);
    assert.equal((await f.store.task(task.id)).outcome?.commit, undefined);
  } finally { release(); await runner.stop(); await f.cleanup(); }
});
