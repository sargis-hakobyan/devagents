import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createApi } from '../../src/api/server.js';
import { ProjectIntegrationService } from '../../src/integrations/service.js';
import type { SecretStore } from '../../src/security/secret-store.js';
import { folderIdentity } from '../../src/workspace/git.js';
import { fixture } from '../helpers.js';

const TOKEN = `github_pat_${'Archive1'.repeat(6)}`;
async function serve() {
  const f = await fixture(); const values = new Map<string, string>();
  const secrets: SecretStore = { mode: 'vault', variable: name => name, locked: async () => false, get: async name => values.get(name), set: async (name, value) => { values.set(name, value); }, remove: async name => { values.delete(name); } };
  execFileSync('git', ['-C', f.project, 'remote', 'add', 'origin', 'https://github.com/example-org/website.git']);
  const github = (async (input: string | URL | Request) => new Response(JSON.stringify(String(input).endsWith('/user') ? { login: 'fixture-user' } : { permissions: { push: true } }), { status: 200 })) as typeof fetch;
  const integrations = new ProjectIntegrationService(f.store, secrets, { fetch: github, githubApiUrl: 'https://api.github.test' });
  const server = createApi(f.service, 'test-token', { integrations });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown, key?: string) => {
    const response = await fetch(`${root}${path}`, { method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  const ids = async (filter?: string) => ((await call(`/projects${filter ? `?filter=${filter}` : ''}`)).data as { id: string }[]).map(p => p.id);
  return { f, values, call, ids, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); } };
}

test('a project is archived with its history kept, its folder is registered again under a new ID, and restore waits for the folder', async () => {
  const s = await serve();
  try {
    // Open work blocks archiving; nothing is cancelled on the user's behalf.
    const task = (await s.call('/tasks', 'POST', { projectId: 'fixture', request: 'Write a greeting' }, 'archive-1')).data;
    assert.equal(task.state, 'awaiting_mode');
    assert.equal((await s.call('/projects/fixture/integrations/github', 'PUT', { token: TOKEN })).status, 200);
    const blocked = await s.call('/projects/fixture/archive', 'POST', { archived: true, expectedVersion: 0 });
    assert.equal(blocked.status, 409); assert.equal(blocked.data.error, 'project_active'); assert.match(blocked.data.message, /1 open task /);
    assert.equal((await s.call(`/tasks/${task.id}/cancel`, 'POST', {})).status, 200);
    assert.equal((await s.call('/projects/fixture/archive', 'POST', { archived: true, expectedVersion: 7 })).data.error, 'stale_project');

    const archived = await s.call('/projects/fixture/archive', 'POST', { archived: true, expectedVersion: 0 });
    assert.equal(archived.status, 200); assert.ok(archived.data.archivedAt); assert.equal(archived.data.version, 1);
    assert.equal(archived.data.integrations, undefined, 'connections are removed'); assert.equal(s.values.size, 0, 'and its token with them');
    assert.equal(archived.data.path, await realpath(s.f.project), 'the record still says where the project lived');
    assert.deepEqual(await s.ids(), []); assert.deepEqual(await s.ids('archived'), ['fixture']); assert.deepEqual(await s.ids('all'), ['fixture']);
    assert.equal((await s.call('/projects?filter=nonsense')).status, 400);
    assert.deepEqual((await s.call('/submission-options')).data.projects, []);

    // History stays readable; new work and new connections are refused.
    const kept = (await s.call(`/tasks/${task.id}`)).data;
    assert.equal(kept.state, 'cancelled'); assert.equal(kept.projectArchived, true, 'the task says its project is archived');
    assert.equal((await s.call('/tasks')).data.tasks.length, 1);
    assert.equal((await s.call(`/tasks/${task.id}/events`)).status, 200);
    assert.equal((await s.call('/tasks', 'POST', { projectId: 'fixture', request: 'More work' }, 'archive-2')).data.error, 'project_archived');
    assert.equal((await s.call('/projects/fixture/integrations/github', 'PUT', { token: TOKEN })).data.error, 'project_archived');

    // The same folder as a new project with a new configuration. A caller cannot pick a readable ID.
    assert.equal((await s.call('/projects', 'POST', { id: 'renamed', path: s.f.project })).data.error, 'invalid_project_id');
    const renamed = await s.call('/projects', 'POST', { name: 'Renamed', path: s.f.project, defaultMode: 'plan-approval' });
    assert.equal(renamed.status, 201); assert.equal(renamed.data.defaultMode, 'plan-approval'); assert.match(renamed.data.id, /^[0-9a-f-]{36}$/);
    const next = renamed.data.id as string;
    assert.deepEqual(await s.ids(), [next]);
    assert.equal((await s.call('/tasks', 'POST', { projectId: next, request: 'Work under the new name' }, 'archive-3')).status, 201);

    // One folder, one active project: restore is refused until the folder is free, then swaps back.
    const refused = await s.call('/projects/fixture/archive', 'POST', { archived: false, expectedVersion: 1 });
    assert.equal(refused.status, 409); assert.equal(refused.data.error, 'project_conflict'); assert.match(refused.data.message, /Project "Renamed" uses this folder/);
    const open = (await s.call('/tasks')).data.tasks.find((t: { projectId: string }) => t.projectId === next);
    await s.call(`/tasks/${open.id}/cancel`, 'POST', {});
    assert.equal((await s.call(`/projects/${next}/archive`, 'POST', { archived: true, expectedVersion: 0 })).status, 200);
    const restored = await s.call('/projects/fixture/archive', 'POST', { archived: false, expectedVersion: 1 });
    assert.equal(restored.status, 200); assert.equal(restored.data.archivedAt, undefined); assert.equal(restored.data.version, 2);
    assert.deepEqual(await s.ids(), ['fixture']); assert.deepEqual(await s.ids('archived'), [next]);
    assert.equal((await s.call('/tasks', 'POST', { projectId: 'fixture', request: 'Back in use' }, 'archive-4')).status, 201);
    assert.equal((await s.call('/projects/fixture/archive', 'POST', { archived: false, expectedVersion: 2 })).data.version, 2, 'restoring an active project changes nothing');
    assert.equal((await s.call('/projects/unknown/archive', 'POST', { archived: true, expectedVersion: 0 })).status, 404);
  } finally { await s.close(); }
});

test('a folder that has gone cannot be restored, and one directory has one identity however it is reached', async () => {
  const s = await serve();
  try {
    const elsewhere = join(s.f.root, 'elsewhere'); await mkdir(elsewhere);
    assert.equal(await folderIdentity(s.f.project), await folderIdentity(join(s.f.project, '..', 'project')));
    assert.notEqual(await folderIdentity(s.f.project), await folderIdentity(elsewhere));
    assert.equal(await folderIdentity(join(s.f.root, 'missing')), undefined);
    assert.equal(await folderIdentity(join(s.f.project, 'README.md')), undefined, 'a file is not a project folder');
    assert.equal((await s.call('/projects/fixture/archive', 'POST', { archived: true, expectedVersion: 0 })).status, 200);
    execFileSync('mv', [s.f.project, join(s.f.root, 'moved')]);
    const gone = await s.call('/projects/fixture/archive', 'POST', { archived: false, expectedVersion: 1 });
    assert.equal(gone.status, 409); assert.equal(gone.data.error, 'invalid_path');
  } finally { await s.close(); }
});
