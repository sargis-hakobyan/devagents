import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceManager, git, inspectProject } from '../../src/workspace/git.js';
import { scopedPath } from '../../src/workspace/paths.js';
import { changes, commitChanges } from '../../src/workspace/changes.js';
import { fixture } from '../helpers.js';

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
    const workspace = await new WorkspaceManager(f.dataDir).create(project, randomUUID());
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
    const a = await manager.create(f.store.project('fixture'), randomUUID());
    const b = await manager.create(f.store.project('fixture'), randomUUID());
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
    await assert.rejects(new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), randomUUID()), /filters requires sandbox/);
  } finally { await f.cleanup(); }
});

test('oversized Git output is reported as an actionable error rather than a raw buffer failure', async () => {
  const f = await fixture();
  try { await assert.rejects(git(f.project, ['log'], true, 16), /git log output exceeded 16 bytes/); } finally { await f.cleanup(); }
});

test('concurrent item worktree creation in one repository is serialized and every worktree is created', async () => {
  const f = await fixture(); const manager = new WorkspaceManager(f.dataDir); const taskId = randomUUID();
  try {
    const base = await git(f.project, ['rev-parse', 'HEAD']);
    const order: string[] = []; const original = git;
    const created = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(async id => { const w = await manager.createItem(f.store.project('fixture'), taskId, id, base); order.push(id); return w; }));
    void original;
    assert.equal(new Set(created.map(w => w.path)).size, 6); assert.equal(new Set(created.map(w => w.branch)).size, 6);
    const registered = (await git(f.project, ['worktree', 'list', '--porcelain'], false)).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
    for (const w of created) assert.ok(registered.includes(w.path), w.path);
    assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e', 'f'], 'creation completes in request order because it is serialized per repository');
  } finally { await f.cleanup(); }
});
