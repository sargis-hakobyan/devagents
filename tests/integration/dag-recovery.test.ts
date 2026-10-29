import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fixture, validPlan } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';

test('restart recovery retains item worktree and checkpoint evidence without replaying work', async () => {
  const f = await fixture(); let reopened: Store | undefined;
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Recover DAG', mode: 'autonomous' }, 'recover-dag');
    const plan = validPlan();
    const ready = f.store.transition(task.id, task.version, 'ready', 'test', 'Plan stored', { plan });
    f.store.transition(task.id, ready.version, 'running', 'test', 'Workers started');
    f.store.record(task.id, 'work-item', { itemId: 'greeting', state: 'checkpointing', workspace: { path: '/fixture/owned', branch: 'codex/fixture', baseSha: 'a'.repeat(40) } });
    f.store.record(task.id, 'item-commit-intent', { workItemId: 'greeting', digest: 'fixture' });
    reopened = new Store(join(f.dataDir, 'test.db'));
    assert.deepEqual(reopened.recover(), [task.id]);
    assert.equal(reopened.task(task.id).state, 'failed');
    const item = reopened.workItems(task.id)[0]!;
    assert.equal(item.state, 'interrupted'); assert.equal((item.workspace as { path: string }).path, '/fixture/owned');
    assert.deepEqual(reopened.recover(), []);
    assert.equal(reopened.evidence(task.id).filter(e => e.kind === 'item-commit-intent').length, 1);
  } finally { reopened?.close(); await f.cleanup(); }
});
