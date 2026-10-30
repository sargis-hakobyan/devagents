import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from '../../src/api/server.js';
import { fixture, validPlan } from '../helpers.js';
import type { TaskSummary } from '../../src/domain/schemas.js';

test('task lists page by cursor with filters, event and evidence polling use sequence cursors, and evidence is bounded', async () => {
  const f = await fixture(); const server = createApi(f.service, 't');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const headers = { authorization: 'Bearer t' };
  const get = async <T>(path: string) => { const r = await fetch(`${url}${path}`, { headers }); assert.equal(r.status, 200, path); return await r.json() as T; };
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(f.service.submit({ projectId: 'fixture', request: `Task ${i} <script>alert(1)</script>`, mode: 'autonomous' }, `page-${i}`).id);
    const ready = await f.service.proposePlan(ids[0]!, validPlan()); f.store.transition(ids[0]!, ready.version, 'running', 'test', 'started');
    f.service.cancel(ids[1]!);
    const first = await get<{ tasks: TaskSummary[]; nextBefore?: number }>('/tasks?limit=2');
    assert.equal(first.tasks.length, 2); assert.ok(first.nextBefore); assert.equal(first.tasks[0]!.id, ids[4]); assert.equal(first.tasks[0]!.request, 'Task 4 <script>alert(1)</script>');
    const second = await get<{ tasks: TaskSummary[]; nextBefore?: number }>(`/tasks?limit=2&before=${first.nextBefore}`);
    assert.deepEqual(second.tasks.map(t => t.id), [ids[2], ids[1]]);
    const last = await get<{ tasks: TaskSummary[]; nextBefore?: number }>(`/tasks?limit=2&before=${second.nextBefore}`);
    assert.deepEqual(last.tasks.map(t => t.id), [ids[0]]); assert.equal(last.nextBefore, undefined);
    assert.deepEqual((await get<{ tasks: TaskSummary[] }>('/tasks?state=running')).tasks.map(t => t.id), [ids[0]]);
    assert.deepEqual((await get<{ tasks: TaskSummary[] }>('/tasks?state=cancelled')).tasks.map(t => t.id), [ids[1]]);
    assert.equal((await get<{ tasks: TaskSummary[] }>('/tasks?projectId=fixture')).tasks.length, 5);
    assert.equal((await fetch(`${url}/tasks?state=bogus`, { headers })).status, 400);
    assert.equal((await fetch(`${url}/tasks?projectId=../x`, { headers })).status, 400);
    const overview = await get<{ counts: Record<string, number>; attention: TaskSummary[]; active: { id: string; workItems: unknown[] }[]; recent: TaskSummary[] }>('/overview');
    assert.deepEqual(overview.counts, { planning: 3, running: 1, cancelled: 1 });
    // Active covers planning and ready as well as execution states; only the running task has a stored plan and therefore items.
    assert.deepEqual(overview.active.map(t => t.id), [ids[4], ids[3], ids[2], ids[0]]);
    assert.equal(overview.active.find(t => t.id === ids[0])!.workItems.length, 1); assert.equal(overview.active.find(t => t.id === ids[4])!.workItems.length, 0);
    assert.deepEqual(overview.recent.map(t => t.id), [ids[1]]); assert.equal(overview.attention.length, 0);
    // Events: cursor polling returns only newer rows and the full list has no duplicates.
    const events = await get<{ sequence: number }[]>(`/tasks/${ids[0]}/events`); assert.equal(events.length, 3);
    const newer = await get<{ sequence: number }[]>(`/tasks/${ids[0]}/events?after=${events[1]!.sequence}`); assert.deepEqual(newer.map(e => e.sequence), [events[2]!.sequence]);
    assert.deepEqual(await get(`/tasks/${ids[0]}/events?after=${events[2]!.sequence}`), []);
    // Evidence: large entries are previewed in lists and complete when fetched alone.
    f.store.record(ids[0]!, 'validation', { output: 'x'.repeat(40000), exitCode: 0 }); f.store.record(ids[0]!, 'work-item', { itemId: 'greeting', state: 'running' });
    const evidence = await get<{ sequence: number; kind: string; truncated?: boolean; data: { preview?: string; bytes?: number; output?: string } }[]>(`/tasks/${ids[0]}/evidence`);
    assert.equal(evidence.length, 2); assert.equal(evidence[0]!.truncated, true); assert.equal(evidence[0]!.data.bytes! > 40000, true); assert.equal(Buffer.byteLength(evidence[0]!.data.preview!), 16 * 1024);
    assert.equal(evidence[1]!.truncated, undefined);
    const full = await get<{ truncated?: boolean; data: { output: string } }>(`/tasks/${ids[0]}/evidence/${evidence[0]!.sequence}`);
    assert.equal(full.truncated, undefined); assert.equal(full.data.output.length, 40000);
    assert.deepEqual((await get<{ sequence: number }[]>(`/tasks/${ids[0]}/evidence?after=${evidence[0]!.sequence}`)).map(e => e.sequence), [evidence[1]!.sequence]);
    assert.equal((await fetch(`${url}/tasks/${ids[0]}/evidence/999999`, { headers })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('overview categories and grouped task filters include older work before pagination', async () => {
  const f = await fixture(); const server = createApi(f.service, 't');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const running = f.service.submit({ projectId: 'fixture', request: 'Old running task', mode: 'autonomous' }, 'old-running');
    const ready = await f.service.proposePlan(running.id, validPlan()); f.store.transition(running.id, ready.version, 'running', 'test', 'started');
    const waiting = f.service.submit({ projectId: 'fixture', request: 'Old approval', mode: 'plan-approval' }, 'old-approval');
    await f.service.proposePlan(waiting.id, validPlan());
    for (let i = 0; i < 51; i++) f.service.submit({ projectId: 'fixture', request: `Mode ${i}` }, `mode-${i}`);
    for (let i = 0; i < 201; i++) {
      const t = f.service.submit({ projectId: 'fixture', request: `Newer ${i}` }, `newer-${i}`); f.service.cancel(t.id);
    }
    // A large queue must not displace the executing task either.
    for (let i = 0; i < 201; i++) f.service.submit({ projectId: 'fixture', request: `Queued ${i}`, mode: 'autonomous' }, `queued-${i}`);
    const overview = f.store.overview();
    assert.equal(overview.counts.running, 1); assert.equal(overview.counts.awaiting_plan_approval, 1);
    assert.ok(overview.active.some(t => t.id === running.id)); assert.equal(overview.active.length, 51);
    assert.equal(overview.attention.length, 50); assert.equal(overview.recent.length, 8);
    const get = async (path: string) => { const r = await fetch(url + path, { headers: { authorization: 'Bearer t' } }); assert.equal(r.status, 200); return await r.json() as { tasks: TaskSummary[]; nextBefore?: number; counts: Record<string, number> }; };
    const query = '/tasks?state=awaiting_mode&state=awaiting_plan_approval&projectId=fixture&limit=50';
    const first = await get(query); assert.equal(first.tasks.length, 50); assert.ok(first.nextBefore);
    assert.equal(first.counts.awaiting_mode, 51); assert.equal(first.counts.cancelled, 201);
    const last = await get(`${query}&before=${first.nextBefore}`);
    assert.equal(last.tasks.length, 2); assert.equal(last.nextBefore, undefined); assert.equal(last.tasks[1]!.id, waiting.id);
    assert.equal(new Set([...first.tasks, ...last.tasks].map(t => t.id)).size, 52);
    assert.deepEqual((await get('/tasks?projectId=missing')).counts, {});
    assert.equal((await fetch(`${url}/tasks?state=running&state=bogus`, { headers: { authorization: 'Bearer t' } })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('task approval is derived from durable history even after cancellation and event pagination', async () => {
  const f = await fixture(); const server = createApi(f.service, 't');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const approval = async (id: string) => (await (await fetch(`${url}/tasks/${id}`, { headers: { authorization: 'Bearer t' } })).json() as { approval: { status: string; timestamp?: string } }).approval;
    const rejected = f.service.submit({ projectId: 'fixture', request: 'Reject this', mode: 'plan-approval' }, 'reject');
    assert.equal((await approval(rejected.id)).status, 'not-planned');
    await f.service.proposePlan(rejected.id, validPlan()); assert.equal((await approval(rejected.id)).status, 'awaiting');
    f.service.cancel(rejected.id); assert.equal((await approval(rejected.id)).status, 'not-approved');
    const approved = f.service.submit({ projectId: 'fixture', request: 'Approve this', mode: 'plan-approval' }, 'approve');
    const planned = await f.service.proposePlan(approved.id, validPlan()); f.service.approve(approved.id, planned.version);
    // The approval must not depend on the first page of activity or the current terminal state.
    for (let i = 0; i < 501; i++) f.store.checkpoint(approved.id, f.store.task(approved.id).version, {}, 'fixture checkpoint');
    f.service.cancel(approved.id);
    assert.equal((await approval(approved.id)).status, 'approved'); assert.ok((await approval(approved.id)).timestamp);
    const auto = f.service.submit({ projectId: 'fixture', request: 'Autonomous', mode: 'autonomous' }, 'auto');
    await f.service.proposePlan(auto.id, validPlan()); assert.equal((await approval(auto.id)).status, 'autonomous');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

test('large evidence previews preserve bounded validation and review facts independently of text', async () => {
  const f = await fixture(); const server = createApi(f.service, 't');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Noisy evidence' }, 'noisy');
    for (const [exitCode, truncated] of [[0, false], [1, false], [0, true]] as const) f.store.record(task.id, 'validation', { workItemId: 'greeting', executable: 'node', args: ['--test'], exitCode, truncated, output: 'x'.repeat(20000) });
    f.store.record(task.id, 'run-completed', { runId: 'review-run', workItemId: 'greeting', phase: 'review', output: { approved: true, summary: 'Long review', findings: ['must fix '.repeat(4000)] } });
    f.store.record(task.id, 'run-completed', { runId: 'approved-run', workItemId: '@integration', phase: 'review', output: { approved: true, summary: 'passed '.repeat(4000), findings: [] } });
    const response = await fetch(`${url}/tasks/${task.id}/evidence`, { headers: { authorization: 'Bearer t' } });
    const rows = await response.json() as { truncated: boolean; metadata: { workItemId: string; exitCode?: number; truncated?: boolean; output?: { approved: boolean; findingsCount: number } }; data: { preview: string } }[];
    assert.deepEqual(rows.slice(0, 3).map(r => [r.metadata.exitCode, r.metadata.truncated]), [[0, false], [1, false], [0, true]]);
    assert.ok(rows.every(r => r.truncated && Buffer.byteLength(r.data.preview) <= 16384));
    assert.ok(rows.every(r => Buffer.byteLength(JSON.stringify(r.metadata)) < 4096));
    assert.equal(rows[3]!.metadata.output!.findingsCount, 1); assert.equal(rows[4]!.metadata.output!.findingsCount, 0);
    assert.equal(rows[3]!.metadata.workItemId, 'greeting'); assert.equal(rows[4]!.metadata.workItemId, '@integration');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
