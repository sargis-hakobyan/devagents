import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { TaskService } from '../../src/orchestration/service.js';
import { fixture, validPlan } from '../helpers.js';

test('mode asks once; a persisted plan requires the reviewed version and explicit approval', async () => {
  const f = await fixture();
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Build greeting' }, 'request-1');
    assert.equal(task.state, 'awaiting_mode');
    assert.equal((await f.service.submit({ projectId: 'fixture', request: 'Build greeting' }, 'request-1')).id, task.id);
    await assert.rejects(async () => await f.service.submit({ projectId: 'fixture', request: 'Different' }, 'request-1'), /different input/);
    await assert.rejects(f.service.proposePlan(task.id, validPlan()), /not awaiting a plan/);
    await f.service.mode(task.id, 'plan-approval');
    await assert.rejects(async () => await f.service.mode(task.id, 'autonomous'), /already been selected/);
    const pending = await f.service.proposePlan(task.id, validPlan());
    assert.equal(pending.state, 'awaiting_plan_approval');
    const reopened = await Store.open(join(f.dataDir, 'test.db'));
    try {
      assert.deepEqual(await reopened.recover(), []);
      const service = await TaskService.create(reopened, f.service.config, f.dataDir);
      assert.equal((await reopened.task(task.id)).state, 'awaiting_plan_approval');
      await assert.rejects(async () => await service.approve(task.id, 0), /Task changed/);
      assert.equal((await service.approve(task.id, pending.version)).state, 'ready');
      assert.deepEqual((await reopened.events(task.id)).map(e => e.state), ['awaiting_mode', 'planning', 'awaiting_plan_approval', 'ready']);
      assert.equal((await reopened.events(task.id)).every(e => e.runId === task.runId && e.actor && e.reason), true);
    } finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});
test('explicit modes, rejection, redaction and interrupted work recovery', async () => {
  const f = await fixture();
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Never persist fixture-secret-value', mode: 'autonomous' }, 'one');
    assert.equal(task.state, 'planning'); assert.doesNotMatch(task.request, /fixture-secret-value/);
    const ready = await f.service.proposePlan(task.id, validPlan());
    assert.equal(ready.state, 'ready');
    await f.store.transition(task.id, ready.version, 'running', 'scheduler', 'Work started');
    assert.deepEqual(await f.store.recover(), [task.id]);
    assert.equal((await f.store.task(task.id)).state, 'failed');
    assert.deepEqual(await f.store.recover(), []);
    const second = await f.service.submit({ projectId: 'fixture', request: 'Another', mode: 'plan-approval' }, 'two');
    await f.service.proposePlan(second.id, validPlan());
    assert.equal((await f.service.cancel(second.id)).state, 'cancelled');
    await assert.rejects(async () => await f.service.approve(second.id, 2), /not awaiting plan approval/);
  } finally { await f.cleanup(); }
});
test('task mode overrides project default and default skips the prompt', async () => {
  const f = await fixture();
  try {
    const configured = await TaskService.create(f.store, { ...f.service.config, defaultMode: 'autonomous' }, f.dataDir);
    assert.equal((await configured.submit({ projectId: 'fixture', request: 'Default' }, 'default')).mode, 'autonomous');
    assert.equal((await configured.submit({ projectId: 'fixture', request: 'Override', mode: 'plan-approval' }, 'override')).mode, 'plan-approval');
  } finally { await f.cleanup(); }
});
