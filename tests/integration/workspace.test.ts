import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceManager, git, inspectProject } from '../../src/workspace/git.js';
import { scopedPath } from '../../src/workspace/paths.js';
import { fixture } from '../helpers.js';

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
