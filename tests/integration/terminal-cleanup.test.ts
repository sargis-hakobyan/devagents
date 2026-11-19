import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, validPlan } from '../helpers.js';
import { FakeEngine, FixtureValidator } from '../fixtures/fake-engine.js';
import { TaskRunner } from '../../src/orchestration/runner.js';
import { git, WorkspaceManager } from '../../src/workspace/git.js';
import { cleanupTerminalWorktrees, type CleanupRecord } from '../../src/workspace/terminal-cleanup.js';

const exists = (p: string) => access(p).then(() => true, () => false);
for (const end of ['completed', 'failed', 'cancelled'] as const) test(`terminal cleanup removes drained ${end} resources and retains recoverable work`, async () => {
  const f = await fixture(false); f.service.config.cleanupTerminalTasks = true;
  await writeFile(join(f.project, '.gitignore'), 'node_modules/\nprivate-output/\n');
  await git(f.project, ['add', '.gitignore']); await git(f.project, ['commit', '-qm', 'Ignore generated resources']);
  const engine = new FakeEngine({ rejectReviews: end === 'failed' }); const execute = engine.execute.bind(engine);
  let taskId = '';
  engine.execute = async request => {
    if (request.phase === 'implementation') {
      await mkdir(join(request.cwd, 'node_modules'), { recursive: true }); await writeFile(join(request.cwd, 'node_modules/cache'), 'regenerable');
      await mkdir(join(request.cwd, 'private-output'), { recursive: true }); await writeFile(join(request.cwd, 'private-output/notes'), 'unfinished local material');
      if (end === 'cancelled') await f.service.cancel(taskId);
    }
    return execute(request);
  };
  const runner = new TaskRunner(f.service, engine, new FixtureValidator()); f.service.attachRunner(runner);
  try {
    const task = await f.service.submit({ projectId: 'fixture', request: 'Greeting', mode: 'autonomous' }, end);
    taskId = task.id;
    await runner.idle(); const done = await f.store.task(task.id);
    assert.equal(done.state, end, JSON.stringify(done.outcome));
    assert.equal(await exists(done.workspace!.path), false);
    assert.ok(await git(f.project, ['rev-parse', done.workspace!.branch]));
    const records = (await f.store.evidence(task.id)).filter(e => e.kind === 'worktree-cleanup');
    assert.equal(records.length, 1);
    const record = records[0]!.data as CleanupRecord;
    assert.ok(record.recoveryPath);
    const restored = join(f.root, 'restored'); await mkdir(restored);
    execFileSync('tar', ['-xzf', join(record.recoveryPath, 'workspace.tar.gz'), '-C', restored]);
    assert.equal(await readFile(join(restored, 'private-output/notes'), 'utf8'), 'unfinished local material');
    assert.equal(await exists(join(restored, 'node_modules')), false);
    assert.equal(await exists(join(restored, '.git')), false);
    if (end === 'completed') assert.ok(await f.service.diff(task.id));
    const calls = engine.calls.length; await runner.recover();
    assert.equal(engine.calls.length, calls); assert.equal((await readdir(join(f.dataDir, 'recovery'))).length, 1);
  } finally { await runner.stop(); await f.cleanup(); }
});

test('snapshots preserve staged-only binary changes, hidden edits, ignored files and symlinks without following them', async () => {
  const f = await fixture(false);
  try {
    const id = randomUUID(); const project = await f.store.project('fixture');
    const w = await new WorkspaceManager(f.dataDir).create(project, id, 'Snapshot');
    const binary = Buffer.from([0, 255, 1, 128]); await writeFile(join(w.path, 'binary'), binary);
    await git(w.path, ['add', 'binary']); const expectedBlob = await git(w.path, ['rev-parse', ':binary']); await writeFile(join(w.path, 'binary'), 'working copy');
    await git(w.path, ['update-index', '--assume-unchanged', 'README.md']); await writeFile(join(w.path, 'README.md'), 'Hidden edit');
    await symlink(f.project, join(w.path, 'external'));
    let saved: CleanupRecord | undefined;
    await cleanupTerminalWorktrees(f.dataDir, project, id, [w], () => {}, r => { saved = r; });
    assert.equal(await exists(w.path), false);
    const restored = join(f.root, 'restored'); await mkdir(restored);
    execFileSync('tar', ['-xzf', join(saved!.recoveryPath!, 'workspace.tar.gz'), '-C', restored]);
    assert.equal(await readFile(join(restored, 'README.md'), 'utf8'), 'Hidden edit');
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), '# Fixture\n');
    const staged = await new WorkspaceManager(f.dataDir).create(project, randomUUID(), 'Restore staged');
    await git(staged.path, ['apply', '--cached', join(saved!.recoveryPath!, 'staged.patch')]);
    assert.equal(await git(staged.path, ['rev-parse', ':binary']), expectedBlob, 'staged binary content survives even when overwritten before failure');
  } finally { await f.cleanup(); }
});

