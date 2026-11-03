import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceManager, git, inspectProject } from '../../src/workspace/git.js';
import { scopedPath } from '../../src/workspace/paths.js';
import { changes, commitChanges } from '../../src/workspace/changes.js';
import { fixture } from '../helpers.js';

test('every task starts clean from current local main, ignoring other branches and prior task work', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, '.gitignore'), 'ignored.txt\n');
    await git(f.project, ['add', '.gitignore']); await git(f.project, ['commit', '-qm', 'Ignore local artifacts']);
    const main = await git(f.project, ['rev-parse', 'main']);
    await git(f.project, ['switch', '-c', 'unrelated-feature']);
    await writeFile(join(f.project, 'feature-only.txt'), 'Another branch');
    await git(f.project, ['add', '.']); await git(f.project, ['commit', '-qm', 'Unrelated work']);
    const originalHead = await git(f.project, ['rev-parse', 'HEAD']);
    await writeFile(join(f.project, 'README.md'), 'Staged user changes'); await git(f.project, ['add', 'README.md']);
    await writeFile(join(f.project, 'README.md'), 'Unstaged user changes');
    await writeFile(join(f.project, 'local.txt'), 'Untracked user file');
    await writeFile(join(f.project, 'ignored.txt'), 'Ignored user file');
    const originalStatus = await git(f.project, ['status', '--porcelain', '--ignored']);
    const project = await inspectProject({ id: 'fixture', path: f.project });
    assert.equal(project.baseSha, main, 'registration records main even when another branch is checked out');
    const manager = new WorkspaceManager(f.dataDir); const id = randomUUID();
    const a = await manager.create(project, id, 'Same request');
    assert.equal(a.baseSha, main); assert.equal(a.originalHead, originalHead);
    assert.equal(await git(a.path, ['status', '--porcelain', '--ignored']), '');
    for (const file of ['feature-only.txt', 'local.txt', 'ignored.txt']) await assert.rejects(access(join(a.path, file)));
    assert.equal(await readFile(join(a.path, 'README.md'), 'utf8'), '# Fixture\n');
    await writeFile(join(a.path, 'task-only.txt'), 'First task result');
    const result = await commitChanges(project, a, ['task-only.txt']);
    const b = await manager.create(project, randomUUID(), 'Same request');
    assert.notEqual(a.branch, b.branch); assert.equal(b.baseSha, main);
    await assert.rejects(access(join(b.path, 'task-only.txt')), 'another task must not inherit this result');
    await assert.rejects(manager.create(project, id, 'Same request'), 'existing task branches are never reset or reused');
    assert.equal(await git(project.path, ['rev-parse', a.branch]), result);
    // Simulate the user updating main after registration; the next task takes its new tip.
    await git(project.path, ['update-ref', 'refs/heads/main', result, main]);
    const c = await manager.create(project, randomUUID(), 'New main');
    assert.equal(c.baseSha, result);
    assert.equal(await git(c.path, ['status', '--porcelain', '--ignored']), '');
    assert.equal(await git(f.project, ['symbolic-ref', '--short', 'HEAD']), 'unrelated-feature');
    assert.equal(await git(f.project, ['rev-parse', 'HEAD']), originalHead);
    assert.equal(await git(f.project, ['status', '--porcelain', '--ignored']), originalStatus);
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), 'Unstaged user changes');
  } finally { await f.cleanup(); }
});

test('missing local main fails explicitly instead of falling back to HEAD or origin/main', async () => {
  const f = await fixture();
  try {
    await git(f.project, ['branch', '-m', 'other']);
    await git(f.project, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const missingMain = (error: unknown) => (error as { code?: string }).code === 'main_branch_missing';
    await assert.rejects(inspectProject({ id: 'fixture', path: f.project }), missingMain);
    await assert.rejects(new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), randomUUID(), 'No fallback'), missingMain);
    assert.equal(await git(f.project, ['for-each-ref', '--format=%(refname)', 'refs/heads/devagents/']), '');
  } finally { await f.cleanup(); }
});

