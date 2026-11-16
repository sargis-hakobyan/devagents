import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createApi } from '../../src/api/server.js';
import { fixture, validPlan } from '../helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
async function serve() {
  const f = await fixture(); const server = createApi(f.service, 'test-token');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown, key?: string) => {
    const response = await fetch(`${root}${path}`, { method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  const repo = (name: string) => {
    const path = join(f.root, name); execFileSync('git', ['clone', '-q', f.project, path]);
    return path;
  };
  return { f, call, repo, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); } };
}

test('a project is registered by name with a generated UUID, and the name can be changed without touching anything else', async () => {
  const s = await serve();
  try {
    assert.equal((await s.call('/projects', 'POST', { path: s.repo('nameless') })).status, 400, 'a project needs a name');
    assert.equal((await s.call('/projects', 'POST', { name: '   ', path: s.repo('blank') })).status, 400);
    assert.equal((await s.call('/projects', 'POST', { name: 'Line\nbreak', path: s.repo('broken') })).status, 400);
    const created = await s.call('/projects', 'POST', { name: '  Billing Service  ', path: s.repo('billing') });
    assert.equal(created.status, 201); assert.match(created.data.id, UUID); assert.equal(created.data.name, 'Billing Service');
    const id = created.data.id as string;

    // Projects registered before names existed, or with an explicit ID, read with the ID as their name.
    const legacy = (await s.call('/projects')).data.find((p: { id: string }) => p.id === 'fixture');
    assert.equal(legacy.name, 'fixture');

    // The UUID works everywhere a project is addressed: tasks, plans, routes.
    const task = (await s.call('/tasks', 'POST', { projectId: id, request: 'Work on billing', mode: 'plan-approval' }, 'names-1')).data;
    assert.equal(task.projectId, id); assert.equal(task.projectName, 'Billing Service');
    const plan = validPlan(); plan.items[0]!.projectId = id;
    assert.equal((await s.call(`/tasks/${task.id}/plan`, 'POST', plan)).status, 200, 'a plan can name a UUID project');
    assert.equal((await s.call(`/tasks?projectId=${id}`)).data.tasks.length, 1);
    assert.equal((await s.call(`/projects/${id}/default-team`, 'PUT', { teamId: null, expectedVersion: created.data.version ?? 0 })).status, 200);

    // Names are unique among active projects, whatever the case; the ID is never part of that.
    assert.equal((await s.call('/projects', 'POST', { name: 'billing service', path: s.repo('duplicate') })).data.error, 'project_conflict');
    assert.equal((await s.call('/projects/prepare', 'POST', { name: 'BILLING SERVICE' })).data.error, 'project_conflict');
    const prepared = await s.call('/projects/prepare', 'POST', { name: 'Another one' });
    assert.match(prepared.data.id, UUID); assert.equal(prepared.data.name, 'Another one');
    assert.equal((await s.call('/projects')).data.length, 2, 'preparing reserves nothing');

    const current = (await s.call('/projects')).data.find((p: { id: string }) => p.id === id);
    assert.equal((await s.call(`/projects/${id}/name`, 'PUT', { name: 'fixture', expectedVersion: current.version })).data.error, 'project_conflict');
    assert.equal((await s.call(`/projects/${id}/name`, 'PUT', { name: 'Billing', expectedVersion: current.version + 5 })).data.error, 'stale_project');
    assert.equal((await s.call(`/projects/${id}/name`, 'PUT', { name: '', expectedVersion: current.version })).status, 400);
    const renamed = await s.call(`/projects/${id}/name`, 'PUT', { name: 'Billing', expectedVersion: current.version });
    assert.equal(renamed.status, 200); assert.equal(renamed.data.name, 'Billing'); assert.equal(renamed.data.id, id); assert.equal(renamed.data.path, current.path);
    assert.equal(renamed.data.version, current.version + 1);

    // Tasks show the current name; nothing about them was rewritten.
    const after = (await s.call(`/tasks/${task.id}`)).data;
    assert.equal(after.projectId, id); assert.equal(after.projectName, 'Billing');
    assert.equal((await s.call('/tasks')).data.tasks[0].projectName, 'Billing');
    assert.equal(JSON.stringify((await s.call('/overview')).data).includes('"projectName":"Billing"'), true);
    // The old name is free again, and a legacy project can be renamed too.
    assert.equal((await s.call('/projects', 'POST', { name: 'Billing Service', path: s.repo('reuse') })).status, 201);
    assert.equal((await s.call('/projects/fixture/name', 'PUT', { name: 'Website', expectedVersion: legacy.version })).data.name, 'Website');
  } finally { await s.close(); }
});

