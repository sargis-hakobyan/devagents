import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { git } from '../../src/workspace/git.js';

const exists = (path: string) => access(path).then(() => true, () => false);
const worktrees = async (project: string) => (await git(project, ['worktree', 'list', '--porcelain'], false)).split('\n').filter(l => l.startsWith('worktree ')).length;
const branches = async (project: string) => (await git(project, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).split('\n').filter(Boolean).sort();

test('cleanup removes a completed task’s managed worktree, keeps its reviewed branch, and leaves user work alone', async () => {
  const f = await fixture(); const runner = new TaskRunner(f.service, new FakeEngine(), new FixtureValidator()); f.service.attachRunner(runner);
  try {
    await writeFile(join(f.project, 'README.md'), 'Dirty user work'); await git(f.project, ['branch', 'user-feature']);
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'cleanup-done');
    await assert.rejects(f.service.cleanup(task.id), /requires a completed, failed or cancelled task/);
    await runner.idle(); const done = f.store.task(task.id); assert.equal(done.state, 'completed');
    assert.equal(await worktrees(f.project), 2);
    const result = await f.service.cleanup(task.id);
    assert.deepEqual(result, { removedWorktrees: [done.workspace!.path], removedBranches: [], keptBranches: [done.workspace!.branch] });
    assert.equal(await exists(done.workspace!.path), false); assert.equal(await worktrees(f.project), 1);
    assert.deepEqual(await branches(f.project), [done.workspace!.branch, 'main', 'user-feature']);
    assert.equal(await git(f.project, ['rev-parse', done.workspace!.branch]), done.outcome!.commit);
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), 'Dirty user work');
    assert.equal(await git(f.project, ['branch', '--show-current']), 'main');
    // Idempotent: a second cleanup finds nothing left to remove and still reports the kept branch.
    assert.deepEqual(await f.service.cleanup(task.id), { removedWorktrees: [], removedBranches: [], keptBranches: [done.workspace!.branch] });
    assert.equal(f.store.evidence(task.id).filter(e => e.kind === 'cleanup').length, 2);
  } finally { await runner.stop(); await f.cleanup(); }
});
test('cleanup of a failed task deletes its branch and refuses forged workspace paths', async () => {
  const f = await fixture(); const runner = new TaskRunner(f.service, new FakeEngine({ rejectReviews: true }), new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'cleanup-failed');
    await runner.idle(); const failed = f.store.task(task.id); assert.equal(failed.state, 'failed');
    // Evidence is append-only data; a workspace entry pointing at the user's checkout must never be removed.
    f.store.record(task.id, 'work-item', { itemId: 'forged', state: 'running', workspace: { path: f.project, branch: `codex/devagents-${task.id}-forged` } });
    await assert.rejects(f.service.cleanup(task.id), /Refusing to remove/);
    assert.equal(await worktrees(f.project), 2, 'nothing removed when any entry is refused');
    const taskOnly = await import('../../src/workspace/git.js').then(m => new m.WorkspaceManager(f.dataDir).cleanup(f.store.project('fixture'), task.id, [failed.workspace!]));
    assert.deepEqual(taskOnly, { removedWorktrees: [failed.workspace!.path], removedBranches: [failed.workspace!.branch], keptBranches: [] });
    assert.deepEqual(await branches(f.project), ['main']); assert.equal(await worktrees(f.project), 1);
  } finally { await runner.stop(); await f.cleanup(); }
});