test('cleanup refuses missing durable intent and nested Git, leaving original edits intact', async () => {
  const f = await fixture(false);
  try {
    for (const kind of ['audit', 'nested-git', 'changed'] as const) {
      const id = randomUUID(); const project = await f.store.project('fixture'); const w = await new WorkspaceManager(f.dataDir).create(project, id, kind);
      await writeFile(join(w.path, 'README.md'), 'Keep');
      if (kind === 'nested-git') { await mkdir(join(w.path, 'nested/.git'), { recursive: true }); }
      await assert.rejects(cleanupTerminalWorktrees(f.dataDir, project, id, [w], () => {
        if (kind === 'audit') throw new Error('No durable intent');
        if (kind === 'changed') execFileSync('git', ['-C', w.path, 'commit', '--allow-empty', '-qm', 'Changed concurrently']);
      }, () => { throw new Error('Must not remove'); }));
      assert.equal(await readFile(join(w.path, 'README.md'), 'utf8'), 'Keep');
    }
  } finally { await f.cleanup(); }
});

test('restart marks ready setup failures failed, leaving never-started ready tasks alone', async () => {
  const f = await fixture();
  try {
    const tasks = (await Promise.all(['setup', 'idle'].map(async key => await f.service.submit({ projectId: 'fixture', request: key, mode: 'autonomous' }, key))));
    for (const task of tasks) await f.store.transition(task.id, task.version, 'ready', 'test', 'Plan', { plan: validPlan() });
    await f.store.record(tasks[0]!.id, 'run-failed', { phase: 'setup', message: 'database or disk is full' });
    assert.deepEqual(await f.store.recover(), [tasks[0]!.id]);
    assert.equal((await f.store.task(tasks[0]!.id)).state, 'failed'); assert.ok((await f.store.task(tasks[0]!.id)).outcome?.error);
    assert.equal((await f.store.task(tasks[1]!.id)).state, 'ready');
  } finally { await f.cleanup(); }
});

test('conflict recovery retains all three index stages and the working conflict resolution', async () => {
  const f = await fixture(false);
  try {
    const id = randomUUID(); const project = await f.store.project('fixture'); const manager = new WorkspaceManager(f.dataDir);
    const w = await manager.create(project, id, 'Conflict');
    const other = await manager.createItem(project, id, w.branch, 'other', w.baseSha);
    await writeFile(join(other.path, 'README.md'), 'Other version'); await git(other.path, ['add', '.']); await git(other.path, ['commit', '-qm', 'Other']);
    await writeFile(join(w.path, 'README.md'), 'Own version'); await git(w.path, ['add', '.']); await git(w.path, ['commit', '-qm', 'Own']);
    await assert.rejects(git(w.path, ['-c', 'commit.gpgSign=false', 'merge', other.branch]));
    const stages = (await git(w.path, ['ls-files', '--unmerged'])).split('\n').map(line => line.split(' ')[1]!);
    assert.equal(stages.length, 3);
    await writeFile(join(w.path, 'README.md'), 'Resolution in progress');
    let saved: CleanupRecord | undefined;
    await cleanupTerminalWorktrees(f.dataDir, project, id, [w], () => {}, r => { saved = r; });
    const contents = await Promise.all(stages.map(oid => readFile(join(saved!.recoveryPath!, 'conflict-blobs', oid), 'utf8')));
    assert.deepEqual(contents, ['# Fixture\n', 'Own version', 'Other version']);
    assert.equal(await exists(w.path), false);
  } finally { await f.cleanup(); }
});

test('cleanup recovers owned checkouts created before the workspace checkpoint, including canonicalized data paths', async () => {
  const f = await fixture(false); f.service.config.cleanupTerminalTasks = true;
  try {
    for (const kind of ['root', 'item'] as const) {
      const task = await f.service.submit({ projectId: 'fixture', request: kind, mode: 'autonomous' }, kind);
      const project = await f.store.project('fixture'); const manager = new WorkspaceManager(f.dataDir);
      await f.store.record(task.id, 'worktree-intent', { owner: task.id });
      const root = await manager.create(project, task.id, task.request);
      let item: typeof root | undefined;
      if (kind === 'item') {
        await f.store.checkpoint(task.id, (await f.store.task(task.id)).version, { workspace: root }, 'Root created');
        item = await manager.createItem(project, task.id, root.branch, 'worker', root.baseSha);
        await f.store.record(task.id, 'worktree-intent', { owner: task.id, workItemId: 'worker', branch: item.branch, baseSha: root.baseSha });
      }
      await f.store.transition(task.id, (await f.store.task(task.id)).version, 'failed', 'fixture', 'Checkpoint interrupted');
      await f.service.cleanupTerminalTask(task.id);
      assert.equal(await exists(root.path), false);
      if (item) assert.equal(await exists(item.path), false);
      assert.ok((await f.store.evidence(task.id)).some(e => e.kind === 'terminal-cleanup'));
    }
  } finally { await f.cleanup(); }
});