test('the launcher reports where a project lives on the computer, without counting as an edit', async () => {
  const s = await serve();
  try {
    const project = (await s.call('/projects')).data[0];
    const reported = await s.call('/projects/host-folders', 'PUT', { folders: { [project.path]: '/Users/someone/work/monorepo', '/projects/unknown': '/Users/someone/other' } });
    assert.deepEqual(reported.data, { updated: 1 });
    const after = (await s.call('/projects')).data[0];
    assert.equal(after.hostPath, '/Users/someone/work/monorepo'); assert.equal(after.path, project.path); assert.equal(after.version, project.version, 'reporting a folder is not an edit');
    assert.deepEqual((await s.call('/projects/host-folders', 'PUT', { folders: { [project.path]: '/Users/someone/work/monorepo' } })).data, { updated: 0 });
    assert.equal((await s.call('/projects/host-folders', 'PUT', { folders: { [project.path]: '' } })).status, 400);
    assert.equal((await s.call('/projects/host-folders', 'PUT', { paths: {} })).status, 400);
  } finally { await s.close(); }
});

test('an archived project keeps its name until restore, where a taken name asks for a rename first', async () => {
  const s = await serve();
  try {
    const first = (await s.call('/projects', 'POST', { name: 'Shop', path: s.repo('shop-one') })).data;
    assert.equal((await s.call(`/projects/${first.id}/archive`, 'POST', { archived: true, expectedVersion: first.version ?? 0 })).status, 200);
    const second = await s.call('/projects', 'POST', { name: 'Shop', path: s.repo('shop-two') });
    assert.equal(second.status, 201, 'an archived project does not hold its name');
    const archived = (await s.call('/projects?filter=archived')).data[0];
    const refused = await s.call(`/projects/${first.id}/archive`, 'POST', { archived: false, expectedVersion: archived.version });
    assert.equal(refused.status, 409); assert.match(refused.data.message, /already named "Shop"\. Rename one of them first/);
    const renamed = await s.call(`/projects/${first.id}/name`, 'PUT', { name: 'Shop (old)', expectedVersion: archived.version });
    assert.equal(renamed.status, 200, 'an archived project can be renamed');
    assert.equal((await s.call(`/projects/${first.id}/archive`, 'POST', { archived: false, expectedVersion: renamed.data.version })).status, 200);
  } finally { await s.close(); }
});

test('opening an older database turns hand-written project IDs into UUIDs and keeps them as names', async () => {
  const { DatabaseSync } = await import('node:sqlite'); const { Store } = await import('../../src/persistence/store.js');
  const f = await fixture(); const path = join(f.dataDir, 'test.db');
  try {
    // The fixture registers the readable ID "fixture" in process, as earlier versions did for everyone.
    const task = f.service.submit({ projectId: 'fixture', request: 'Planned before the upgrade', mode: 'plan-approval' }, 'upgrade-1');
    await f.service.proposePlan(task.id, validPlan());
    f.store.close();
    const raw = new DatabaseSync(path); raw.exec('PRAGMA user_version=6'); raw.close();

    const upgraded = new Store(path, []);
    try {
      const [project] = upgraded.projects();
      assert.match(project!.id, UUID); assert.equal(project!.name, 'fixture', 'the old ID is now the name');
      const moved = upgraded.task(task.id);
      assert.equal(moved.projectId, project!.id); assert.equal(moved.plan!.items[0]!.projectId, project!.id, 'the stored plan follows its project');
      assert.equal(upgraded.summaries({ projectId: project!.id }).tasks.length, 1);
      assert.equal(upgraded.events(task.id, 0, 10).length > 0, true, 'history is untouched');
    } finally { upgraded.close(); }
    // A second open changes nothing.
    const again = new Store(path, []); const id = again.projects()[0]!.id; again.close();
    const third = new Store(path, []); assert.equal(third.projects()[0]!.id, id); third.close();
  } finally { await (async () => { const { rm } = await import('node:fs/promises'); await rm(f.root, { recursive: true, force: true }); })(); }
});