test('large tracked lockfiles can be reviewed, fully fingerprinted and committed', async () => {
  const f = await fixture(false);
  try {
    const original = 'lockfileVersion: 9\npackages:\n' + Array.from({ length: 24000 }, (_, i) => `  package-${i}: {version: 1.0.0}\n`).join('');
    assert.ok(Buffer.byteLength(original) > 512 * 1024);
    await writeFile(join(f.project, 'pnpm-lock.yaml'), original);
    await git(f.project, ['add', 'pnpm-lock.yaml']);
    await git(f.project, ['commit', '-m', 'Add large fixture lockfile']);
    await f.service.registerProject({ id: 'fixture', path: f.project });
    const project = f.store.project('fixture');
    const workspace = await new WorkspaceManager(f.dataDir).create(project, randomUUID(), 'Edit the lockfile');
    const agent = (await f.service.agents('fixture')).find(a => a.id === 'general-developer')!;
    const updated = original.replace('package-23999: {version: 1.0.0}', 'package-23999: {version: 1.0.1}');
    await writeFile(join(workspace.path, 'pnpm-lock.yaml'), updated);
    const first = await changes(workspace, agent);
    assert.deepEqual(first.files, ['pnpm-lock.yaml']);
    assert.match(first.diff, /\+  package-23999: \{version: 1\.0\.1\}/);
    // Changes beyond the former size limit must participate in the review digest.
    const final = updated.replace('package-23999: {version: 1.0.1}', 'package-23999: {version: 1.0.2}');
    await writeFile(join(workspace.path, 'pnpm-lock.yaml'), final);
    const checked = await changes(workspace, agent);
    assert.notEqual(checked.digest, first.digest);
    const commit = await commitChanges(project, workspace, checked.files);
    assert.equal(await git(workspace.path, ['show', `${commit}:pnpm-lock.yaml`], false), final);
    assert.equal(await readFile(join(f.project, 'pnpm-lock.yaml'), 'utf8'), original);
  } finally { await f.cleanup(); }
});

test('isolated worktrees preserve dirty checkout and do not invoke repository hooks', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, 'README.md'), 'User dirty changes\n');
    await writeFile(join(f.project, 'local.txt'), 'Untracked user work');
    const hooks = join(f.project, '.git', 'hooks');
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const manager = new WorkspaceManager(f.dataDir);
    const a = await manager.create(f.store.project('fixture'), randomUUID(), 'Same request');
    const b = await manager.create(f.store.project('fixture'), randomUUID(), 'Same request');
    assert.notEqual(a.path, b.path); assert.notEqual(a.branch, b.branch);
    await writeFile(join(a.path, 'README.md'), 'Worker changes');
    assert.equal(await readFile(join(b.path, 'README.md'), 'utf8'), '# Fixture\n');
    assert.equal(await readFile(join(f.project, 'README.md'), 'utf8'), 'User dirty changes\n');
    assert.equal(await readFile(join(f.project, 'local.txt'), 'utf8'), 'Untracked user work');
    assert.equal(await git(f.project, ['branch', '--show-current']), 'main');
    assert.equal(a.baseSha, b.baseSha);
  } finally { await f.cleanup(); }
});
test('rejects traversal, symlink escapes, Git metadata and non-root registration', async () => {
  const f = await fixture();
  try {
    await symlink(f.root, join(f.project, 'escape'));
    for (const path of ['../secret', '/etc/passwd', 'escape/secret', '.git/config', 'src/../../secret', '.devagents/agents/agent.yaml']) await assert.rejects(scopedPath(f.project, path));
    await mkdir(join(f.project, 'src'));
    await assert.rejects(inspectProject({ id: 'nested', path: join(f.project, 'src') }), /checkout root/);
    assert.equal(await scopedPath(f.project, 'src/new.ts'), join(await import('node:fs/promises').then(fs => fs.realpath(f.project)), 'src/new.ts'));
  } finally { await f.cleanup(); }
});
test('repository checkout filters cannot execute during managed worktree creation', async () => {
  const f = await fixture();
  try {
    await git(f.project, ['config', 'filter.hostile.smudge', 'sh -c "exit 42"']);
    await assert.rejects(new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), randomUUID(), 'Filtered'), /filters requires sandbox/);
  } finally { await f.cleanup(); }
});

test('oversized Git output is reported as an actionable error rather than a raw buffer failure', async () => {
  const f = await fixture();
  try { await assert.rejects(git(f.project, ['log'], true, 16), /git log output exceeded 16 bytes/); } finally { await f.cleanup(); }
});

test('concurrent item worktree creation in one repository is serialized and every worktree is created', async () => {
  const f = await fixture(); const manager = new WorkspaceManager(f.dataDir); const taskId = randomUUID(); const taskBranch = `devagents/items-${taskId.slice(0, 8)}`;
  try {
    const base = await git(f.project, ['rev-parse', 'HEAD']);
    const order: string[] = []; const original = git;
    const created = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(async id => { const w = await manager.createItem(f.store.project('fixture'), taskId, taskBranch, id, base); order.push(id); return w; }));
    void original;
    assert.equal(new Set(created.map(w => w.path)).size, 6); assert.equal(new Set(created.map(w => w.branch)).size, 6);
    const registered = (await git(f.project, ['worktree', 'list', '--porcelain'], false)).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
    for (const w of created) assert.ok(registered.includes(w.path), w.path);
    assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e', 'f'], 'creation completes in request order because it is serialized per repository');
  } finally { await f.cleanup(); }
});
