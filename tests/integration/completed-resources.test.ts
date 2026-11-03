import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { workspaceRuntime } from '../../src/engines/node-tools.js';
import { git, WorkspaceManager } from '../../src/workspace/git.js';
import { randomUUID } from 'node:crypto';
import type { CodingEngine } from '../../src/domain/engine.js';

const exists = (path: string) => access(path).then(() => true, () => false);
for (const scenario of ['completed', 'clean', 'failed', 'disabled', 'audit-failure'] as const) test(`automatic resource retention: ${scenario}`, async () => {
  const f = await fixture(false);
  f.service.config.compactCompletedTasks = scenario !== 'disabled';
  if (scenario === 'audit-failure') {
    const record = f.store.record.bind(f.store);
    f.store.record = (id, kind, data) => { if (kind === 'compaction-intent') throw new Error('Fixture storage unavailable'); record(id, kind, data); };
  }
  await writeFile(join(f.project, '.gitignore'), 'node_modules/\nprivate-output/\n');
  await git(f.project, ['add', '.gitignore']); await git(f.project, ['commit', '-qm', 'Ignore fixture resources']);
  const fake = new FakeEngine({ rejectReviews: scenario === 'failed' });
  let runtime = ''; let cwd = '';
  const engine: CodingEngine = { id: 'codex', preflight: async () => {}, async execute(request) {
    if (request.phase === 'setup') {
      cwd = request.cwd; runtime = await workspaceRuntime(f.dataDir, cwd);
      await writeFile(join(runtime, 'cache'), 'tooling');
      await mkdir(join(cwd, 'node_modules'), { recursive: true });
      await writeFile(join(cwd, 'node_modules', 'cache'), 'dependencies');
      if (scenario !== 'clean') {
        await mkdir(join(cwd, 'private-output'), { recursive: true });
        await writeFile(join(cwd, 'private-output', 'keep'), 'unknown ignored output');
      }
    }
    if (['implementation', 'review', 'qa'].includes(request.phase)) {
      assert.equal(await exists(join(runtime, 'cache')), true, 'resources survive until all work drains');
    }
    return fake.execute(request);
  } };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, 'resource-retention');
    await runner.idle(); const done = f.store.task(task.id);
    assert.equal(done.state, scenario === 'failed' ? 'failed' : 'completed', JSON.stringify(done.outcome));
    const reclaimed = scenario === 'completed' || scenario === 'clean';
    assert.equal(await exists(runtime), !reclaimed);
    assert.equal(await exists(join(cwd, 'node_modules')), !reclaimed);
    if (scenario !== 'clean') assert.equal(await readFile(join(cwd, 'private-output', 'keep'), 'utf8'), 'unknown ignored output');
    assert.equal(await exists(join(cwd, 'README.md')), scenario !== 'clean');
    if (scenario === 'audit-failure') {
      assert.equal(runner.executionFailure, undefined, 'maintenance does not invalidate completed work');
      assert.ok(f.store.evidence(task.id).some(e => e.kind === 'compaction-deferred'));
    }
    if (reclaimed) {
      assert.equal(await git(f.project, ['rev-parse', done.workspace!.branch]), done.outcome!.commit);
      assert.ok(f.store.evidence(task.id).some(e => e.kind === 'compaction' && (e.data as { automatic?: boolean }).automatic));
      // Recovery catches completed resources left behind by a crash or an older version.
      if (scenario !== 'clean') {
        await mkdir(join(cwd, 'node_modules')); await writeFile(join(cwd, 'node_modules', 'cache'), 'old dependencies');
      } else {
        assert.ok(f.store.evidence(task.id).some(e => e.kind === 'worktree-cleanup'));
        assert.ok(await f.service.diff(task.id), 'diff remains accessible after checkout removal');
      }
      const calls = fake.calls.length;
      await runner.recover();
      assert.equal(await exists(join(cwd, 'node_modules')), false);
      assert.equal(fake.calls.length, calls, 'recovery never replays a model call');
    }
  } finally { await runner.stop(); await f.cleanup(); }
});

test('automatic checkout removal preserves local work and branches and requires durable intent', async () => {
  const f = await fixture(false);
  const manager = new WorkspaceManager(f.dataDir); const project = f.store.project('fixture');
  try {
    for (const kind of ['clean', 'modified', 'staged', 'untracked', 'ignored', 'hidden', 'changed-result', 'audit-failure'] as const) {
      const id = randomUUID(); const workspace = await manager.create(project, id, kind);
      const commit = await git(workspace.path, ['rev-parse', 'HEAD']);
      if (['modified', 'staged', 'hidden'].includes(kind)) await writeFile(join(workspace.path, 'README.md'), 'Keep this edit');
      if (kind === 'staged') await git(workspace.path, ['add', 'README.md']);
      if (kind === 'hidden') await git(workspace.path, ['update-index', '--assume-unchanged', 'README.md']);
      if (kind === 'untracked') await writeFile(join(workspace.path, 'notes.txt'), 'Keep these notes');
      if (kind === 'ignored') {
        await writeFile(join(workspace.path, '.gitignore'), 'notes.txt\n'); await git(workspace.path, ['add', '.gitignore']);
        await git(workspace.path, ['commit', '-qm', 'Ignore notes']);
        await writeFile(join(workspace.path, 'notes.txt'), 'Keep these ignored notes');
      }
      if (kind === 'changed-result') await git(workspace.path, ['commit', '--allow-empty', '-qm', 'Newer manual commit']);
      const expected = kind === 'ignored' ? await git(workspace.path, ['rev-parse', 'HEAD']) : commit;
      const head = await git(workspace.path, ['rev-parse', 'HEAD']);
      const item = kind === 'clean' ? await manager.createItem(project, id, workspace.branch, 'backend', head) : undefined;
      const removed: string[] = [];
      const remove = () => manager.removeCleanCompleted(project, id, [workspace, ...(item ? [item] : [])], { branch: workspace.branch, commit: expected },
        () => { if (kind === 'audit-failure') throw new Error('No durable intent'); }, w => { removed.push(w.path); });
      if (kind === 'audit-failure' || kind === 'changed-result') await assert.rejects(remove);
      else await remove();
      assert.equal(await exists(workspace.path), kind !== 'clean', kind);
      assert.equal(removed.length, kind === 'clean' ? 2 : 0, kind);
      assert.equal(await git(project.path, ['rev-parse', workspace.branch]), head, 'all branches retain their commits');
      if (item) {
        assert.equal(await exists(item.path), false);
        assert.equal(await git(project.path, ['rev-parse', item.branch]), head, 'work-item branches also survive');
      }
    }
  } finally { await f.cleanup(); }
});
