import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.js';
import { git, WorkspaceManager } from '../../src/workspace/git.js';
import { readTaskDiff, diffLimits } from '../../src/workspace/diff.js';
import type { Task } from '../../src/domain/schemas.js';

async function completed(files: Record<string, string | Buffer>) {
  const f = await fixture();
  const task = f.service.submit({ projectId: 'fixture', request: 'Read diff', mode: 'autonomous' }, 'diff');
  const workspace = await new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), task.id);
  for (const [name, text] of Object.entries(files)) await writeFile(join(workspace.path, name), text);
  await git(workspace.path, ['add', '.']);
  await git(workspace.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Diff fixture']);
  const final = await git(workspace.path, ['rev-parse', 'HEAD']);
  const done: Task = { ...task, workspace, state: 'completed', outcome: { commit: final, repairCycles: 0 } };
  return { f, done, read: (t = done) => readTaskDiff(f.store.project('fixture'), t, f.dataDir, ['fixture-secret-value']) };
}

test('diff reads owned commit objects, redacts values, suppresses binary/protected content and never runs helpers', async () => {
  const x = await completed({ 'change.txt': '<script>alert(1)</script> fixture-secret-value\ntoken: string\n', 'image.bin': Buffer.from([0, 1, 2]), '.env': 'private-content', '.gitattributes': '*.txt diff=evil\n' });
  try {
    const marker = join(x.f.root, 'helper-ran');
    await git(x.done.workspace!.path, ['config', 'diff.external', `touch ${marker}`]);
    await git(x.done.workspace!.path, ['config', 'diff.evil.textconv', `touch ${marker}`]);
    const diff = await x.read();
    const text = diff.files.find(f => f.path === 'change.txt')!;
    assert.match(text.text, /<script>/); assert.match(text.text, /token: string/); assert.match(text.text, /\[REDACTED\]/); assert.equal(text.redacted, true);
    assert.doesNotMatch(JSON.stringify(diff), /fixture-secret-value|private-content/);
    assert.equal(diff.files.find(f => f.path === 'image.bin')!.state, 'binary');
    assert.equal(diff.files.find(f => f.path === '.env')!.state, 'withheld');
    assert.equal(await access(marker).then(() => true, () => false), false);
    await new WorkspaceManager(x.f.dataDir).cleanup(x.f.store.project('fixture'), x.done.id, [x.done.workspace!], new Set([x.done.workspace!.branch]));
    assert.deepEqual(await x.read(), diff, 'retained branch remains readable after worktree cleanup');
    assert.equal(await git(x.f.project, ['rev-parse', 'HEAD']), x.done.workspace!.baseSha);
  } finally { await x.f.cleanup(); }
});

test('diff rejects forged ownership, unrelated or missing commits and live tasks; empty requires both commits', async () => {
  const x = await completed({});
  try {
    assert.equal((await x.read()).state, 'empty');
    for (const t of [
      { ...x.done, state: 'running' as const },
      { ...x.done, outcome: { commit: 'f'.repeat(40), repairCycles: 0 } },
      { ...x.done, workspace: { ...x.done.workspace!, branch: 'main' } },
      { ...x.done, workspace: { ...x.done.workspace!, path: x.f.project } },
      { ...x.done, workspace: { ...x.done.workspace!, baseSha: 'f'.repeat(40) } },
    ]) await assert.rejects(x.read(t), { code: 'diff_unavailable' });
    await git(x.f.project, ['update-ref', `refs/heads/${x.done.workspace!.branch}`, x.done.workspace!.baseSha]);
    await assert.rejects(x.read(), { code: 'diff_unavailable' });
  } finally { await x.f.cleanup(); }
});

test('diff caps text and file counts and omits over-read-cap text without exposing a cut secret', async () => {
  const x = await completed(Object.fromEntries([
    ['huge.txt', 'fixture-secret-value'.repeat(80000)],
    ...Array.from({ length: 6 }, (_, i) => [`file-${i}.txt`, 'text fixture-secret-value\n'.repeat(6000)]),
  ]));
  try {
    const diff = await x.read(); assert.equal(diff.state, 'truncated');
    assert.ok(diff.files.every(f => f.shownBytes <= diffLimits.perFileBytes));
    assert.ok(diff.files.reduce((sum, f) => sum + f.shownBytes, 0) <= diffLimits.totalBytes);
    assert.doesNotMatch(JSON.stringify(diff), /fixture-secret-value/);
    assert.equal(diff.files.find(f => f.path === 'huge.txt')!.text, '');
  } finally { await x.f.cleanup(); }
  const many = await completed(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`file-${i}`, 'x'])));
  try { await assert.rejects(many.read(), /exceeds 200 files/); } finally { await many.f.cleanup(); }
});

test('configured provider secrets outside the environment-name heuristic are redacted in diffs and responses (review F1)', async () => {
  const { createApi } = await import('../../src/api/server.js');
  const { Store } = await import('../../src/persistence/store.js');
  const { TaskService } = await import('../../src/orchestration/service.js');
  const { Config } = await import('../../src/domain/schemas.js');
  const f = await fixture();
  const value = 'provider-value-9f8e7d6c5b4a';
  // MYPROV_AUTH does not match the environment heuristic; the service adds its value to the store's secret list at startup.
  const store = new Store(join(f.dataDir, 'f1.db'), [value]);
  const service = new TaskService(store, Config.parse({ schemaVersion: 1, providers: [{ id: 'openai', kind: 'openai', auth: 'login' }, { id: 'custom', kind: 'anthropic', auth: 'api-key', apiKeyEnv: 'MYPROV_AUTH' }] }), f.dataDir);
  const server = createApi(service, 't');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await service.registerProject({ id: 'fixture', path: f.project });
    const task = service.submit({ projectId: 'fixture', request: 'leak', mode: 'autonomous' }, 'leak');
    const workspace = await new WorkspaceManager(f.dataDir).create(store.project('fixture'), task.id);
    await writeFile(join(workspace.path, 'leak.txt'), `const k = "${value}";\n`);
    await git(workspace.path, ['add', '.']); await git(workspace.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'leak']);
    const final = await git(workspace.path, ['rev-parse', 'HEAD']);
    let t = store.checkpoint(task.id, store.task(task.id).version, { workspace }, 'worktree');
    for (const state of ['ready', 'running', 'validating', 'reviewing', 'committing'] as const) t = store.transition(task.id, t.version, state, 'test', 'fixture');
    store.transition(task.id, t.version, 'completed', 'test', 'done', { outcome: { commit: final, repairCycles: 0 } });
    const diff = await service.diff(task.id);
    assert.doesNotMatch(JSON.stringify(diff), /provider-value-9f8e7d6c5b4a/);
    assert.match(diff.files[0]!.text, /\[REDACTED\]/); assert.equal(diff.files[0]!.redacted, true);
    const { port } = server.address() as import('node:net').AddressInfo;
    const body = await (await fetch(`http://127.0.0.1:${port}/tasks/${task.id}/diff`, { headers: { authorization: 'Bearer t' } })).text();
    assert.doesNotMatch(body, /provider-value-9f8e7d6c5b4a/);
    assert.doesNotMatch(JSON.stringify(store.task(task.id)), /provider-value/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await f.cleanup(); }
});
