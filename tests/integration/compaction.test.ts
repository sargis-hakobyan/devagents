import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fixture } from '../helpers.js';
import { WorkspaceManager, git } from '../../src/workspace/git.js';
import { BrowserSessions, SESSION_COOKIE } from '../../src/api/session.js';
import { createApi } from '../../src/api/server.js';
import { workspaceRuntime } from '../../src/engines/node-tools.js';
import { workspaceRuntimePath } from '../../src/workspace/runtime.js';

async function compactFixture() {
  const f = await fixture();
  await writeFile(join(f.project, '.gitignore'), 'node_modules/\n.pnpm-store/\nprivate-output/\n');
  await git(f.project, ['add', '.gitignore']); await git(f.project, ['commit', '-m', 'Ignore generated dependencies']);
  const task = f.service.submit({ projectId: 'fixture', request: 'Preserve unfinished edits', mode: 'autonomous' }, 'compact');
  const workspace = await new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), task.id, task.request);
  f.store.checkpoint(task.id, task.version, { workspace }, 'Fixture workspace');
  f.service.cancel(task.id);
  await mkdir(join(workspace.path, 'node_modules'), { recursive: true });
  await writeFile(join(workspace.path, 'node_modules', 'fixture.txt'), 'dependencies');
  await mkdir(join(workspace.path, '.pnpm-store'), { recursive: true });
  await writeFile(join(workspace.path, '.pnpm-store', 'fixture.txt'), 'cached package');
  return { ...f, task, workspace };
}
const exists = (path: string) => access(path).then(() => true, () => false);

test('compaction removes only the owned tool cache, including after worktree cleanup', async () => {
  const f = await compactFixture();
  try {
    const runtime = await workspaceRuntime(f.dataDir, f.workspace.path);
    await writeFile(join(runtime, 'tool-cache'), 'regenerable');
    const unrelated = await workspaceRuntime(f.dataDir, f.project);
    await writeFile(join(unrelated, 'keep'), 'other workspace');
    const runId = randomUUID(); const scratch = join(f.dataDir, 'runs', runId);
    await mkdir(scratch, { recursive: true }); await writeFile(join(scratch, 'temp'), 'old scratch');
    f.store.record(f.task.id, 'run-started', { runId });
    const otherRun = join(f.dataDir, 'runs', randomUUID());
    await mkdir(otherRun); await writeFile(join(otherRun, 'keep'), 'unrelated run');
    await f.service.cleanup(f.task.id);
    const preview = await f.service.compactionPreview(f.task.id);
    assert.equal(preview.candidates.length, 2);
    assert.equal(preview.candidates[0]!.kind, 'tool-cache');
    assert.equal(preview.candidates[1]!.kind, 'run-scratch');
    await f.service.compact(f.task.id, preview.digest);
    assert.equal(await exists(runtime), false);
    assert.equal(await exists(scratch), false);
    assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'other workspace');
    assert.equal(await readFile(join(otherRun, 'keep'), 'utf8'), 'unrelated run');
    assert.ok(f.store.evidence(f.task.id).some(e => e.kind === 'run-started'));
  } finally { await f.cleanup(); }
});

test('tool-cache aliases are refused before dependency removal', async () => {
  const f = await compactFixture();
  try {
    const runtime = workspaceRuntimePath(f.dataDir, f.workspace.path);
    await mkdir(join(f.dataDir, 'workspace-runtimes'), { recursive: true });
    await symlink(f.project, runtime);
    await assert.rejects(f.service.compactionPreview(f.task.id), /alias or mount/);
    assert.equal(await exists(join(f.workspace.path, 'node_modules')), true);
    assert.equal(await exists(join(f.project, 'README.md')), true);
  } finally { await f.cleanup(); }
});

test('compaction keeps staged/working edits, untracked and unknown ignored content, branches and history', async () => {
  const f = await compactFixture();
  try {
    await writeFile(join(f.workspace.path, 'README.md'), 'staged B'); await git(f.workspace.path, ['add', 'README.md']);
    await writeFile(join(f.workspace.path, 'README.md'), '# Fixture\n');
    await writeFile(join(f.workspace.path, 'unfinished.txt'), 'untracked work');
    await mkdir(join(f.workspace.path, 'private-output')); await writeFile(join(f.workspace.path, 'private-output', 'notes.txt'), 'unknown ignored work');
    const index = await git(f.workspace.path, ['ls-files', '--stage']); const head = await git(f.workspace.path, ['rev-parse', 'HEAD']);
    const preview = await f.service.compactionPreview(f.task.id);
    assert.deepEqual(preview.candidates.map(c => c.path).sort(), ['.pnpm-store', 'node_modules']);
    const result = await f.service.compact(f.task.id, preview.digest);
    assert.equal(result.removed.length, 2);
    assert.equal(await exists(join(f.workspace.path, 'node_modules')), false);
    assert.equal(await exists(f.workspace.path), true);
    assert.equal(await git(f.workspace.path, ['ls-files', '--stage']), index);
    assert.equal(await git(f.workspace.path, ['rev-parse', 'HEAD']), head);
    assert.equal(await git(f.project, ['rev-parse', f.workspace.branch]), head);
    assert.equal(await readFile(join(f.workspace.path, 'README.md'), 'utf8'), '# Fixture\n');
    assert.equal(await readFile(join(f.workspace.path, 'unfinished.txt'), 'utf8'), 'untracked work');
    assert.equal(await readFile(join(f.workspace.path, 'private-output', 'notes.txt'), 'utf8'), 'unknown ignored work');
    assert.equal(f.store.task(f.task.id).state, 'cancelled');
    assert.deepEqual(f.store.evidence(f.task.id).filter(e => e.kind.startsWith('compaction')).map(e => e.kind), ['compaction-intent', 'compaction']);
    await assert.rejects(f.service.compact(f.task.id, preview.digest), /changed/);
  } finally { await f.cleanup(); }
});

