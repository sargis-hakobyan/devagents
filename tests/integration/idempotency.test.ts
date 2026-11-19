import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PgSession } from '../../src/persistence/pg-session.js';
import { join } from 'node:path';
import { TaskInput, type Task } from '../../src/domain/schemas.js';
import { Store } from '../../src/persistence/store.js';
import { TaskService } from '../../src/orchestration/service.js';
import { fixture } from '../helpers.js';

test('a retry preserves the original mode after global defaults change and distinguishes explicit input', async () => {
  const f = await fixture();
  try {
    const config = { ...f.service.config, defaultMode: 'autonomous' as Task['mode'] };
    const service = await TaskService.create(f.store, config, f.dataDir);
    const input = { projectId: 'fixture', request: 'Use the original default' };
    const task = await service.submit(input, 'default');
    const events = await f.store.events(task.id);
    config.defaultMode = 'plan-approval';
    assert.deepEqual(await service.submit(input, 'default'), task);
    config.defaultMode = undefined;
    assert.deepEqual(await service.submit(input, 'default'), task);
    assert.deepEqual(await f.store.events(task.id), events);
    for (const change of [{ mode: 'autonomous' }, { request: 'Changed' }, { acceptanceCriteria: ['Changed'] }, { teamId: '00000000-0000-4000-8000-000000000001' }]) {
      await assert.rejects(async () => await service.submit({ ...input, ...change }, 'default'), /different input/);
    }
    const explicit = await service.submit({ ...input, mode: 'plan-approval' }, 'explicit');
    config.defaultMode = 'autonomous';
    assert.deepEqual(await service.submit({ ...input, mode: 'plan-approval' }, 'explicit'), explicit);
    await assert.rejects(async () => await service.submit(input, 'explicit'), /different input/);
    await assert.rejects(async () => await service.submit({ ...input, mode: 'autonomous' }, 'explicit'), /different input/);
  } finally { await f.cleanup(); }
});

test('a mode-less retry survives a later mode choice and changed defaults across restart', async () => {
  const f = await fixture();
  try {
    const input = { projectId: 'fixture', request: 'Ask once' };
    const task = await f.service.submit(input, 'ask');
    assert.equal(task.state, 'awaiting_mode');
    const chosen = await f.service.mode(task.id, 'plan-approval');
    const reopened = await Store.open(join(f.dataDir, 'test.db'));
    try {
      const service = await TaskService.create(reopened, { ...f.service.config, defaultMode: 'autonomous' }, f.dataDir);
      assert.deepEqual(await service.submit(input, 'ask'), chosen);
      assert.equal((await reopened.events(task.id)).length, 2);
    } finally { await reopened.close(); }
  } finally { await f.cleanup(); }
});

test('project defaults resolve only for new submissions and still override the global default', async () => {
  const f = await fixture();
  const db = await PgSession.open(join(f.dataDir, 'test.db'));
  try {
    // There is no public mode-default editor yet; simulate persisted project settings changing.
    const setDefault = async (defaultMode: Task['mode']) => await db.prepare('UPDATE projects SET data=$1 WHERE id=$2').run(JSON.stringify({ ...await f.store.project('fixture'), defaultMode }), 'fixture');
    await setDefault('plan-approval');
    const service = await TaskService.create(f.store, { ...f.service.config, defaultMode: 'autonomous' }, f.dataDir);
    const input = { projectId: 'fixture', request: 'Project default' };
    const task = await service.submit(input, 'project');
    assert.equal(task.mode, 'plan-approval');
    await setDefault('autonomous');
    assert.deepEqual(await service.submit(input, 'project'), task);
    assert.equal((await service.submit(input, 'new')).mode, 'autonomous');
    await setDefault(undefined);
    assert.deepEqual(await service.submit(input, 'project'), task);
  } finally { await db.close(); await f.cleanup(); }
});

test('legacy resolved-input fingerprints remain valid after defaults change without rewriting history', async () => {
  const f = await fixture();
  const db = await PgSession.open(join(f.dataDir, 'test.db'));
  try {
    for (const mode of [undefined, 'autonomous', 'plan-approval'] as const) {
      const key = `legacy-${mode}`;
      const raw = { projectId: 'fixture', request: 'Never persist fixture-secret-value', acceptanceCriteria: ['Keep input identity'] };
      const original = TaskInput.parse({ ...raw, ...(mode ? { mode } : {}) });
      const task = await f.store.createTask(original, key);
      // Exact pre-fix format: unprefixed SHA-256 of schema-parsed input after default resolution.
      const fingerprint = createHash('sha256').update(JSON.stringify(original)).digest('hex');
      await db.prepare('UPDATE requests SET fingerprint=$1 WHERE key=$2').run(fingerprint, key);
      if (!mode) await f.service.mode(task.id, 'autonomous');
      const reopened = await Store.open(join(f.dataDir, 'test.db'));
      try {
        const service = await TaskService.create(reopened, { ...f.service.config, defaultMode: mode === 'autonomous' ? 'plan-approval' : 'autonomous' }, f.dataDir);
        assert.deepEqual(await service.submit(raw, key), await reopened.task(task.id));
        if (mode) assert.equal((await service.submit({ ...raw, mode }, key)).id, task.id);
        await assert.rejects(async () => await service.submit({ ...raw, mode: mode === 'autonomous' ? 'plan-approval' : 'autonomous' }, key), /different input/);
        await assert.rejects(async () => await service.submit({ ...raw, acceptanceCriteria: ['Changed'] }, key), /different input/);
        await assert.rejects(async () => await service.submit({ ...raw, request: 'Changed' }, key), /different input/);
        assert.doesNotMatch((await reopened.task(task.id)).request, /fixture-secret-value/);
        assert.equal((await db.prepare('SELECT fingerprint FROM requests WHERE key=$1').get(key))!.fingerprint, fingerprint);
      } finally { await reopened.close(); }
    }
  } finally { await db.close(); await f.cleanup(); }
});

test('mode and team resolution share task creation, roll back on failure, and never run on retries', async () => {
  const f = await fixture();
  try {
    const input = { projectId: 'fixture', request: 'Atomic defaults' };
    const fail = () => { throw new Error('resolution failed'); };
    await assert.rejects(async () => await f.store.createTask(input, 'atomic', fail, () => 'autonomous'), /resolution failed/);
    assert.equal((await f.store.summaries({ limit: 10 })).tasks.length, 0);
    const task = await f.store.createTask(input, 'atomic', task => { assert.equal(task.mode, 'plan-approval'); return undefined; }, () => 'plan-approval');
    assert.equal(task.mode, 'plan-approval');
    assert.match((await f.store.events(task.id))[0]!.reason, /submitted with autonomy mode/);
    assert.deepEqual(await f.store.createTask(input, 'atomic', fail, fail), task);
    assert.equal((await f.store.events(task.id)).length, 1);
  } finally { await f.cleanup(); }
});

test('two Prisma clients submitting concurrently commit one task, request and initial event', async () => {
  const f = await fixture();
  const second = await Store.open(f.store.legacyPath);
  try {
    const input = { projectId: 'fixture', request: 'One task for the same retry key' };
    const [first, retry] = await Promise.all([
      f.store.createTask(input, 'concurrent-retry'),
      second.createTask(input, 'concurrent-retry'),
    ]);
    assert.equal(first.id, retry.id);
    assert.equal((await second.events(first.id)).length, 1);
    assert.deepEqual(await f.store.pendingDispatches(), [first.id]);
  } finally { await second.close(); await f.cleanup(); }
});
