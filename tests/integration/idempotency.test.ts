import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { TaskInput, type Task } from '../../src/domain/schemas.js';
import { Store } from '../../src/persistence/store.js';
import { TaskService } from '../../src/orchestration/service.js';
import { fixture } from '../helpers.js';

test('a retry preserves the original mode after global defaults change and distinguishes explicit input', async () => {
  const f = await fixture();
  try {
    const config = { ...f.service.config, defaultMode: 'autonomous' as Task['mode'] };
    const service = new TaskService(f.store, config, f.dataDir);
    const input = { projectId: 'fixture', request: 'Use the original default' };
    const task = service.submit(input, 'default');
    const events = f.store.events(task.id);
    config.defaultMode = 'plan-approval';
    assert.deepEqual(service.submit(input, 'default'), task);
    config.defaultMode = undefined;
    assert.deepEqual(service.submit(input, 'default'), task);
    assert.deepEqual(f.store.events(task.id), events);
    for (const change of [{ mode: 'autonomous' }, { request: 'Changed' }, { acceptanceCriteria: ['Changed'] }, { teamId: '00000000-0000-4000-8000-000000000001' }]) {
      assert.throws(() => service.submit({ ...input, ...change }, 'default'), /different input/);
    }
    const explicit = service.submit({ ...input, mode: 'plan-approval' }, 'explicit');
    config.defaultMode = 'autonomous';
    assert.deepEqual(service.submit({ ...input, mode: 'plan-approval' }, 'explicit'), explicit);
    assert.throws(() => service.submit(input, 'explicit'), /different input/);
    assert.throws(() => service.submit({ ...input, mode: 'autonomous' }, 'explicit'), /different input/);
  } finally { await f.cleanup(); }
});

test('a mode-less retry survives a later mode choice and changed defaults across restart', async () => {
  const f = await fixture();
  try {
    const input = { projectId: 'fixture', request: 'Ask once' };
    const task = f.service.submit(input, 'ask');
    assert.equal(task.state, 'awaiting_mode');
    const chosen = f.service.mode(task.id, 'plan-approval');
    const reopened = new Store(join(f.dataDir, 'test.db'));
    try {
      const service = new TaskService(reopened, { ...f.service.config, defaultMode: 'autonomous' }, f.dataDir);
      assert.deepEqual(service.submit(input, 'ask'), chosen);
      assert.equal(reopened.events(task.id).length, 2);
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});

test('project defaults resolve only for new submissions and still override the global default', async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.dataDir, 'test.db'));
  try {
    // There is no public mode-default editor yet; simulate persisted project settings changing.
    const setDefault = (defaultMode: Task['mode']) => db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({ ...f.store.project('fixture'), defaultMode }), 'fixture');
    setDefault('plan-approval');
    const service = new TaskService(f.store, { ...f.service.config, defaultMode: 'autonomous' }, f.dataDir);
    const input = { projectId: 'fixture', request: 'Project default' };
    const task = service.submit(input, 'project');
    assert.equal(task.mode, 'plan-approval');
    setDefault('autonomous');
    assert.deepEqual(service.submit(input, 'project'), task);
    assert.equal(service.submit(input, 'new').mode, 'autonomous');
    setDefault(undefined);
    assert.deepEqual(service.submit(input, 'project'), task);
  } finally { db.close(); await f.cleanup(); }
});

test('legacy resolved-input fingerprints remain valid after defaults change without rewriting history', async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.dataDir, 'test.db'));
  try {
    for (const mode of [undefined, 'autonomous', 'plan-approval'] as const) {
      const key = `legacy-${mode}`;
      const raw = { projectId: 'fixture', request: 'Never persist fixture-secret-value', acceptanceCriteria: ['Keep input identity'] };
      const original = TaskInput.parse({ ...raw, ...(mode ? { mode } : {}) });
      const task = f.store.createTask(original, key);
      // Exact pre-fix format: unprefixed SHA-256 of schema-parsed input after default resolution.
      const fingerprint = createHash('sha256').update(JSON.stringify(original)).digest('hex');
      db.prepare('UPDATE requests SET fingerprint=? WHERE key=?').run(fingerprint, key);
      if (!mode) f.service.mode(task.id, 'autonomous');
      const reopened = new Store(join(f.dataDir, 'test.db'));
      try {
        const service = new TaskService(reopened, { ...f.service.config, defaultMode: mode === 'autonomous' ? 'plan-approval' : 'autonomous' }, f.dataDir);
        assert.deepEqual(service.submit(raw, key), reopened.task(task.id));
        if (mode) assert.equal(service.submit({ ...raw, mode }, key).id, task.id);
        assert.throws(() => service.submit({ ...raw, mode: mode === 'autonomous' ? 'plan-approval' : 'autonomous' }, key), /different input/);
        assert.throws(() => service.submit({ ...raw, acceptanceCriteria: ['Changed'] }, key), /different input/);
        assert.throws(() => service.submit({ ...raw, request: 'Changed' }, key), /different input/);
        assert.doesNotMatch(reopened.task(task.id).request, /fixture-secret-value/);
        assert.equal(db.prepare('SELECT fingerprint FROM requests WHERE key=?').get(key)!.fingerprint, fingerprint);
      } finally { reopened.close(); }
    }
  } finally { db.close(); await f.cleanup(); }
});

test('mode and team resolution share task creation, roll back on failure, and never run on retries', async () => {
  const f = await fixture();
  try {
    const input = { projectId: 'fixture', request: 'Atomic defaults' };
    const fail = () => { throw new Error('resolution failed'); };
    assert.throws(() => f.store.createTask(input, 'atomic', fail, () => 'autonomous'), /resolution failed/);
    assert.equal(f.store.summaries({ limit: 10 }).tasks.length, 0);
    const task = f.store.createTask(input, 'atomic', task => { assert.equal(task.mode, 'plan-approval'); return undefined; }, () => 'plan-approval');
    assert.equal(task.mode, 'plan-approval');
    assert.match(f.store.events(task.id)[0]!.reason, /submitted with autonomy mode/);
    assert.deepEqual(f.store.createTask(input, 'atomic', fail, fail), task);
    assert.equal(f.store.events(task.id).length, 1);
  } finally { await f.cleanup(); }
});