test('same-size candidate edits invalidate previews; a failing intent write removes nothing', async () => {
  const f = await compactFixture();
  try {
    const preview = await f.service.compactionPreview(f.task.id);
    await writeFile(join(f.workspace.path, 'node_modules', 'fixture.txt'), 'DEPENDENCIES');
    await assert.rejects(f.service.compact(f.task.id, preview.digest), /changed/);
    const next = await f.service.compactionPreview(f.task.id); const record = f.store.record.bind(f.store);
    f.store.record = (id, kind, value) => { if (kind === 'compaction-intent') throw new Error('SQLITE_FULL'); record(id, kind, value); };
    await assert.rejects(f.service.compact(f.task.id, next.digest), /SQLITE_FULL/);
    assert.equal(await exists(join(f.workspace.path, 'node_modules')), true);
    assert.equal(await exists(join(f.workspace.path, '.pnpm-store')), true);
  } finally { await f.cleanup(); }
});

test('compaction refuses nonterminal or draining tasks and shares its maintenance lease with lifecycle actions', async () => {
  const f = await compactFixture();
  try {
    const active = f.service.submit({ projectId: 'fixture', request: 'Active', mode: 'autonomous' }, 'active');
    await assert.rejects(f.service.compactionPreview(active.id), /completed, failed or cancelled/);
    f.service.attachRunner({ enqueue() {}, cancel() {}, isDrained: () => false });
    await assert.rejects(f.service.compactionPreview(f.task.id), /draining/);
    await assert.rejects(f.service.cleanup(f.task.id), /draining/);
    f.service.attachRunner({ enqueue() {}, cancel() {}, isDrained: () => true });
    const pending = f.service.compactionPreview(f.task.id);
    assert.throws(() => f.service.run(f.task.id), /maintenance/);
    assert.throws(() => f.service.cancel(f.task.id), /maintenance/);
    await assert.rejects(f.service.compactionPreview(f.task.id), /maintenance/);
    await pending;
  } finally { await f.cleanup(); }
});

test('tracked dependency files and external root aliases are preserved; forged ownership refuses', async () => {
  const f = await compactFixture();
  try {
    await git(f.workspace.path, ['add', '-f', 'node_modules/fixture.txt']);
    await mkdir(join(f.workspace.path, 'packages', 'a'), { recursive: true });
    await symlink(f.project, join(f.workspace.path, 'packages', 'a', 'node_modules'));
    const preview = await f.service.compactionPreview(f.task.id);
    assert.ok(!preview.candidates.some(c => c.path.includes('node_modules')));
    await f.service.compact(f.task.id, preview.digest);
    assert.equal(await readFile(join(f.workspace.path, 'node_modules', 'fixture.txt'), 'utf8'), 'dependencies');
    assert.equal(await exists(join(f.workspace.path, 'packages', 'a', 'node_modules', 'README.md')), true);
    f.store.record(f.task.id, 'work-item', { workspace: { path: f.project, branch: f.workspace.branch } });
    await assert.rejects(f.service.compactionPreview(f.task.id), /owned by this task/);
  } finally { await f.cleanup(); }
});

test('compaction API uses existing authentication/origin checks and rejects client-supplied paths', async () => {
  const f = await compactFixture(); const sessions = new BrowserSessions();
  const session = sessions.exchange(sessions.mintCode())!;
  const server = createApi(f.service, 'fixture-token', { sessions });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer fixture-token', 'content-type': 'application/json' };
  try {
    const path = `/tasks/${f.task.id}`;
    assert.equal((await fetch(`${url}${path}/compaction-preview`)).status, 401);
    const browser = { cookie: `${SESSION_COOKIE}=${session.id}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${url}${path}/compact`, { method: 'POST', headers: browser, body: '{}' })).status, 403, 'compaction requires CSRF');
    assert.equal((await fetch(`${url}${path}/compact`, { method: 'POST', headers: { ...browser, 'x-csrf-token': session.csrfToken, origin: 'https://foreign.invalid' }, body: '{}' })).status, 403);
    const preview = await (await fetch(`${url}${path}/compaction-preview`, { headers })).json() as { digest: string };
    assert.equal((await fetch(`${url}${path}/compact`, { method: 'POST', headers: { ...headers, origin: 'https://foreign.invalid' }, body: JSON.stringify({ digest: preview.digest }) })).status, 403);
    assert.equal((await fetch(`${url}${path}/compact`, { method: 'POST', headers, body: JSON.stringify({ digest: preview.digest, path: f.project }) })).status, 400);
    assert.equal((await fetch(`${url}${path}/compact`, { method: 'POST', headers, body: JSON.stringify({ digest: preview.digest }) })).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
