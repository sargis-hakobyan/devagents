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
